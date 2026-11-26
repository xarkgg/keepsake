import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

const PROJECT = "keepsake-test-project";
process.env.FIREBASE_PROJECT_ID = PROJECT;

const { verifyFirebaseIdToken } = await import("../server/firebase.js");

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-key-1";
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

// The verifier accepts any PEM key material for the kid, so the test can stand
// in a locally generated key for Google's published certificate and stay offline.
const realFetch = globalThis.fetch;
function stubCerts(): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ [KID]: PUBLIC_PEM }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
    })) as typeof fetch;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function signToken(claims: Record<string, unknown>, header: Record<string, unknown> = {}) {
  const head = b64url(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT", ...header }));
  const body = b64url(JSON.stringify(claims));
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey);
  return `${head}.${body}.${b64url(signature)}`;
}

function claimsFor(overrides: Record<string, unknown> = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    aud: PROJECT,
    iss: `https://securetoken.google.com/${PROJECT}`,
    sub: "firebase-uid-123",
    iat: nowSec - 10,
    exp: nowSec + 3600,
    email: "Person@Example.com",
    email_verified: true,
    name: "A Person",
    firebase: { sign_in_provider: "google.com" },
    ...overrides,
  };
}

test("verifies a correctly signed Firebase ID token", async () => {
  stubCerts();
  try {
    const identity = await verifyFirebaseIdToken(signToken(claimsFor()));
    assert.equal(identity.uid, "firebase-uid-123");
    assert.equal(identity.email, "person@example.com");
    assert.equal(identity.name, "A Person");
    assert.equal(identity.emailVerified, true);
    assert.equal(identity.signInProvider, "google.com");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("rejects a token minted for another project", async () => {
  stubCerts();
  try {
    await assert.rejects(
      verifyFirebaseIdToken(signToken(claimsFor({ aud: "someone-else" }))),
      /another project/,
    );
    await assert.rejects(
      verifyFirebaseIdToken(signToken(claimsFor({ iss: "https://evil.example" }))),
      /another project/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("rejects an expired token", async () => {
  stubCerts();
  try {
    const past = Math.floor(Date.now() / 1000) - 3600;
    await assert.rejects(verifyFirebaseIdToken(signToken(claimsFor({ exp: past }))), /expired/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("rejects a tampered signature", async () => {
  stubCerts();
  try {
    const [head, body] = signToken(claimsFor()).split(".");
    const forged = `${head}.${body}.${b64url(crypto.randomBytes(256))}`;
    await assert.rejects(verifyFirebaseIdToken(forged), /signature did not match/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("rejects a malformed token and a token with no email", async () => {
  await assert.rejects(verifyFirebaseIdToken("not-a-jwt"), /malformed/);
  stubCerts();
  try {
    await assert.rejects(verifyFirebaseIdToken(signToken(claimsFor({ email: undefined }))), /no email/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("rejects a token that was not signed with RS256", async () => {
  stubCerts();
  try {
    await assert.rejects(
      verifyFirebaseIdToken(signToken(claimsFor(), { alg: "none" })),
      /Unsupported token algorithm/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the web config reaches the app on a normal load, not only after signing in", async () => {
  // Inference builds its engine from the Firebase config held in memory. That
  // config used to arrive only from /api/auth/config, which the sign-in page
  // fetches, so reloading while already signed in left every message failing
  // with "Sign-in is still starting up". Both ends of that fix are pinned here.
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const server = readFileSync(path.resolve(import.meta.dirname, "../server/index.ts"), "utf8");
  const start = server.indexOf('app.get("/api/bootstrap"');
  assert.ok(start > 0, "the bootstrap route must exist");
  const handler = server.slice(start, server.indexOf("\n});", start));
  assert.match(
    handler,
    /firebase:\s*firebaseConfigured\(\)\s*\?\s*firebaseWebConfig\(\)/,
    "the bootstrap response must carry the Firebase web config",
  );

  const client = readFileSync(path.resolve(import.meta.dirname, "../src/lib/app-context.tsx"), "utf8");
  const load = client.slice(client.indexOf("const reloadBootstrap"));
  assert.match(
    load.slice(0, 700),
    /configureFirebase\(data\.firebase/,
    "bootstrap must configure Firebase before the app can render a chat",
  );
});

test("cloud inference runs on its own Firebase app so App Check can never be missed", async () => {
  // The AI SDK resolves App Check once, when it builds its service for an app,
  // and keeps that answer forever. Hybrid Mode always tries the on-device model
  // first, which builds the service on the main app, so a shared app left the
  // cloud call with no App Check token and the API rejected it as unattested
  // (401 "Firebase App Check token is invalid"). Cloud inference therefore uses
  // a dedicated app, and App Check is initialized on that same app.
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const read = (rel: string) => readFileSync(path.resolve(import.meta.dirname, rel), "utf8");

  const engine = read("../src/lib/inference/firebase-ai.ts");
  const device = engine.slice(engine.indexOf("private async device("), engine.indexOf("private async cloud("));
  const cloud = engine.slice(engine.indexOf("private async cloud("), engine.indexOf("async availability("));
  assert.match(device, /getAI\(this\.app\b/, "the on-device model belongs to the main app");
  assert.match(cloud, /getCloudFirebaseApp\(\)/, "the cloud model must use the dedicated app");
  assert.ok(
    !/getAI\(this\.app\b/.test(cloud),
    "the cloud model must not share the app the device path builds its service on",
  );

  const firebase = read("../src/lib/firebase.ts");
  const appCheck = firebase.slice(firebase.indexOf("export async function ensureAppCheck("));
  assert.match(
    appCheck.slice(0, 900),
    /getCloudFirebaseApp\(\)[\s\S]*initializeAppCheck\(app,/,
    "App Check must be initialized on the same app cloud inference uses",
  );
});
