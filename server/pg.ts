import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "./env.js";

/**
 * One Postgres backend for every environment.
 *
 * - Production points `KEEPSAKE_DATABASE_URL` at Vercel Postgres / Neon and uses the
 *   `pg` driver over the network.
 * - Development and tests fall back to PGlite, an embedded build of real
 *   Postgres, so the same SQL runs with no external server.
 *
 * Accounts are isolated by Postgres schema: each account owns a schema and every
 * query runs inside a short transaction that sets `search_path` to it. The stored
 * SQL keeps bare table names, so tenant isolation is enforced by the database
 * rather than by trusting a client-supplied id.
 *
 * Each transaction is pinned to a single connection. That matters on a pool:
 * issuing `BEGIN` and `SET LOCAL` as separate pool queries could land them on
 * different connections and leak one account's `search_path` into another query.
 */

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

/** A single pinned connection. Every call in a transaction must use the same one. */
export interface Connection {
  query(text: string, params?: unknown[]): Promise<QueryResult<Record<string, unknown>>>;
  exec(text: string): Promise<void>;
}

interface Backend {
  /** Run `fn` inside a transaction on one pinned connection, or across autocommit. */
  withConnection<T>(fn: (client: Connection) => Promise<T>): Promise<T>;
  /** Single-statement autocommit helper for schema-level DDL. */
  exec(text: string): Promise<void>;
  close(): Promise<void>;
}

const storage = new AsyncLocalStorage<string>();

export class DatabaseNotReadyError extends Error {
  constructor() {
    super("The database is not initialized yet.");
  }
}

let backend: Backend | null = null;
let ready: Promise<void> | null = null;
let driver: "postgres" | "pglite" | null = null;

/** Where the running process actually keeps data. Surfaced by `/api/health`. */
export function storageInfo(): { driver: "postgres" | "pglite"; persistent: boolean } {
  return driver === "postgres"
    ? { driver: "postgres", persistent: true }
    : { driver: "pglite", persistent: false };
}

/** Account schema names are derived from a validated id, never from raw input. */
export function accountSchema(accountId: string): string {
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(accountId)) throw new Error("Invalid account id");
  return `acct_${accountId.replace(/-/g, "_")}`;
}

function quoteIdent(identifier: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(identifier)) throw new Error("Invalid identifier");
  return `"${identifier}"`;
}

/** Rewrite SQLite-style `?` placeholders to Postgres `$n`, ignoring quoted text. */
const placeholderCache = new Map<string, string>();
export function toPgPlaceholders(sql: string): string {
  const hit = placeholderCache.get(sql);
  if (hit) return hit;
  let index = 0;
  let single = false;
  let out = "";
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === "'") {
      single = !single;
      out += ch;
      continue;
    }
    if (ch === "?" && !single) {
      index += 1;
      out += `$${index}`;
      continue;
    }
    out += ch;
  }
  placeholderCache.set(sql, out);
  return out;
}

/**
 * Whether a connection string should be opened over TLS, and how strictly. A
 * managed provider (Neon, Supabase, Vercel, RDS, Azure, …) requires TLS but
 * usually does not put `sslmode` in the string, so keying on `sslmode` alone
 * silently connects in plaintext. Default to TLS for anything that is not
 * loopback; honor an explicit `sslmode=disable`, and use
 * `rejectUnauthorized: false` because managed providers present a cert chain a
 * serverless function does not always carry the root for.
 */
export function tlsForUrl(url: string): { rejectUnauthorized: boolean } | false | undefined {
  if (/[?&]sslmode=(disable|allow)\b/.test(url)) return false;
  try {
    const host = new URL(url).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return undefined;
  } catch {
    // Not parseable as a URL; fall through and assume a network host.
  }
  return { rejectUnauthorized: false };
}

/**
 * The connection string to hand to `pg`, aligned with the TLS decision above.
 *
 * `pg` (via pg-connection-string >= 2.9) maps `sslmode=require` to `verify-full`,
 * and a `sslmode` in the string overrides the explicit `ssl` option. Managed
 * providers ship a cert chain a serverless function does not carry the root for
 *, Supabase's pooler fails with `SELF_SIGNED_CERT_IN_CHAIN`, so when we have
 * decided to encrypt without verifying, drop `sslmode` and let the explicit
 * option govern. Plaintext and loopback strings are returned untouched.
 */
export function connectionStringForTls(
  url: string,
  tls: { rejectUnauthorized: boolean } | false | undefined,
): string {
  if (!tls) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has("sslmode")) return url;
    parsed.searchParams.delete("sslmode");
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Names, never values, of the environment variables that look like database
 * configuration. Only used in the no-database error, so a mis-named or
 * not-yet-connected integration variable can be told apart from a missing one
 * without opening the dashboard.
 */
export function databaseEnvNames(): string[] {
  return Object.keys(process.env)
    .filter((key) => /POSTGRES|DATABASE|SUPABASE|NEON|CONNECTION|^PG/i.test(key))
    .filter((key) => !/KEY|SECRET|TOKEN|PASSWORD|JWT|ANON|SERVICE_ROLE/i.test(key))
    .sort();
}

