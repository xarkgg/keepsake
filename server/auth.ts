import crypto from "node:crypto";
import { promisify } from "node:util";
import type { Request, Response } from "express";
import { env } from "./env.js";
import { publicQuery, publicTransaction, toPgPlaceholders } from "./pg.js";

const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

export const SESSION_COOKIE = "keepsake_session";
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

export interface Account {
  id: string;
  email: string;
  name: string | null;
  created_at: string;
  last_login_at?: string | null;
  firebase_uid?: string | null;
  /**
   * Whether the account has a password of its own. False for accounts that
   * only ever signed in through Firebase (Google or Firebase email/password),
   * where Firebase owns the credential. The Settings UI uses this to offer
   * "add a password" instead of a change-password form it could never satisfy.
   */
  has_password?: boolean;
}

export const now = () => new Date().toISOString();
export const uid = () => crypto.randomUUID();

async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await publicQuery<T>(toPgPlaceholders(sql), params);
  return rows;
}

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await query<T>(sql, params))[0];
}

export function normalizeEmail(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().slice(0, 254);
}

export function emailProblem(email: string): string | null {
  if (!email) return "Email is required.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "That does not look like an email address.";
  return null;
}

export function passwordProblem(password: string): string | null {
  if (password.length < 10) return "Use at least 10 characters.";
  if (password.length > 200) return "That password is too long.";
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return "Use at least one letter and one number.";
  }
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  if (!salt.length || !expected.length) return false;
  try {
    const key = await scrypt(password, salt, expected.length);
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function countUsers(): Promise<number> {
  const row = await one<{ n: string | number }>("SELECT COUNT(*) AS n FROM accounts");
  return Number(row?.n ?? 0);
}

export async function signupsOpen(): Promise<boolean> {
  return env.signups === "open" || (await countUsers()) === 0;
}

export async function findUserByEmail(email: string): Promise<(Account & { password_hash: string | null }) | undefined> {
  return one<Account & { password_hash: string | null }>(
    "SELECT id, email, name, password_hash, created_at, last_login_at, firebase_uid FROM accounts WHERE lower(email) = lower(?)",
    [email],
  );
}

export async function findUserByFirebaseUid(uid: string): Promise<Account | undefined> {
  return one<Account>("SELECT id, email, name, created_at, last_login_at FROM accounts WHERE firebase_uid = ?", [uid]);
}

/**
 * Sign in (or first-time provision) an account from a verified Firebase
 * identity. Firebase is the credential authority, so there is no password.
 *
 * `emailVerified` comes from the ID token's `email_verified` claim. It gates
 * every transition that trusts the email address: linking a Firebase identity
 * onto an existing password account, and creating a new account. Without that
 * gate an attacker could register an unverified Firebase account for someone
 * else's address and have their uid attached to that person's Keepsake account.
 * An identity whose uid is already known is returned as-is so its owner is not
 * locked out (for example after changing the address in Firebase).
 */
export async function upsertFirebaseUser(identity: {
  uid: string;
  email: string;
  name?: string | null;
  emailVerified?: boolean;
}): Promise<Account> {
  const email = normalizeEmail(identity.email);
  const issue = emailProblem(email);
  if (issue) throw new Error(issue);
  const emailVerified = identity.emailVerified === true;

  let row = await findUserByFirebaseUid(identity.uid);
  const linkedEmail = await findUserByEmail(email);
  const firstName = String(identity.name ?? "").trim().slice(0, 60) || null;

  if (!row && linkedEmail) {
    // Same email already present (for example password sign-up, then Google).
    // Attach the Firebase uid to that account rather than duplicating it, but
    // only when Firebase vouches that the person controls this address.
    if (!emailVerified) {
      throw new Error("Verify that email address before signing in with it.");
    }
    if (linkedEmail.firebase_uid && linkedEmail.firebase_uid !== identity.uid) {
      throw new Error("That email is already linked to another sign-in.");
    }
    await query("UPDATE accounts SET firebase_uid = ?, last_login_at = ? WHERE id = ?", [
      identity.uid,
      now(),
      linkedEmail.id,
    ]);
    row = (await getAccount(linkedEmail.id)) ?? undefined;
  } else if (row) {
    await query("UPDATE accounts SET last_login_at = ?, email = ?, name = COALESCE(?, name) WHERE id = ?", [
      now(),
      email,
      firstName,
      row.id,
    ]).catch((error: unknown) => {
      if (String((error as Error).message).includes("duplicate")) {
        throw new Error("An account with that email already exists.");
      }
      throw error;
    });
    row = (await getAccount(row.id)) ?? undefined;
  }

  if (!row) {
    if (!emailVerified) {
      throw new Error("Verify that email address before creating a Keepsake account.");
    }
    const id = uid();
    const at = now();
    await query(
      "INSERT INTO accounts (id, email, name, password_hash, created_at, last_login_at, firebase_uid) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, email, firstName, null, at, at, identity.uid],
    ).catch((error: unknown) => {
      if (String((error as Error).message).includes("duplicate")) {
        throw new Error("An account with that email already exists.");
      }
      throw error;
    });
    row = await getAccount(id);
  }

  if (!row) throw new Error("Account could not be created.");
  return row;
}

export async function getAccount(userId: string): Promise<Account | undefined> {
  return one<Account>("SELECT id, email, name, created_at, last_login_at FROM accounts WHERE id = ?", [userId]);
}

export async function createUser(input: {
  email: string;
  password: string;
  name?: string;
}): Promise<{ account: Account; first: boolean }> {
  const email = normalizeEmail(input.email);
  const emailIssue = emailProblem(email);
  if (emailIssue) throw new Error(emailIssue);
  const passwordIssue = passwordProblem(input.password);
  if (passwordIssue) throw new Error(passwordIssue);
  if (await findUserByEmail(email)) throw new Error("An account with that email already exists.");
  if (!(await signupsOpen())) throw new Error("Sign-ups are closed on this server.");

  const id = uid();
  const at = now();
  const hash = await hashPassword(input.password);

  // The "first account is always allowed" rule is a state transition, so the
  // count check and the insert must be one atomic step. An advisory lock
  // serialises concurrent registrations across serverless instances; otherwise
  // two first-time sign-ups could both observe zero accounts and both win.
  return publicTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [700_123_456]);
    const { rows: countRows } = await client.query("SELECT COUNT(*) AS n FROM accounts");
    const first = Number(countRows[0]?.n ?? 0) === 0;
    if (!first && env.signups !== "open") throw new Error("Sign-ups are closed on this server.");
    const dupe = await client.query("SELECT id FROM accounts WHERE lower(email) = lower($1)", [email]);
    if (dupe.rows.length) throw new Error("An account with that email already exists.");
    try {
      await client.query(
        "INSERT INTO accounts (id, email, name, password_hash, created_at, last_login_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [id, email, String(input.name ?? "").trim().slice(0, 60) || null, hash, at, null],
      );
    } catch (error) {
      if (String((error as Error).message).includes("duplicate")) {
        throw new Error("An account with that email already exists.");
      }
      throw error;
    }

    const { rows } = await client.query("SELECT id, email, name, created_at, last_login_at, firebase_uid FROM accounts WHERE id = $1", [id]);
    const account = rows[0] as unknown as Account | undefined;
    if (!account) throw new Error("Account could not be created.");
    return { account, first };
  });
}

