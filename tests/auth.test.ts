import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepsake-auth-"));
process.env.KEEPSAKE_DATA_DIR = dataDir;
process.env.KEEPSAKE_SIGNUPS = "open";
delete process.env.KEEPSAKE_DATABASE_URL;

const { initDatabase, publicQuery, closeDatabase } = await import("../server/pg.js");
const auth = await import("../server/auth.js");

await initDatabase();

test("passwords hash with scrypt and verify without storing the original", async () => {
  const hash = await auth.hashPassword("correct horse 42");
  assert.match(hash, /^scrypt\$/);
  assert.ok(!hash.includes("correct horse 42"));
  assert.equal(await auth.verifyPassword("correct horse 42", hash), true);
  assert.equal(await auth.verifyPassword("wrong horse 42", hash), false);
  assert.equal(await auth.verifyPassword("correct horse 42", hash.replace(/^scrypt\$/, "bcrypt$")), false);
  assert.equal(await auth.verifyPassword("correct horse 42", "garbage"), false);
});

test("the same password produces different hashes", async () => {
  const [first, second] = await Promise.all([
    auth.hashPassword("repeated password 7"),
    auth.hashPassword("repeated password 7"),
  ]);
  assert.notEqual(first, second);
  assert.equal(await auth.verifyPassword("repeated password 7", first), true);
  assert.equal(await auth.verifyPassword("repeated password 7", second), true);
});

test("password policy rejects weak choices", () => {
  assert.ok(auth.passwordProblem("short1"));
  assert.ok(auth.passwordProblem("onlyletters"));
  assert.ok(auth.passwordProblem("1234567890"));
  assert.equal(auth.passwordProblem("a-good-passphrase-1"), null);
});

test("accounts are unique by email regardless of case", async () => {
  const { account } = await auth.createUser({
    email: "First@Example.com",
    password: "a-good-passphrase-1",
    name: "First",
  });
  assert.equal(account.email, "first@example.com");
  assert.equal((await auth.getAccount(account.id))?.name, "First");

  await assert.rejects(
    () => auth.createUser({ email: "first@example.COM", password: "another-passphrase-2" }),
    /already exists/,
  );
});

test("sessions are opaque, hashed at rest and revocable", async () => {
  const { account } = await auth.createUser({
    email: "session@example.com",
    password: "a-good-passphrase-1",
  });
  const session = await auth.createSession(account.id, "node test");
  assert.ok(session.token.length >= 40);
  const { rows } = await publicQuery<{ token_hash: string }>(
    "SELECT token_hash FROM sessions WHERE account_id = $1",
    [account.id],
  );
  assert.notEqual(rows[0].token_hash, session.token);
  assert.equal(rows[0].token_hash, auth.hashToken(session.token));

  assert.equal((await auth.sessionAccount(session.token))?.id, account.id);
  assert.equal(await auth.sessionAccount("not-a-real-token"), undefined);

  await auth.deleteSession(session.token);
  assert.equal(await auth.sessionAccount(session.token), undefined);
});

test("authentication updates last login and rejects bad passwords", async () => {
  const created = await auth.createUser({
    email: "login@example.com",
    password: "a-good-passphrase-1",
  });
  assert.equal(await auth.authenticate("LOGIN@example.com", "wrong-passphrase-2"), null);
  const account = await auth.authenticate("login@example.com", "a-good-passphrase-1");
  assert.equal(account?.id, created.account.id);
  assert.ok(account?.last_login_at);
});

test("the login limiter counts failures and clears on success", async () => {
  const key = "login:test:limiter@example.com";
  assert.equal(await auth.loginAllowed(key), true);
  for (let attempt = 0; attempt < 10; attempt += 1) await auth.recordLoginFailure(key);
  assert.equal(await auth.loginAllowed(key), false);
  await auth.clearLoginFailures(key);
  assert.equal(await auth.loginAllowed(key), true);
});

test("a Firebase identity provisions one account and reuses it", async () => {
  const first = await auth.upsertFirebaseUser({
    uid: "firebase-uid-a",
    email: "Person@Example.com",
    name: "A Person",
    emailVerified: true,
  });
  assert.equal(first.email, "person@example.com");
  assert.equal(first.name, "A Person");

  // Signing in again with the same uid returns the same account.
  const again = await auth.upsertFirebaseUser({ uid: "firebase-uid-a", email: "person@example.com" });
  assert.equal(again.id, first.id);
});

