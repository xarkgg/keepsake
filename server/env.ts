import fs from "node:fs";
import path from "node:path";

// Load .env if present. Real environment variables keep priority.
const envFile = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch (error) {
    console.warn("[env] could not read .env:", error instanceof Error ? error.message : error);
  }
}

const dataDir = process.env.KEEPSAKE_DATA_DIR
  ? path.resolve(process.env.KEEPSAKE_DATA_DIR)
  : path.resolve(process.cwd(), "data");

const isProd = process.env.NODE_ENV === "production";
const host = process.env.HOST ?? (isProd ? "0.0.0.0" : "127.0.0.1");

/**
 * Vercel sets `VERCEL=1` and `VERCEL_URL`/`VERCEL_ENV` on every deployment. A
 * serverless function has an ephemeral, per-instance filesystem, so the
 * embedded PGlite fallback there is not a database, it is a fresh empty copy
 * on every invocation. Production must therefore point at a real server, and
 * the standard Managed Postgres variables are accepted so a Marketplace
 * integration works without renaming anything.
 */
const isServerless = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);

/**
 * A Postgres connection string, in priority order: Keepsake's own variable
 * first, then the conventional names the Vercel Postgres / Neon integration
 * injects (`DATABASE_URL`, `POSTGRES_URL`, `POSTGRES_PRISMA_URL`,
 * `POSTGRES_URL_NON_POOLING`). Without one of these, production silently loses
 * data, so the server refuses to start that way (see `createBackend`).
 */
const databaseUrl =
  process.env.KEEPSAKE_DATABASE_URL ||
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  process.env.POSTGRES_URL_NON_POOLING ||
  "";

/**
 * The public origin. `KEEPSAKE_PUBLIC_URL` is authoritative; otherwise Vercel's
 * production domain (`VERCEL_PROJECT_PRODUCTION_URL`) or the per-deployment
 * host (`VERCEL_URL`) is promoted to https, and localhost covers development.
 * A trailing slash is always stripped.
 */
const publicUrl =
  process.env.KEEPSAKE_PUBLIC_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : `http://localhost:${process.env.PORT ?? 8787}`);

export const env = {
  port: Number(process.env.PORT ?? 8787),
  // A container needs to listen on all interfaces. Development stays loopback
  // so an accidental `npm run dev` is not reachable from the network.
  host,
  dataDir,
  databaseUrl,
  isServerless,
  pgliteDir: process.env.KEEPSAKE_PGLITE_DIR ?? path.join(dataDir, "pglite"),
  publicUrl: publicUrl.replace(/\/+$/, ""),
  sessionDays: Number(process.env.KEEPSAKE_SESSION_DAYS ?? 30),
  cookieSecure: (process.env.KEEPSAKE_COOKIE_SECURE ?? "auto") as "auto" | "always" | "never",
  trustProxy: process.env.KEEPSAKE_TRUST_PROXY === "1",
  signups: (process.env.KEEPSAKE_SIGNUPS ?? "open") as "open" | "closed",
  // Password changes and account deletion are disabled for these addresses.
  demoAccounts: (process.env.KEEPSAKE_DEMO_ACCOUNTS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
  // Firebase Authentication. When a project id is set, the app signs users in
  // through Firebase (email/password and Google) and the server verifies the
  // resulting ID token. The web config values are public by design. The same
  // project backs Firebase AI Logic on the client, so a configured project is
  // what tells the client whether cloud inference is available at all.
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID ?? "",
    apiKey: process.env.FIREBASE_API_KEY ?? "",
    authDomain: process.env.FIREBASE_AUTH_DOMAIN ?? "",
    appId: process.env.FIREBASE_APP_ID ?? "",
    enabled: (process.env.FIREBASE_AUTH_ENABLED ?? "1") !== "0",
    // Public site key used by the client to initialise App Check for cloud inference.
    appCheckSiteKey: process.env.FIREBASE_APPCHECK_SITE_KEY ?? "",
  },
  isProd,
} as const;

export const APP_NAME = "Keepsake";