export async function authenticate(email: string, password: string): Promise<Account | null> {
  const user = await findUserByEmail(normalizeEmail(email));
  if (!user || !user.password_hash) {
    // Keep the timing similar to a real check without leaking existence, and
    // cover accounts that only have a Firebase identity (no password).
    await verifyPassword(
      password,
      `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${crypto.randomBytes(16).toString("base64url")}$${crypto.randomBytes(64).toString("base64url")}`,
    );
    return null;
  }
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return null;
  await query("UPDATE accounts SET last_login_at = ? WHERE id = ?", [now(), user.id]);
  return (await getAccount(user.id)) ?? null;
}

export async function updatePassword(userId: string, hash: string): Promise<void> {
  await query("UPDATE accounts SET password_hash = ? WHERE id = ?", [hash, userId]);
}

export async function deleteAccount(userId: string): Promise<void> {
  await query("DELETE FROM sessions WHERE account_id = ?", [userId]);
  await query("DELETE FROM accounts WHERE id = ?", [userId]);
}

export async function createSession(userId: string, userAgent?: string): Promise<{ token: string; expiresAt: string }> {
  const token = crypto.randomBytes(32).toString("base64url");
  const at = now();
  const expires = new Date(Date.now() + Math.max(1, env.sessionDays) * 86_400_000).toISOString();
  await query(
    "INSERT INTO sessions (token_hash, account_id, user_agent, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    [hashToken(token), userId, String(userAgent ?? "").slice(0, 300), at, expires],
  );
  return { token, expiresAt: expires };
}