test("Google sign-in links to an existing password account by email", async () => {
  // A password account exists first; later the same person signs in with Google.
  // The Firebase uid attaches to that account instead of duplicating it.
  const password = await auth.createUser({ email: "link-me@example.com", password: "a-good-passphrase-1" });
  const linked = await auth.upsertFirebaseUser({ uid: "firebase-uid-b", email: "link-me@example.com", emailVerified: true });
  assert.equal(linked.id, password.account.id);
  assert.equal((await auth.findUserByFirebaseUid("firebase-uid-b"))?.id, password.account.id);
  // The original password still works and now belongs to the same account.
  assert.equal((await auth.authenticate("link-me@example.com", "a-good-passphrase-1"))?.id, password.account.id);
});

test("an unverified Firebase email cannot link to or create an account", async () => {
  // An attacker can register someone else's address in Firebase without
  // controlling it; without the email_verified gate they could then attach
  // their uid to that person's Keepsake account.
  await auth.createUser({ email: "victim@example.com", password: "a-good-passphrase-1" });
  await assert.rejects(
    () => auth.upsertFirebaseUser({ uid: "firebase-uid-x", email: "victim@example.com", emailVerified: false }),
    /Verify that email/,
  );
  // The existing account is untouched: no uid was attached.
  assert.equal((await auth.findUserByEmail("victim@example.com"))?.firebase_uid ?? null, null);
  await assert.rejects(
    () => auth.upsertFirebaseUser({ uid: "firebase-uid-y", email: "brand-new@example.com", emailVerified: false }),
    /Verify that email/,
  );
  assert.equal(await auth.findUserByEmail("brand-new@example.com"), undefined);
});

test("a Firebase-only account cannot authenticate with a password", async () => {
  const account = await auth.upsertFirebaseUser({ uid: "firebase-uid-c", email: "google-only@example.com", emailVerified: true });
  assert.equal(await auth.authenticate("google-only@example.com", "anything-at-all-1"), null);
  assert.equal((await auth.findUserByEmail("google-only@example.com"))?.password_hash, null);
  assert.ok(account.id);
});

test("a Firebase account's email follows Firebase, but cannot collide", async () => {
  const account = await auth.upsertFirebaseUser({ uid: "firebase-uid-d", email: "owner@example.com", emailVerified: true });
  // Changing the address in Firebase updates the account, same identity.
  const moved = await auth.upsertFirebaseUser({ uid: "firebase-uid-d", email: "moved@example.com" });
  assert.equal(moved.id, account.id);
  assert.equal(moved.email, "moved@example.com");

  // If that new address already belongs to someone else, the unique index
  // refuses it rather than merging two people.
  await auth.createUser({ email: "taken@example.com", password: "a-good-passphrase-1" });
  await assert.rejects(
    () => auth.upsertFirebaseUser({ uid: "firebase-uid-d", email: "taken@example.com" }),
    /already exists/,
  );
});

test("sessionAccount marks whether the account has a local password", async () => {
  const withPassword = await auth.createUser({ email: "has-pass@example.com", password: "a-good-passphrase-1" });
  const firebaseOnly = await auth.upsertFirebaseUser({ uid: "firebase-uid-hp", email: "no-pass@example.com", emailVerified: true });
  const pwSession = await auth.createSession(withPassword.account.id, "test");
  const fbSession = await auth.createSession(firebaseOnly.id, "test");
  assert.equal((await auth.sessionAccount(pwSession.token))?.has_password, true);
  assert.equal((await auth.sessionAccount(fbSession.token))?.has_password, false);
  // The tenant context resolver never leaks the hash itself.
  assert.equal("password_hash" in ((await auth.sessionAccount(pwSession.token)) ?? {}), false);
});

test("cookie parsing keeps valid values and tolerates bad encoding", () => {
  assert.deepEqual(auth.parseCookies("keepsake_session=abc; theme=dark"), {
    keepsake_session: "abc",
    theme: "dark",
  });
  assert.equal(auth.parseCookies("keepsake_session=%E0%A4%A").keepsake_session, "%E0%A4%A");
  assert.equal(auth.requestToken({ headers: { cookie: "keepsake_session=xyz" } } as never), "xyz");
});

test.after(async () => {
  await closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
