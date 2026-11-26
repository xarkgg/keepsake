import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepsake-tenant-"));
process.env.KEEPSAKE_DATA_DIR = dir;
delete process.env.KEEPSAKE_DATABASE_URL;

const { initDatabase, closeDatabase, accountSchema, publicQuery } = await import("../server/pg.js");
await initDatabase();
const { runWithTenant, removeTenantData } = await import("../server/tenant.js");
const { db } = await import("../server/db.js");

const ids = Array.from({ length: 8 }, (_, i) => `account-${String(i).padStart(8, "0")}`);

test("each account schema holds its own rows", async () => {
  await runWithTenant(ids[0], async () => {
    await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("theme", "first");
  });
  await runWithTenant(ids[1], async () => {
    await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("theme", "second");
  });
  const first = await runWithTenant(ids[0], () => db.prepare("SELECT value FROM settings WHERE key = ?").get<{ value: string }>("theme"));
  const second = await runWithTenant(ids[1], () => db.prepare("SELECT value FROM settings WHERE key = ?").get<{ value: string }>("theme"));
  assert.equal(first?.value, "first");
  assert.equal(second?.value, "second");
});

test("concurrent account work stays separate", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const work = runWithTenant(ids[2], async () => {
    await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("test", "first");
    await gate;
    const row = await db.prepare("SELECT value FROM settings WHERE key = ?").get<{ value: string }>("test");
    assert.equal(row?.value, "first");
  });
  await Promise.all(
    ids.slice(3, 6).map((id) =>
      runWithTenant(id, async () => {
        await db.prepare("SELECT COUNT(*) AS n FROM settings").get();
      }),
    ),
  );
  release();
  await work;
});

test("charts of the shared schema stay in public", async () => {
  const { rows } = await publicQuery<{ n: string }>(
    "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = $1",
    ["public"],
  );
  assert.ok(Number(rows[0].n) >= 3);
});

test("account schemas are named from a validated id", () => {
  assert.equal(accountSchema("b1a2c3d4-0000-0000-0000-000000000000"), "acct_b1a2c3d4_0000_0000_0000_000000000000");
  assert.throws(() => accountSchema("bad id"), /Invalid account id/);
});

test("dropping an account removes its schema", async () => {
  const { rows } = await publicQuery<{ n: string }>(
    "SELECT COUNT(*) AS n FROM information_schema.schemata WHERE schema_name = $1",
    [accountSchema(ids[0])],
  );
  assert.equal(Number(rows[0].n), 1);
  await removeTenantData(ids[0]);
  const after = await publicQuery<{ n: string }>(
    "SELECT COUNT(*) AS n FROM information_schema.schemata WHERE schema_name = $1",
    [accountSchema(ids[0])],
  );
  assert.equal(Number(after.rows[0].n), 0);
});

test.after(async () => {
  for (const id of ids) await removeTenantData(id).catch(() => undefined);
  await closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});
