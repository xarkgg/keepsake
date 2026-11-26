import { publicQuery, requireAccountId, scopedExec, scopedQuery, toPgPlaceholders } from "./pg.js";

export const now = () => new Date().toISOString();

/**
 * The rest of the server keeps the small `db.prepare(sql).get/all/run(...)`
 * shape it always had, but the calls are now async and run inside the account's
 * Postgres schema. `?` placeholders are translated to `$n` on the way through.
 */
function statement(sql: string) {
  const pgSql = toPgPlaceholders(sql);
  return {
    async get<T = unknown>(...params: unknown[]): Promise<T | undefined> {
      const { rows } = await scopedQuery(requireAccountId(), pgSql, params);
      return rows[0] as T | undefined;
    },
    async all<T = unknown>(...params: unknown[]): Promise<T[]> {
      const { rows } = await scopedQuery(requireAccountId(), pgSql, params);
      return rows as T[];
    },
    async run(...params: unknown[]): Promise<{ changes: number }> {
      const { rowCount } = await scopedQuery(requireAccountId(), pgSql, params);
      return { changes: rowCount };
    },
  };
}

export const db = {
  prepare(sql: string) {
    return statement(sql);
  },
  exec(sql: string): Promise<void> {
    return scopedExec(requireAccountId(), sql);
  },
};

export async function getProfile(): Promise<import("../shared/types.js").Profile> {
  const existing = await db.prepare(PROFILE_SELECT).get<import("../shared/types.js").Profile>();
  if (existing) return existing;
  // Seed the profile from the account so a name Firebase already knows (a Google
  // display name, or the one chosen at sign-up) is not asked for a second time
  // during onboarding.
  const accountId = requireAccountId();
  const seed = (
    await publicQuery<{ name: string | null; email: string | null }>(
      "SELECT name, email FROM accounts WHERE id = $1",
      [accountId],
    )
  ).rows[0];
  await db
    .prepare("INSERT INTO profile (id, name, email, onboarded, created_at) VALUES (1, ?, ?, 0, ?)")
    .run(seed?.name ?? null, seed?.email ?? null, now());
  return (await db.prepare(PROFILE_SELECT).get<import("../shared/types.js").Profile>())!;
}

const PROFILE_SELECT =
  "SELECT id, name, email, onboarded, created_at, (avatar IS NOT NULL)::int AS has_avatar FROM profile WHERE id = 1";
