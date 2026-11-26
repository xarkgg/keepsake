import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepsake-server-"));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;

let child: ChildProcess | null = null;
let serverOutput = "";

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Server did not start.\n${serverOutput}`);
}

child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    NODE_ENV: "development",
    KEEPSAKE_DATA_DIR: dataDir,
    KEEPSAKE_SIGNUPS: "open",
    PORT: String(port),
    HOST: "127.0.0.1",
    KEEPSAKE_PGLITE_DIR: path.join(dataDir, "pglite"),
    // The destructive routes must refuse changes to this shared account.
    KEEPSAKE_DEMO_ACCOUNTS: "demo@keepsake.test",
    // Pin Firebase off so the server uses its own password login even when the
    // developer has a local .env with a real project id (env vars win over .env).
    FIREBASE_PROJECT_ID: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout?.on("data", (chunk) => {
  serverOutput += String(chunk);
});
child.stderr?.on("data", (chunk) => {
  serverOutput += String(chunk);
});

await waitForServer();

interface Reply {
  status: number;
  body: Record<string, unknown>;
  cookie?: string;
}

async function request(
  pathname: string,
  options: {
    method?: string;
    body?: unknown;
    cookie?: string;
    origin?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Reply> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { ...options.headers };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && method !== "HEAD") headers.origin = options.origin ?? base;
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  const setCookie = response.headers.getSetCookie()[0];
  return {
    status: response.status,
    body,
    cookie: setCookie ? setCookie.split(";")[0] : undefined,
  };
}

async function register(email: string, password: string, name: string): Promise<Reply> {
  return request("/api/auth/register", {
    method: "POST",
    body: { email, password, name },
  });
}

test("health reports a fresh server", async () => {
  const reply = await request("/api/health");
  assert.equal(reply.status, 200);
  assert.equal(reply.body.accounts, 0);
  assert.equal(reply.body.name, "Keepsake");
  // Without a Firebase project there is no cloud identity, no AI Logic and no
  // App Check, the operator sees that plainly rather than guessing.
  const capabilities = reply.body.capabilities as { firebase: boolean; appCheck: boolean };
  assert.equal(capabilities.firebase, false);
  assert.equal(capabilities.appCheck, false);
  const config = await request("/api/auth/config");
  assert.equal(config.body.needsSetup, true);
  assert.equal(config.body.signupsOpen, true);
  // No Firebase project is configured, so the client is told there is no
  // cloud identity or cloud inference to route through.
  assert.equal(config.body.firebase, null);
});

test("API calls require a session", async () => {
  const reply = await request("/api/bootstrap");
  assert.equal(reply.status, 401);
  assert.equal(reply.body.code, "AUTH_REQUIRED");
  const password = await request("/api/auth/password", {
    method: "POST", body: { current: "password-123", next: "password-456" },
  });
  assert.equal(password.status, 401);
});

test("registration creates an isolated account with its own profile", async () => {
  const registered = await register("alpha@example.com", "alpha-passphrase-1", "Alpha");
  assert.equal(registered.status, 201);
  assert.ok(registered.cookie?.startsWith("keepsake_session="));
  const account = registered.body.account as { id: string; email: string };
  assert.equal(account.email, "alpha@example.com");

  const bootstrap = await request("/api/bootstrap", { cookie: registered.cookie });
  assert.equal(bootstrap.status, 200);
  assert.equal((bootstrap.body.account as { email: string }).email, "alpha@example.com");
  // The profile is seeded from the name given at sign-up, so onboarding does not
  // ask for it again. It still counts as not yet onboarded.
  assert.equal((bootstrap.body.profile as { name: string | null }).name, "Alpha");
  assert.equal(bootstrap.body.onboarded, false);
});

test("mutations reject a foreign origin", async () => {
  const login = await register("csrf@example.com", "csrf-passphrase-1", "CSRF");
  const reply = await request("/api/profile", {
    method: "PATCH",
    cookie: login.cookie,
    origin: "https://evil.example",
    headers: { "sec-fetch-site": "cross-site" },
    body: { name: "Should not exist" },
  });
  assert.equal(reply.status, 403);
});

test("each account sees only its own profile", async () => {
  const alpha = await register("one@example.com", "one-passphrase-1", "One");
  await request("/api/profile", {
    method: "PATCH",
    cookie: alpha.cookie,
    body: { name: "Alpha One" },
  });

  const beta = await register("two@example.com", "two-passphrase-1", "Two");
  assert.notEqual(alpha.cookie, beta.cookie);

  const betaBootstrap = await request("/api/bootstrap", { cookie: beta.cookie });
  assert.equal((betaBootstrap.body.account as { email: string }).email, "two@example.com");
  assert.equal((betaBootstrap.body.profile as { name: string | null }).name, "Two");

  const alphaBootstrap = await request("/api/bootstrap", { cookie: alpha.cookie });
  assert.equal((alphaBootstrap.body.profile as { name: string }).name, "Alpha One");
});

test("onboarding accepts a name and keeps a known one on skip", async () => {
  const account = await register("onboard@example.com", "onboard-passphrase-1", "Onboarded");
  const named = await request("/api/onboarding", {
    method: "POST",
    cookie: account.cookie,
    body: { name: "Renamed" },
  });
  assert.equal(named.status, 200);
  assert.equal((named.body.profile as { name: string }).name, "Renamed");
  assert.equal((named.body.profile as { onboarded: number }).onboarded, 1);

  // A skip sends an empty name; the known name must survive.
  const skipped = await request("/api/onboarding", {
    method: "POST",
    cookie: account.cookie,
    body: { name: "" },
  });
  assert.equal(skipped.status, 200);
  assert.equal((skipped.body.profile as { name: string }).name, "Renamed");
});

test("login is case-insensitive and wrong passwords are rejected", async () => {
  await register("mixed@example.com", "mixed-passphrase-1", "Mixed");
  const wrong = await request("/api/auth/login", {
    method: "POST",
    body: { email: "mixed@example.com", password: "not-the-password-2" },
  });
  assert.equal(wrong.status, 401);

  const right = await request("/api/auth/login", {
    method: "POST",
    body: { email: "MIXED@Example.com", password: "mixed-passphrase-1" },
  });
  assert.equal(right.status, 200);
  assert.ok(right.cookie);
});

test("changing a password revokes old sessions, signing out revokes the cookie", async () => {
  const account = await register("rotate@example.com", "before-passphrase-1", "Rotate");
  const changed = await request("/api/auth/password", {
    method: "POST",
    cookie: account.cookie,
    body: { current: "before-passphrase-1", next: "after-passphrase-2" },
  });
  assert.equal(changed.status, 200);
  assert.ok(changed.cookie);

  const oldSession = await request("/api/bootstrap", { cookie: account.cookie });
  assert.equal(oldSession.status, 401);
  const oldPassword = await request("/api/auth/login", {
    method: "POST",
    body: { email: "rotate@example.com", password: "before-passphrase-1" },
  });
  assert.equal(oldPassword.status, 401);
  const newPassword = await request("/api/auth/login", {
    method: "POST",
    body: { email: "rotate@example.com", password: "after-passphrase-2" },
  });
  assert.equal(newPassword.status, 200);

  await request("/api/auth/logout", { method: "POST", cookie: newPassword.cookie });
  const afterLogout = await request("/api/bootstrap", { cookie: newPassword.cookie });
  assert.equal(afterLogout.status, 401);
});

test("deleting an account removes its data and login", async () => {
  const account = await register("delete@example.com", "delete-passphrase-1", "Delete");
  const firstUse = await request("/api/bootstrap", { cookie: account.cookie });
  assert.equal(firstUse.status, 200);

  const wrong = await request("/api/account", {
    method: "DELETE",
    cookie: account.cookie,
    body: { password: "wrong-passphrase-2" },
  });
  assert.equal(wrong.status, 403);

  const deleted = await request("/api/account", {
    method: "DELETE",
    cookie: account.cookie,
    body: { password: "delete-passphrase-1" },
  });
  assert.equal(deleted.status, 200);

  const login = await request("/api/auth/login", {
    method: "POST",
    body: { email: "delete@example.com", password: "delete-passphrase-1" },
  });
  assert.equal(login.status, 401);

  // The old cookie is dead and the email is free again, so the account row and
  // its private schema were both removed.
  const staleSession = await request("/api/bootstrap", { cookie: account.cookie });
  assert.equal(staleSession.status, 401);
  const recreated = await register("delete@example.com", "delete-passphrase-1", "Delete");
  assert.equal(recreated.status, 201);
});

test("a published demo account cannot be locked out or deleted", async () => {
  // The account must still be usable after both destructive operations are refused.
  const demo = await register("demo@keepsake.test", "demo-passphrase-1", "Demo");
  assert.equal(demo.status, 201);

  const renamed = await request("/api/auth/password", {
    method: "POST",
    cookie: demo.cookie,
    body: { current: "demo-passphrase-1", next: "visitor-passphrase-2" },
  });
  assert.equal(renamed.status, 403);
  assert.match(String(renamed.body.error), /shared demo account/);

  const removed = await request("/api/account", {
    method: "DELETE",
    cookie: demo.cookie,
    body: { password: "demo-passphrase-1" },
  });
  assert.equal(removed.status, 403);

  // Still signed in, still the same password, still there.
  const still = await request("/api/bootstrap", { cookie: demo.cookie });
  assert.equal(still.status, 200);
  const login = await request("/api/auth/login", {
    method: "POST",
    body: { email: "demo@keepsake.test", password: "demo-passphrase-1" },
  });
  assert.equal(login.status, 200);

  // The guard is aimed at that one address, not at everyone: an ordinary
  // account can still rotate its password.
  const ordinary = await register("ordinary@example.com", "ordinary-passphrase-1", "Ordinary");
  const rotated = await request("/api/auth/password", {
    method: "POST",
    cookie: ordinary.cookie,
    body: { current: "ordinary-passphrase-1", next: "ordinary-passphrase-2" },
  });
  assert.equal(rotated.status, 200);
});

test("the avatar route round-trips a picture and rejects a non-image", async () => {
  const account = await register("avatar@example.com", "avatar-passphrase-1", "Avatar");
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  const upload = await request("/api/profile/avatar", {
    method: "PUT",
    cookie: account.cookie,
    body: { avatar: png },
  });
  assert.equal(upload.status, 200);

  const read = await request("/api/profile/avatar", { cookie: account.cookie });
  assert.equal(read.status, 200);
  assert.equal(read.body.avatar, png);

  const bad = await request("/api/profile/avatar", {
    method: "PUT",
    cookie: account.cookie,
    body: { avatar: "data:text/html;base64,PHNjcmlwdD4=" },
  });
  assert.equal(bad.status, 400);

  const removed = await request("/api/profile/avatar", { method: "DELETE", cookie: account.cookie });
  assert.equal(removed.status, 200);
  const gone = await request("/api/profile/avatar", { cookie: account.cookie });
  assert.equal(gone.status, 404);
});

test.after(() => {
  child?.kill("SIGTERM");
  fs.rmSync(dataDir, { recursive: true, force: true });
});
