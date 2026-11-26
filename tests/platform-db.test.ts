import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * A serverless host (Vercel) has an ephemeral, per-instance filesystem, so the
 * embedded database would be a fresh, empty copy on every invocation, not a
 * database at all. With no connection string configured, the server must refuse
 * to start rather than silently lose every account and session.
 *
 * This is the regression test for the live bug where `/api/health` reported a
 * different account count on every parallel request.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepsake-nodb-"));
process.env.KEEPSAKE_DATA_DIR = dir;
process.env.VERCEL = "1";
process.env.KEEPSAKE_PGLITE_DIR = path.join(dir, "pglite");
delete process.env.KEEPSAKE_DATABASE_URL;
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.POSTGRES_PRISMA_URL;
delete process.env.POSTGRES_URL_NON_POOLING;

test("a serverless host with no database refuses to start", async () => {
  const { initDatabase, closeDatabase } = await import("../server/pg.js");
  await assert.rejects(() => initDatabase(), /No Postgres connection string is configured/);
  await closeDatabase().catch(() => undefined);
});

test("the conventional integration variables are accepted", async () => {
  // The Neon/Vercel integration injects DATABASE_URL, not KEEPSAKE_DATABASE_URL.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(path.resolve(import.meta.dirname, "../server/env.ts"), "utf8");
  assert.match(source, /process\.env\.DATABASE_URL/);
  assert.match(source, /process\.env\.POSTGRES_URL/);
});

test("a managed database connects over TLS even without sslmode", async () => {
  // Supabase's string (via the Vercel integration) has no `sslmode` and its
  // host is not neon.tech, so keying on those would connect in plaintext and
  // fail. Anything that is not loopback must use TLS.
  const { tlsForUrl } = await import("../server/pg.js");
  assert.deepEqual(tlsForUrl("postgresql://postgres:pw@db.abcdef.supabase.co:5432/postgres"), {
    rejectUnauthorized: false,
  });
  assert.deepEqual(tlsForUrl("postgresql://user:pw@ep-cool-1.us-east-1.aws.neon.tech/neondb"), {
    rejectUnauthorized: false,
  });
  assert.deepEqual(tlsForUrl("postgres://u:p@db.example.com:5432/x?sslmode=require"), {
    rejectUnauthorized: false,
  });
  // Explicitly disabled stays off; a local host needs no TLS.
  assert.equal(tlsForUrl("postgres://u:p@db.example.com:5432/x?sslmode=disable"), false);
  assert.equal(tlsForUrl("postgres://u:p@localhost:5432/keepsake"), undefined);
  assert.equal(tlsForUrl("postgres://u:p@127.0.0.1:5432/keepsake"), undefined);
});

test("sslmode is dropped when we supply our own TLS option", async () => {
  // pg >= 8.16 maps `sslmode=require` to verify-full and lets the string win
  // over the explicit `ssl` option, so a managed provider's chain fails with
  // SELF_SIGNED_CERT_IN_CHAIN. Dropping the parameter makes our option
  // authoritative; every other parameter must survive untouched.
  const { tlsForUrl, connectionStringForTls } = await import("../server/pg.js");
  const managed = "postgres://u:p@aws-0-ca-central-1.pooler.supabase.com:6543/postgres?sslmode=require&supa=base-pooler.x";
  const ssl = tlsForUrl(managed);
  assert.deepEqual(ssl, { rejectUnauthorized: false });
  const adjusted = new URL(connectionStringForTls(managed, ssl));
  assert.equal(adjusted.searchParams.has("sslmode"), false);
  assert.equal(adjusted.searchParams.get("supa"), "base-pooler.x");
  assert.equal(adjusted.password, "p");
  // Nothing is rewritten when the string does not carry sslmode, when TLS is
  // explicitly off, or on a loopback host.
  const plain = "postgres://u:p@db.example.com:5432/x";
  assert.equal(connectionStringForTls(plain, tlsForUrl(plain)), plain);
  const disabled = "postgres://u:p@db.example.com:5432/x?sslmode=disable";
  assert.equal(connectionStringForTls(disabled, tlsForUrl(disabled)), disabled);
  const local = "postgres://u:p@localhost:5432/keepsake?sslmode=require";
  assert.equal(connectionStringForTls(local, tlsForUrl(local)), local);
});

test("the no-database diagnostic lists connection names but never secret names", async () => {
  const { databaseEnvNames } = await import("../server/pg.js");
  process.env.POSTGRES_URL = "postgres://user:secret@db.example.com/x";
  process.env.SUPABASE_ANON_KEY = "ey...";
  process.env.MY_DATABASE_SECRET = "shh";
  const names = databaseEnvNames();
  assert.ok(names.includes("POSTGRES_URL"));
  // Nothing that looks like a key or secret is echoed, even by name.
  assert.ok(!names.some((name) => /KEY|SECRET|TOKEN|PASSWORD/i.test(name)));
  delete process.env.POSTGRES_URL;
  delete process.env.SUPABASE_ANON_KEY;
  delete process.env.MY_DATABASE_SECRET;
});

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
