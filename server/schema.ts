import { createAccountSchema, scopedExec } from "./pg.js";

/**
 * Each account owns a Postgres schema with the same table set. `scopedExec`
 * already set `search_path` to that schema, so the DDL uses bare names.
 *
 * Keepsake is local-first: conversations and every other piece of private
 * context live on the device, never here. What the server keeps for an account
 * is only what an account needs to exist and be described, a profile row. The
 * server has no chat, memory, project, task or run tables because it has no
 * such features.
 */
export async function initializeSchema(accountId: string): Promise<void> {
  await createAccountSchema(accountId);
  await scopedExec(
    accountId,
    `
    CREATE TABLE IF NOT EXISTS profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT,
      email TEXT,
      onboarded INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    ALTER TABLE profile ADD COLUMN IF NOT EXISTS avatar TEXT;

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `,
  );
}