export async function sessionAccount(token: string | undefined): Promise<Account | undefined> {
  if (!token) return undefined;
  const hashed = hashToken(token);
  const row = await one<Account & { expires_at: string; has_password: boolean }>(
    `SELECT a.id, a.email, a.name, a.created_at, a.last_login_at,
            (a.password_hash IS NOT NULL) AS has_password, s.expires_at
     FROM sessions s JOIN accounts a ON a.id = s.account_id
     WHERE s.token_hash = ?`,
    [hashed],
  );
  if (!row) return undefined;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await query("DELETE FROM sessions WHERE token_hash = ?", [hashed]);
    return undefined;
  }
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    created_at: row.created_at,
    last_login_at: row.last_login_at,
    has_password: Boolean(row.has_password),
  };
}

export async function deleteSession(token: string | undefined): Promise<void> {
  if (!token) return;
  await query("DELETE FROM sessions WHERE token_hash = ?", [hashToken(token)]);
}

export async function deleteUserSessions(userId: string): Promise<void> {
  await query("DELETE FROM sessions WHERE account_id = ?", [userId]);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      out[key] = part.slice(index + 1).trim();
    }
  }
  return out;
}

export function requestToken(req: Request): string | undefined {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE];
}

export function wantsSecureCookie(req: Request): boolean {
  if (env.cookieSecure === "always") return true;
  if (env.cookieSecure === "never") return false;
  return req.secure;
}

export function setSessionCookie(req: Request, res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: wantsSecureCookie(req),
    path: "/",
    maxAge: Math.max(1, env.sessionDays) * 86_400_000,
  });
}

export function clearSessionCookie(req: Request, res: Response): void {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: "lax",
    secure: wantsSecureCookie(req),
    path: "/",
  });
}

/**
 * Login attempts live in Postgres so brute-force protection holds across the
 * many short-lived instances a serverless host starts.
 */
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 10;

export async function loginAllowed(key: string): Promise<boolean> {
  const row = await one<{ count: number | string; reset_at: string }>(
    "SELECT count, reset_at FROM login_attempts WHERE key = ?",
    [key],
  );
  if (!row) return true;
  if (new Date(row.reset_at).getTime() < Date.now()) return true;
  return Number(row.count) < MAX_ATTEMPTS;
}

export async function recordLoginFailure(key: string): Promise<void> {
  const resetAt = new Date(Date.now() + WINDOW_MS).toISOString();
  await query(
    `INSERT INTO login_attempts (key, count, reset_at) VALUES (?, 1, ?)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN login_attempts.reset_at < ? THEN 1 ELSE login_attempts.count + 1 END,
       reset_at = CASE WHEN login_attempts.reset_at < ? THEN ? ELSE login_attempts.reset_at END`,
    [key, resetAt, new Date().toISOString(), new Date().toISOString(), resetAt],
  );
}

export async function clearLoginFailures(key: string): Promise<void> {
  await query("DELETE FROM login_attempts WHERE key = ?", [key]);
}
