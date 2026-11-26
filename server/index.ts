import express from "express";
import fs from "node:fs";
import path from "node:path";
import { db, getProfile, now } from "./db.js";
import { APP_NAME, env } from "./env.js";
import { contentSecurityPolicy } from "./csp.js";
import { initDatabase, storageInfo } from "./pg.js";
import {
  authenticate,
  clearLoginFailures,
  clearSessionCookie,
  countUsers,
  createSession,
  createUser,
  deleteAccount,
  deleteUserSessions,
  findUserByEmail,
  findUserByFirebaseUid,
  hashPassword,
  loginAllowed,
  passwordProblem,
  recordLoginFailure,
  requestToken,
  sessionAccount,
  setSessionCookie,
  signupsOpen,
  deleteSession,
  updatePassword,
  verifyPassword,
  upsertFirebaseUser,
  type Account,
} from "./auth.js";
import { removeTenantData, runWithTenant } from "./tenant.js";
import { appCheckConfigured, firebaseConfigured, firebaseWebConfig, verifyFirebaseIdToken } from "./firebase.js";
import type { Profile } from "../shared/types.js";

const app = express();
app.use(express.json({ limit: "6mb" }));
app.disable("x-powered-by");
if (env.trustProxy) app.set("trust proxy", 1);

function accountFor(res: express.Response): Account {
  return (res.locals as { account: Account }).account;
}

/** Shared demo accounts cannot be deleted or have their passwords changed. */
function isDemoAccount(account: Account): boolean {
  return env.demoAccounts.includes(account.email.trim().toLowerCase());
}

const DEMO_LOCKED =
  "This is the shared demo account, so its password and deletion are locked. " +
  "Create your own account to keep anything.";

function allowedOrigin(req: express.Request, origin: string): boolean {
  try {
    const originHost = new URL(origin).host;
    const requestHost = req.get("host") ?? "";
    if (originHost === requestHost) return true;
    if (originHost === new URL(env.publicUrl).host) return true;
    if (!env.isProd && ["127.0.0.1:5173", "localhost:5173"].includes(originHost)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * The production Content-Security-Policy. Kept as a pure function of what the
 * deployment has configured so it can be tested directly: a missing origin here
 * silently blocks inference in the browser, which is exactly the kind of break
 * a test should catch rather than a person.
 *
 * - Firebase sign-in needs the identity endpoints and the Google popup.
 * - Firebase AI Logic calls its own proxy gateway (`firebasevertexai.googleapis.com`
 *   is the SDK's hardcoded `DEFAULT_DOMAIN`) and App Check exchanges its token
 *   with the App Check API, both are required for cloud inference to leave the
 *   page at all.
 * - reCAPTCHA Enterprise loads a Google script and may frame the widget; the
 *   allowance is path-scoped so it stays narrow.
 */
/**
 * The production Content-Security-Policy. Kept as a pure function of what the
 * deployment has configured so it can be tested directly: a missing origin here
 * silently blocks inference in the browser, which is exactly the kind of break
 * a test should catch rather than a person.
 */
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=(self)");
  if (env.isProd) {
    res.setHeader(
      "Content-Security-Policy",
      contentSecurityPolicy({ firebase: firebaseConfigured(), appCheck: appCheckConfigured() }),
    );
  }
  next();
});

// Cookies authenticate API calls. Mutating browser requests must come from
// this origin; a missing Origin is a non-browser client such as curl.
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.get("origin");
  if (origin && !allowedOrigin(req, origin)) {
    return res.status(403).json({ error: "Cross-origin request rejected." });
  }
  if (req.get("sec-fetch-site") === "cross-site") {
    return res.status(403).json({ error: "Cross-site request rejected." });
  }
  next();
});

// Resolve the session once. Authenticated requests continue inside the
// account's database context for the rest of their async life.
app.use("/api", (req, res, next) => {
  void (async () => {
    const account = await sessionAccount(requestToken(req));
    if (!account) {
      (res.locals as { account: Account | null }).account = null;
      return next();
    }
    (res.locals as { account: Account }).account = account;
    await runWithTenant(account.id, () => new Promise<void>((resolve, reject) => {
      res.once("close", resolve);
      try { next(); } catch (error) { reject(error); }
    }));
  })().catch(next);
});

app.get("/api/health", async (_req, res) => {
  const storage = storageInfo();
  res.json({
    ok: true,
    name: APP_NAME,
    accounts: await countUsers(),
    storage: storage.driver,
    persistent: storage.persistent,
    // Which optional capability this deployment has keys for. A boolean only,
    // never the value, so an operator can confirm a deploy without guessing.
    capabilities: {
      firebase: Boolean(env.firebase.projectId),
      appCheck: appCheckConfigured(),
    },
    time: now(),
  });
});

