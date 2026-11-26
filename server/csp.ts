/**
 * The production Content-Security-Policy, as a pure function of what the
 * deployment has configured.
 *
 * It lives in its own module so it can be unit-tested without booting the
 * server. That matters: a missing origin here silently blocks a request in the
 * browser, cloud inference failing with no server-side error at all, so this
 * is exactly the kind of break a test should catch rather than a person.
 *
 * What each allowance is for:
 * - Firebase sign-in calls the identity endpoints and opens the Google popup.
 * - Firebase AI Logic calls its own proxy gateway, `firebasevertexai.googleapis.com`
 *   is the `DEFAULT_DOMAIN` the SDK hardcodes, and App Check exchanges its
 *   token with the App Check API. Both are required for a cloud request to
 *   leave the page.
 * - The Google popup flow loads `gapi` from `apis.google.com` to size and
 *   message its iframe. That script is not optional: when it is blocked the
 *   popup resolver rejects with `auth/internal-error`, which reads like a
 *   Firebase misconfiguration but is the browser refusing the download.
 * - reCAPTCHA Enterprise loads a Google script and may frame the widget; the
 *   allowance is path-scoped so it stays narrow.
 */
export function contentSecurityPolicy(input: { firebase: boolean; appCheck: boolean }): string {
  const connect = input.firebase
    ? `'self' https://firebasevertexai.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com${
        input.appCheck
          ? " https://content-firebaseappcheck.googleapis.com https://recaptchaenterprise.googleapis.com https://www.google.com/recaptcha/"
          : ""
      }`
    : "'self'";
  const script = [
    "'self'",
    // gapi is loaded by the Google popup flow inside the auth handler frame.
    input.firebase ? "https://apis.google.com" : "",
    input.appCheck ? "https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const frame = input.firebase
    ? `https://*.firebaseapp.com https://accounts.google.com${
        input.appCheck ? " https://www.google.com/recaptcha/ https://recaptcha.google.com/recaptcha/" : ""
      }`
    : "'none'";
  return `default-src 'self'; img-src 'self' data: blob: https://*.googleusercontent.com; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src ${script}; connect-src ${connect}; frame-src ${frame}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`;
}
