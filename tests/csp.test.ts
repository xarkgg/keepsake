import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { contentSecurityPolicy } from "../server/csp.js";

/**
 * The production CSP is the one place where a missing origin breaks a feature
 * silently: the browser blocks the request and the server never sees it, so
 * there is no error to notice. These pin the origins cloud inference actually
 * needs.
 */

test("a bare deployment allows only same-origin", () => {
  const csp = contentSecurityPolicy({ firebase: false, appCheck: false });
  assert.match(csp, /connect-src 'self';/);
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /frame-src 'none';/);
});

test("cloud inference can reach the AI Logic proxy gateway", () => {
  // firebasevertexai.googleapis.com is the SDK's hardcoded DEFAULT_DOMAIN. If
  // this origin is absent every cloud request is blocked by the browser, even
  // with App Check correctly configured, the failure looks like "nothing
  // happens" and produces no server log.
  const csp = contentSecurityPolicy({ firebase: true, appCheck: true });
  const connect = csp.match(/connect-src ([^;]+);/)?.[1] ?? "";
  assert.ok(
    connect.includes("https://firebasevertexai.googleapis.com"),
    `connect-src must allow the AI Logic gateway, got: ${connect}`,
  );
});

test("the Google popup flow can load gapi", () => {
  // signInWithPopup loads https://apis.google.com/js/api.js to size and message
  // the auth-handler iframe. Blocking it makes the popup resolver reject with
  // `auth/internal-error`, which reads like a Firebase console mistake but is
  // the browser refusing the script. This is exactly how it broke once.
  const csp = contentSecurityPolicy({ firebase: true, appCheck: true });
  const script = csp.match(/script-src ([^;]+);/)?.[1] ?? "";
  assert.ok(script.includes("https://apis.google.com"), `script-src must allow gapi, got: ${script}`);
  // A deployment without Firebase has no popup to run, so it stays narrower.
  const bare = contentSecurityPolicy({ firebase: false, appCheck: false });
  assert.ok(!(bare.match(/script-src ([^;]+);/)?.[1] ?? "").includes("apis.google.com"));
});

test("vercel.json serves exactly the policy this module computes", () => {
  // On Vercel the document is served by the platform, so `vercel.json`, not
  // Express middleware, is what the browser actually receives. The two
  // drifting apart means production quietly runs a different policy than the
  // one under test, which is how the gapi blockage shipped.
  const config = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../vercel.json"), "utf8")) as {
    headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  };
  const entries = (config.headers ?? []).flatMap((rule) => rule.headers ?? []);
  const served = entries.find((header) => header.key.toLowerCase() === "content-security-policy")?.value;
  assert.ok(served, "vercel.json must declare a Content-Security-Policy header");
  assert.equal(served, contentSecurityPolicy({ firebase: true, appCheck: true }));
});

test("sign-in and App Check origins are allowed, and are origin-scoped", () => {
  const csp = contentSecurityPolicy({ firebase: true, appCheck: true });
  const connect = csp.match(/connect-src ([^;]+);/)?.[1] ?? "";
  for (const origin of [
    "https://identitytoolkit.googleapis.com",
    "https://securetoken.googleapis.com",
    "https://content-firebaseappcheck.googleapis.com",
    "https://recaptchaenterprise.googleapis.com",
  ]) {
    assert.ok(connect.includes(origin), `connect-src must include ${origin}`);
  }
  // The reCAPTCHA frames are path-scoped rather than the whole google.com host.
  const frame = csp.match(/frame-src ([^;]+);/)?.[1] ?? "";
  assert.ok(frame.includes("https://www.google.com/recaptcha/"), "reCAPTCHA frame scoped to its path");
  assert.ok(!frame.includes("'unsafe-inline'"), "CSP must not allow inline frames");
});

test("App Check's script and frame allowances appear only when App Check is on", () => {
  const withAppCheck = contentSecurityPolicy({ firebase: true, appCheck: true });
  assert.ok(withAppCheck.includes("https://www.gstatic.com/recaptcha/"));
  const noAppCheck = contentSecurityPolicy({ firebase: true, appCheck: false });
  assert.ok(!noAppCheck.includes("gstatic.com"), "no reCAPTCHA script origin without App Check");
  assert.ok(!noAppCheck.includes("recaptchaenterprise"), "no App Check origin without App Check");
});

test("the emoji face is allowed as an inlined data URI font", () => {
  // Vite inlines the ~1.7 kB EmoticonesTityly face into the CSS as a
  // `data:font/woff2` URI. `font-src 'self'` does not cover the data scheme, so
  // without this the agent's :shortcodes: silently fall back to a normal face
  // in production, a failure the server never sees.
  const csp = contentSecurityPolicy({ firebase: false, appCheck: false });
  const fonts = csp.match(/font-src ([^;]+);/)?.[1] ?? "";
  assert.ok(fonts.includes("data:"), `font-src must allow data: fonts, got: ${fonts}`);
});

test("the policy always anchors itself", () => {
  for (const config of [
    { firebase: false, appCheck: false },
    { firebase: true, appCheck: false },
    { firebase: true, appCheck: true },
  ]) {
    const csp = contentSecurityPolicy(config);
    assert.ok(csp.includes("frame-ancestors 'none'"), "clickjacking is always refused");
    assert.ok(csp.includes("base-uri 'self'"), "base tag is always pinned");
    assert.ok(csp.includes("object-src") === false, "no obsolete object-src allowance");
  }
});
