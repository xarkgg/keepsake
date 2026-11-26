import type { IncomingMessage, ServerResponse } from "node:http";
import { app } from "../server/index.js";
import { env } from "../server/env.js";
import { databaseEnvNames, initDatabase } from "../server/pg.js";

/** Strip credentials from any connection string quoted in an error message. */
function redact(message: string): string {
  return message.replace(/(postgres(?:ql)?:\/\/)[^@\s]*@/gi, "$1***@");
}

/**
 * Vercel Function entry. The Express app handles every `/api/*` request; the
 * frontend is served as static files from `dist`.
 *
 * `initDatabase` is memoized so the first request connects Postgres.
 */
let ready: Promise<void> | null = null;

function ensureReady(): Promise<void> {
  if (!ready) ready = initDatabase();
  return ready;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await ensureReady();
  } catch (error) {
    // The database is the one thing that cannot degrade gracefully: without it
    // there is no account or session. Say exactly what is wrong instead of
    // returning an opaque 500 to every request.
    const message = error instanceof Error ? error.message : String(error);
    // An empty URL and an unreachable database are different faults and need
    // different fixes, so report which one this is. The detail (host, TLS,
    // auth failure) is only exposed when KEEPSAKE_DEBUG=1.
    const configured = Boolean(env.databaseUrl);
    console.error("[api] database unavailable:", message);
    res.statusCode = 503;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        error: configured
          ? "Keepsake cannot reach its Postgres database. Check the connection string and that the database is awake."
          : "Keepsake has no database connection. On Vercel, connect the Postgres or Supabase integration to Production and redeploy, or set KEEPSAKE_DATABASE_URL.",
        code: configured ? "DATABASE_UNREACHABLE" : "NO_DATABASE",
        envNames: databaseEnvNames(),
        ...(process.env.KEEPSAKE_DEBUG === "1" ? { detail: redact(message) } : {}),
      }),
    );
    return;
  }
  app(req, res);
}
