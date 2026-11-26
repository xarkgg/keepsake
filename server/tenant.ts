import { dropAccountSchema, runWithAccount } from "./pg.js";
import { initializeSchema } from "./schema.js";

export { currentAccountId, requireAccountId } from "./pg.js";
export { runWithAccount } from "./pg.js";

// Each process remembers which account schemas it has already prepared, so the
// per-request path does not re-run DDL on every call.
const initialized = new Set<string>();

export async function ensureTenant(accountId: string): Promise<void> {
  if (initialized.has(accountId)) return;
  await initializeSchema(accountId);
  initialized.add(accountId);
}

/**
 * Run work inside one account's schema. `db` calls made anywhere inside `fn`
 * (including deeper awaits) resolve against that account only.
 */
export async function runWithTenant<T>(accountId: string, fn: () => T): Promise<T> {
  await ensureTenant(accountId);
  return runWithAccount(accountId, fn);
}

export async function removeTenantData(accountId: string): Promise<void> {
  initialized.delete(accountId);
  await dropAccountSchema(accountId);
}