async function createBackend(): Promise<Backend> {
  const url = env.databaseUrl;
  if (url) {
    const { default: pg } = await import("pg");
    const ssl = tlsForUrl(url);
    const pool = new pg.Pool({
      connectionString: connectionStringForTls(url, ssl),
      max: Number(process.env.KEEPSAKE_PG_POOL ?? 5),
      ssl,
    });
    const wrap = (client: {
      query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
    }): Connection => ({
      async query(text, params = []) {
        const result = await client.query(text, params as unknown[]);
        return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? 0 };
      },
      async exec(text) {
        await client.query(text);
      },
    });
    driver = "postgres";
    return {
      async withConnection(fn) {
        const client = await pool.connect();
        try {
          return await fn(wrap(client));
        } finally {
          client.release();
        }
      },
      async exec(text) {
        await pool.query(text);
      },
      async close() {
        await pool.end();
      },
    };
  }

  // On a serverless host the filesystem is per-instance and ephemeral, so the
  // embedded database would be a fresh, empty copy on every invocation. That is
  // not a database, and it silently loses every account and session, so refuse
  // to run this way rather than corrupt the app.
  if (env.isServerless) {
    const seen = databaseEnvNames();
    throw new Error(
      "No Postgres connection string is configured. On Vercel, add the Postgres or Supabase " +
        "integration (which provides DATABASE_URL / POSTGRES_URL) or set KEEPSAKE_DATABASE_URL. The " +
        "embedded database cannot be used on a serverless host. " +
        `Database-related env var names present: ${seen.length ? seen.join(", ") : "none"}.`,
    );
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const dir = process.env.KEEPSAKE_PGLITE_DIR;
  const pglite = dir ? new PGlite(dir) : new PGlite();
  await pglite.waitReady;
  driver = "pglite";
  // PGlite has a single connection, so transactions are serialized: a second
  // transaction cannot interleave its `search_path` into the first.
  const client: Connection = {
    async query(text, params = []) {
      const result = await pglite.query(text, params as unknown[]);
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.affectedRows ?? result.rows.length };
    },
    async exec(text) {
      await pglite.exec(text);
    },
  };
  let queue: Promise<unknown> = Promise.resolve();
  return {
    withConnection(fn) {
      const run = queue.then(() => fn(client), () => fn(client));
      queue = run.catch(() => undefined);
      return run;
    },
    exec: (text) => {
      const run = queue.then(() => client.exec(text), () => client.exec(text));
      queue = run.catch(() => undefined);
      return run;
    },
    async close() {
      await pglite.close();
    },
  };
}

export async function initDatabase(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      backend = await createBackend();
      await backend.exec(`
        CREATE TABLE IF NOT EXISTS accounts (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          name TEXT,
          password_hash TEXT,
          created_at TEXT NOT NULL,
          last_login_at TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email ON accounts (lower(email));
        ALTER TABLE accounts ALTER COLUMN password_hash DROP NOT NULL;
        ALTER TABLE accounts ADD COLUMN IF NOT EXISTS firebase_uid TEXT;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_firebase ON accounts (firebase_uid);

        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          user_agent TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);

        CREATE TABLE IF NOT EXISTS login_attempts (
          key TEXT PRIMARY KEY,
          count INTEGER NOT NULL DEFAULT 0,
          reset_at TEXT NOT NULL
        );
      `);
    })();
  }
  return ready;
}

function requireBackend(): Backend {
  if (!backend) throw new DatabaseNotReadyError();
  return backend;
}

/** Run statements inside a transaction pinned to one schema on one connection. */
async function transaction(
  schema: string | null,
  statements: (client: Connection) => Promise<void>,
): Promise<void> {
  const db = requireBackend();
  await db.withConnection(async (client) => {
    await client.exec("BEGIN");
    try {
      if (schema) await client.exec(`SET LOCAL search_path TO ${schema}, public`);
      await statements(client);
      await client.exec("COMMIT");
    } catch (error) {
      await client.exec("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });
}

/** Run a parameterized statement inside one account schema. */
export async function scopedQuery<T = Record<string, unknown>>(
  accountId: string,
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  const schema = quoteIdent(accountSchema(accountId));
  let result: QueryResult<Record<string, unknown>> = { rows: [], rowCount: 0 };
  await transaction(schema, async (client) => {
    result = await client.query(text, params);
  });
  return { rows: result.rows as T[], rowCount: result.rowCount };
}

/** Run DDL or multiple statements inside an account schema (no parameters). */
export async function scopedExec(accountId: string, text: string): Promise<void> {
  const schema = quoteIdent(accountSchema(accountId));
  await transaction(schema, (client) => client.exec(text));
}

/** Query the shared `public` schema (accounts, sessions, OAuth states). */
export async function publicQuery<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  let result: QueryResult<Record<string, unknown>> = { rows: [], rowCount: 0 };
  await transaction(null, async (client) => {
    result = await client.query(text, params);
  });
  return { rows: result.rows as T[], rowCount: result.rowCount };
}

/**
 * Run several statements against the shared `public` schema inside one
 * transaction on one pinned connection. Used where a read-then-write must be
 * atomic across serverless instances (for example the first-account check).
 */
export async function publicTransaction<T>(fn: (client: Connection) => Promise<T>): Promise<T> {
  const db = requireBackend();
  return db.withConnection(async (client) => {
    await client.exec("BEGIN");
    try {
      const result = await fn(client);
      await client.exec("COMMIT");
      return result;
    } catch (error) {
      await client.exec("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });
}

export async function createAccountSchema(accountId: string): Promise<void> {
  const db = requireBackend();
  await db.exec(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(accountSchema(accountId))}`);
}

export async function dropAccountSchema(accountId: string): Promise<void> {
  const db = requireBackend();
  await db.exec(`DROP SCHEMA IF EXISTS ${quoteIdent(accountSchema(accountId))} CASCADE`);
}

export function runWithAccount<T>(accountId: string, fn: () => T): T {
  return storage.run(accountId, fn);
}

export function currentAccountId(): string | null {
  return storage.getStore() ?? null;
}

export function requireAccountId(): string {
  const id = storage.getStore();
  if (!id) throw new Error("No account context for this request");
  return id;
}

export async function closeDatabase(): Promise<void> {
  if (backend) await backend.close();
  backend = null;
  ready = null;
}
