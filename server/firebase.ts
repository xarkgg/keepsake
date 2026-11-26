import crypto from "node:crypto";
import { env } from "./env.js";

/**
 * Firebase ID-token verification, done locally against Google's public keys so
 * no service-account secret has to be stored. The client signs in with the
 * Firebase SDK (email/password or Google) and sends the resulting ID token; we
 * confirm it was minted for this project, is unexpired, and is signed by a key
 * Google publishes for signing Firebase tokens.
 */

export interface FirebaseIdentity {
  uid: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
  signInProvider: string | null;
}

interface JwtHeader {
  alg?: string;
  kid?: string;
}

interface FirebaseClaims {
  iss?: string;
  aud?: string;
  sub?: string;
  exp?: number;
  iat?: number;
  email?: string;
  email_verified?: boolean;
  name?: string;
  firebase?: { sign_in_provider?: string; identities?: Record<string, unknown> };
}

const CERT_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
const ALLOWED_ALGS = new Set(["RS256"]);

export const firebaseConfigured = () => env.firebase.enabled && Boolean(env.firebase.projectId);

/** True when the deployment has a site key, so App Check can initialize. */
export const appCheckConfigured = () => firebaseConfigured() && Boolean(env.firebase.appCheckSiteKey);

/** The public web config the client needs; null until every value is present. */
export function firebaseWebConfig() {
  const { projectId, apiKey, authDomain, appId, appCheckSiteKey } = env.firebase;
  if (!firebaseConfigured() || !apiKey || !authDomain || !appId) return null;
  return { projectId, apiKey, authDomain, appId, appCheckSiteKey };
}

let certCache: { at: number; certs: Record<string, string>; ttl: number } | null = null;
let certInflight: Promise<Record<string, string>> | null = null;

function parseMaxAge(header: string | null): number {
  const match = header?.match(/max-age=(\d+)/);
  return match ? Number(match[1]) * 1000 : 60 * 60_000;
}

async function certificateFor(kid: string): Promise<string | null> {
  const now = Date.now();
  if (certCache && now - certCache.at < certCache.ttl) {
    const hit = certCache.certs[kid];
    if (hit) return hit;
  }
  // Collapse concurrent refreshes into one network call.
  certInflight ??= (async () => {
    const response = await fetch(CERT_URL, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Could not load Firebase signing keys (${response.status}).`);
    const certs = (await response.json()) as Record<string, string>;
    certCache = { at: Date.now(), certs, ttl: parseMaxAge(response.headers.get("cache-control")) };
    return certs;
  })();
  try {
    const certs = await certInflight;
    return certs[kid] ?? null;
  } finally {
    certInflight = null;
  }
}

function decodeJson<T>(segment: string): T {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as T;
}

export async function verifyFirebaseIdToken(token: string): Promise<FirebaseIdentity> {
  if (!firebaseConfigured()) throw new Error("Firebase is not configured on this server.");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("That sign-in token is malformed.");

  const header = decodeJson<JwtHeader>(parts[0]);
  const claims = decodeJson<FirebaseClaims>(parts[1]);
  if (!header.alg || !ALLOWED_ALGS.has(header.alg)) throw new Error("Unsupported token algorithm.");
  if (!header.kid) throw new Error("That sign-in token has no key id.");

  const project = env.firebase.projectId;
  const issuer = `https://securetoken.google.com/${project}`;
  if (claims.aud !== project || claims.iss !== issuer) {
    throw new Error("That sign-in token belongs to another project.");
  }
  if (!claims.sub) throw new Error("That sign-in token has no subject.");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now() - 30_000) {
    throw new Error("That sign-in has expired. Try again.");
  }

  const cert = await certificateFor(header.kid);
  if (!cert) throw new Error("Could not verify the sign-in token signature.");
  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  if (!verifier.verify(cert, Buffer.from(parts[2], "base64url"))) {
    throw new Error("The sign-in token signature did not match.");
  }

  const email = String(claims.email ?? "").trim().toLowerCase();
  if (!email) throw new Error("That account has no email address on it.");
  return {
    uid: claims.sub,
    email,
    name: claims.name ?? null,
    emailVerified: claims.email_verified === true,
    signInProvider: claims.firebase?.sign_in_provider ?? null,
  };
}