app.get("/api/auth/config", async (_req, res) => {
  res.json({
    needsSetup: (await countUsers()) === 0,
    signupsOpen: await signupsOpen(),
    publicUrl: env.publicUrl,
    firebase: firebaseConfigured() ? firebaseWebConfig() : null,
  });
});

app.get("/api/auth/session", (_req, res) => {
  const account = (res.locals as { account: Account | null }).account;
  res.json({ account });
});

app.post("/api/auth/register", async (req, res) => {
  const email = String(req.body?.email ?? "");
  const password = String(req.body?.password ?? "");
  const name = String(req.body?.name ?? "").trim().slice(0, 60);
  if (!(await loginAllowed(`register:${req.ip}`))) {
    return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
  }
  try {
    const { account } = await createUser({ email, password, name });
    const session = await createSession(account.id, req.get("user-agent"));
    setSessionCookie(req, res, session.token);
    res.status(201).json({ account });
  } catch (error) {
    await recordLoginFailure(`register:${req.ip}`);
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not create the account." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const email = String(req.body?.email ?? "");
  const password = String(req.body?.password ?? "");
  const key = `login:${req.ip}:${email.toLowerCase()}`;
  if (!(await loginAllowed(key))) {
    return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
  }
  const account = await authenticate(email, password);
  if (!account) {
    await recordLoginFailure(key);
    return res.status(401).json({ error: "Email or password is incorrect." });
  }
  await clearLoginFailures(key);
  const session = await createSession(account.id, req.get("user-agent"));
  setSessionCookie(req, res, session.token);
  res.json({ account });
});

// Firebase does the sign-in (email/password or Google); the client posts the ID
// token and we mint the same Keepsake session cookie the password flow uses.
app.post("/api/auth/firebase", async (req, res) => {
  if (!firebaseConfigured()) {
    return res.status(400).json({ error: "Firebase sign-in is not configured on this server." });
  }
  const token = String(req.body?.idToken ?? "");
  const key = `firebase:${req.ip}`;
  if (!(await loginAllowed(key))) {
    return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
  }
  try {
    const identity = await verifyFirebaseIdToken(token);
    // Do not create a brand-new account while sign-ups are closed, but always
    // let an already-known person back in.
    if (!(await signupsOpen())) {
      const existing =
        (await findUserByFirebaseUid(identity.uid)) ?? (await findUserByEmail(identity.email));
      if (!existing) {
        return res.status(403).json({ error: "Sign-ups are closed on this server." });
      }
    }
    const account = await upsertFirebaseUser({
      uid: identity.uid,
      email: identity.email,
      name: identity.name,
      emailVerified: identity.emailVerified,
    });
    await clearLoginFailures(key);
    const session = await createSession(account.id, req.get("user-agent"));
    setSessionCookie(req, res, session.token);
    res.json({ account });
  } catch (error) {
    await recordLoginFailure(key);
    res.status(400).json({ error: error instanceof Error ? error.message : "Sign-in failed." });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  await deleteSession(requestToken(req));
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

const PUBLIC_API_PATHS = new Set([
  "/auth/config",
  "/auth/session",
  "/auth/register",
  "/auth/login",
  "/auth/firebase",
  "/auth/logout",
  "/health",
]);

app.use("/api", (req, res, next) => {
  if (PUBLIC_API_PATHS.has(req.path)) return next();
  if (!(res.locals as { account: Account | null }).account) {
    return res.status(401).json({ error: "Sign in to continue.", code: "AUTH_REQUIRED" });
  }
  next();
});

async function profile(): Promise<Profile> {
  return getProfile();
}

app.post("/api/auth/password", async (req, res) => {
  const account = accountFor(res);
  if (isDemoAccount(account)) return res.status(403).json({ error: DEMO_LOCKED });
  const current = String(req.body?.current ?? "");
  const next = String(req.body?.next ?? "");
  const row = await findUserByEmail(account.email);
  // Accounts that only ever signed in through Firebase have no local password,
  // so there is nothing to verify: the live session (which Firebase issued) is
  // the credential. Everyone else must prove the current password first.
  const hasLocalPassword = Boolean(row?.password_hash);
  if (!hasLocalPassword && !row?.firebase_uid) {
    return res.status(400).json({ error: "This account has no password on file." });
  }
  if (hasLocalPassword && !(await verifyPassword(current, row!.password_hash!))) {
    return res.status(403).json({ error: "Current password is incorrect." });
  }
  const issue = passwordProblem(next);
  if (issue) return res.status(400).json({ error: issue });
  const hash = await hashPassword(next);
  await updatePassword(account.id, hash);
  await deleteUserSessions(account.id);
  const session = await createSession(account.id, req.get("user-agent"));
  setSessionCookie(req, res, session.token);
  res.json({ ok: true, hadPassword: hasLocalPassword });
});

app.delete("/api/account", async (req, res) => {
  const account = accountFor(res);
  if (isDemoAccount(account)) return res.status(403).json({ error: DEMO_LOCKED });
  const password = String(req.body?.password ?? "");
  const row = await findUserByEmail(account.email);
  // A Firebase-only account has no local password to confirm; its session came
  // from Firebase and is the credential. An account with a password must still
  // re-enter it so a bare session cannot destroy the account.
  if (row?.password_hash && !(await verifyPassword(password, row.password_hash))) {
    return res.status(403).json({ error: "Password is incorrect." });
  }
  await deleteAccount(account.id);
  await removeTenantData(account.id);
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.get("/api/bootstrap", async (_req, res) => {
  const p = await profile();
  res.json({
    profile: p,
    account: accountFor(res),
    onboarded: Boolean(p.onboarded),
    // The Firebase web config ships with the session bootstrap as well as with
    // /api/auth/config. Sign-in is the only place it used to arrive, so a reload
    // while already signed in left the app unable to build an inference engine
    // at all (“Sign-in is still starting up” on every message).
    firebase: firebaseConfigured() ? firebaseWebConfig() : null,
  });
});

app.post("/api/onboarding", async (req, res) => {
  const name = String(req.body?.name ?? "").trim().slice(0, 60);
  await getProfile();
  // Keep a name we already know (Firebase/Google display name or sign-up name)
  // when the person skips the step, so onboarding never erases their identity.
  await db
    .prepare("UPDATE profile SET name = COALESCE(NULLIF(?, ''), name), onboarded = 1 WHERE id = 1")
    .run(name);
  res.json({ ok: true, profile: await profile() });
});

const AVATAR_TYPES = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const AVATAR_MAX_CHARS = 1_400_000;

app.get("/api/profile/avatar", async (_req, res) => {
  const row = await db.prepare("SELECT avatar FROM profile WHERE id = 1").get<{ avatar: string | null }>();
  if (!row?.avatar) return res.status(404).json({ error: "No picture yet." });
  res.json({ avatar: row.avatar });
});

app.put("/api/profile/avatar", async (req, res) => {
  const avatar = String(req.body?.avatar ?? "");
  if (!AVATAR_TYPES.test(avatar)) return res.status(400).json({ error: "Use a PNG, JPEG or WebP image." });
  if (avatar.length > AVATAR_MAX_CHARS) return res.status(413).json({ error: "Image is too large. Keep it under about 1 MB." });
  await getProfile();
  await db.prepare("UPDATE profile SET avatar = ? WHERE id = 1").run(avatar);
  res.json({ profile: await profile() });
});

app.delete("/api/profile/avatar", async (_req, res) => {
  await db.prepare("UPDATE profile SET avatar = NULL WHERE id = 1").run();
  res.json({ profile: await profile() });
});

app.patch("/api/profile", async (req, res) => {
  const p = await profile();
  const name = req.body?.name === undefined ? p.name : String(req.body.name).trim().slice(0, 60) || null;
  await db.prepare("UPDATE profile SET name = ? WHERE id = 1").run(name);
  res.json({ profile: await profile() });
});

if (env.isProd && !process.env.VERCEL) {
  const dist = path.resolve(process.cwd(), "dist");
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: "1h" }));
    app.use((req, res, next) => {
      if (req.path.startsWith("/api")) return next();
      res.sendFile(path.join(dist, "index.html"));
    });
  }
}

app.use((req, res) => {
  if (req.path.startsWith("/api")) return res.status(404).json({ error: "Not found" });
  res.status(404).type("text").send("Not found");
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[api]", error);
  res.status(500).json({ error: "Internal error" });
});

export { app };

/**
 * Standalone server. On a serverless host (VERCEL=1) the platform imports
 * `app` and manages the process, so we only connect the database.
 */
export async function startServer(): Promise<void> {
  await initDatabase();
  if (process.env.VERCEL) return;
  app.listen(env.port, env.host, () => {
    console.log(`${APP_NAME} API on http://${env.host}:${env.port}`);
    console.log(`data: ${env.dataDir}`);
  });
}

if (!process.env.VERCEL) {
  void startServer().catch((error) => {
    console.error("[startup]", error);
    process.exit(1);
  });
}
