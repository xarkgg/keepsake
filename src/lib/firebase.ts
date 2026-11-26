import { api, ApiError } from "./api";

/**
 * Firebase sign-in. The SDK is loaded on demand, `import()` keeps it in its own
 * chunk, so the app shell does not carry it and it is only fetched when someone
 * actually signs in. The server verifies the ID token this client returns.
 */

export interface FirebaseWebConfig {
  projectId: string;
  apiKey: string;
  authDomain: string;
  appId: string;
  /** App Check's reCAPTCHA Enterprise site key, when the deployment has one. */
  appCheckSiteKey?: string;
}

type AuthModule = typeof import("firebase/auth");
type AppCheckModule = typeof import("firebase/app-check");
type FirebaseAuth = import("firebase/auth").Auth;
type FirebaseApp = import("firebase/app").FirebaseApp;
type LoadedSdk = { app: FirebaseApp; auth: FirebaseAuth; authModule: AuthModule };

let config: FirebaseWebConfig | null = null;
let sdkPromise: Promise<LoadedSdk> | null = null;
let appCheckPromise: Promise<boolean> | null = null;
let cloudAppPromise: Promise<FirebaseApp> | null = null;

/** Record the public web config from /api/auth/config. Does not load the SDK. */
export function configureFirebase(next: FirebaseWebConfig | null): void {
  config = next;
  // A new config means a new app (sign-out then sign-in), so App Check must be
  // initialized again against it rather than reusing a stale instance.
  appCheckPromise = null;
  cloudAppPromise = null;
}

/** True once the server has provided a Firebase config, so sign-in routes there. */
export function firebaseReady(): boolean {
  return config !== null;
}

function loadSdk(): Promise<LoadedSdk> {
  if (sdkPromise) return sdkPromise;
  const current = config;
  if (!current) return Promise.reject(new Error("Sign-in is still starting up. Try again in a moment."));
  sdkPromise = (async () => {
    const [{ initializeApp }, authModule] = await Promise.all([
      import("firebase/app"),
      import("firebase/auth"),
    ]);
    const app = initializeApp(current);
    const auth = authModule.getAuth(app);
    return { app, auth, authModule };
  })();
  // A failed load should be retryable rather than cached forever.
  sdkPromise.catch(() => {
    sdkPromise = null;
  });
  return sdkPromise;
}

/**
 * The shared Firebase app, for Firebase AI Logic. `initializeApp` is idempotent
 * for a given config, but going through this loader means AI Logic and Auth use
 * the exact same app instance and the config is read from one place.
 */
export async function getFirebaseApp(): Promise<FirebaseApp> {
  return (await loadSdk()).app;
}

/**
 * A second Firebase app, used only for cloud inference.
 *
 * This exists because of how the AI SDK resolves App Check: the service is
 * built once per app and asks for the App Check provider *at that moment*, then
 * keeps whatever it found forever. Vault Mode builds that service on the main
 * app every time it tries the on-device model, and Hybrid Mode always tries the
 * device before the cloud, so on a shared app the cloud service would be built
 * while App Check was still uninitialised and would never attach a token, and
 * the API rejects every such request as unattested.
 *
 * Two apps make the ordering impossible to get wrong, and leave the main app
 * free of App Check entirely, so Vault Mode still makes no network call at all.
 */
const CLOUD_APP_NAME = "keepsake-inference";

export async function getCloudFirebaseApp(): Promise<FirebaseApp> {
  const current = config;
  if (!current) throw new Error("Sign-in is still starting up. Try again in a moment.");
  cloudAppPromise ??= (async () => {
    const { initializeApp, getApps, deleteApp } = await import("firebase/app");
    const existing = getApps().find((app) => app.name === CLOUD_APP_NAME);
    // Re-initializing the same name keeps the old options, so a config change
    // (sign out, then sign in to a different project) disposes the stale app.
    if (existing && existing.options.apiKey !== current.apiKey) await deleteApp(existing);
    return initializeApp(current, CLOUD_APP_NAME);
  })();
  cloudAppPromise.catch(() => {
    cloudAppPromise = null;
  });
  return cloudAppPromise;
}

/** Initialise App Check before using the cloud AI service. Sign-in does not depend on it. */
export async function ensureAppCheck(): Promise<boolean> {
  if (appCheckPromise) return appCheckPromise;
  appCheckPromise = (async () => {
    const siteKey = config?.appCheckSiteKey;
    if (!siteKey) return false;
    try {
      const app = await getCloudFirebaseApp();
      const appCheckModule = (await import("firebase/app-check")) as AppCheckModule;
      const { ReCaptchaEnterpriseProvider, initializeAppCheck } = appCheckModule;
      initializeAppCheck(app, {
        provider: new ReCaptchaEnterpriseProvider(siteKey),
        isTokenAutoRefreshEnabled: true,
      });
      return true;
    } catch {
      return false;
    }
  })();
  appCheckPromise.catch(() => {
    appCheckPromise = null;
  });
  return appCheckPromise;
}

/** Exchange a fresh Firebase ID token for the Keepsake session cookie. */
async function exchangeSession(auth: FirebaseAuth): Promise<void> {
  const user = auth.currentUser;
  if (!user) throw new Error("Firebase did not return a user.");
  const idToken = await user.getIdToken(true);
  try {
    await api("/api/auth/firebase", {
      method: "POST",
      body: JSON.stringify({ idToken }),
    });
  } catch (error) {
    // An unverified email on a brand-new account is not a failure to hide: the
    // verification mail is already on its way, so say what to do next.
    if (error instanceof ApiError && /verify that email/i.test(error.message)) {
      throw new Error("We sent a verification link to your email. Open it, then sign in.");
    }
    throw error;
  }
}

export async function firebaseSignUp(input: { email: string; password: string; name: string }): Promise<void> {
  const { auth, authModule } = await loadSdk();
  const credential = await authModule.createUserWithEmailAndPassword(auth, input.email.trim(), input.password);
  const name = input.name.trim();
  if (name) {
    await authModule.updateProfile(credential.user, { displayName: name });
    await credential.user.getIdToken(true);
  }
  // Firebase only treats an email/password address as verified after the link
  // in this mail is opened, and the server will not create an account for an
  // unverified address, so send it before the first exchange.
  await authModule.sendEmailVerification(credential.user).catch(() => undefined);
  await exchangeSession(auth);
}

export async function firebaseSignInWithPassword(email: string, password: string): Promise<void> {
  const { auth, authModule } = await loadSdk();
  await authModule.signInWithEmailAndPassword(auth, email.trim(), password);
  await exchangeSession(auth);
}

export async function firebaseSignInWithGoogle(): Promise<void> {
  const { auth, authModule } = await loadSdk();
  const provider = new authModule.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  if (shouldUseRedirect()) {
    // The page navigates away; `consumeGoogleRedirect` finishes the job on the
    // way back in.
    rememberRedirect();
    await authModule.signInWithRedirect(auth, provider);
    return;
  }
  await authModule.signInWithPopup(auth, provider, authModule.browserPopupRedirectResolver);
  await exchangeSession(auth);
}

/**
 * Get the Firebase SDK downloading before anyone clicks Google.
 *
 * `signInWithPopup` only works while the click is still "live": the browser
 * refuses `window.open` once the gesture has been spent. Loading the SDK lazily
 * *inside* the click handler meant the first tap on a phone did a network
 * round-trip first, so the popup never opened and Firebase reported
 * `auth/internal-error`. Warming it when the sign-in screen appears removes
 * that await from the gesture.
 */
export function preloadFirebaseAuth(): void {
  if (!config) return;
  void loadSdk().catch(() => undefined);
}

/** Whether to use a full-page redirect rather than a popup.
 *
 * Chrome on Android opens popups as a separate tab with no usable
 * `window.opener`, so the popup resolver can never read the result. Mobile
 * WebKit has the same problem. Those platforms get the redirect flow, which
 * does not depend on a window relationship at all.
 */
export function shouldUseRedirect(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return true;
  return Boolean(window.matchMedia?.("(display-mode: standalone)").matches);
}

/**
 * Marker so a normal visit to the sign-in page does not pay to load the SDK
 * just to ask "was anyone returning from Google?".
 */
const REDIRECT_FLAG = "keepsake.google.redirect";

function rememberRedirect(): void {
  try {
    sessionStorage.setItem(REDIRECT_FLAG, "1");
  } catch {
    // Private modes can refuse storage; the flow still works, it just re-checks.
  }
}

function hasRedirectFlag(): boolean {
  try {
    return sessionStorage.getItem(REDIRECT_FLAG) === "1";
  } catch {
    return false;
  }
}

function clearRedirectFlag(): void {
  try {
    sessionStorage.removeItem(REDIRECT_FLAG);
  } catch {
    // Nothing to clear.
  }
}

/**
 * Finish a Google sign-in that used a redirect. Returns true when the visitor
 * has just come back from Google and the Keepsake session cookie was exchanged.
 */
export async function consumeGoogleRedirect(): Promise<boolean> {
  if (!config) return false;
  if (!hasRedirectFlag()) return false;
  const { auth, authModule } = await loadSdk();
  const credential = await authModule.getRedirectResult(auth);
  clearRedirectFlag();
  if (!credential?.user) return false;
  await exchangeSession(auth);
  return true;
}

export async function firebaseSignOut(): Promise<void> {
  // Only meaningful if the SDK was actually loaded this session.
  if (!config || !sdkPromise) return;
  const { auth, authModule } = await sdkPromise;
  await authModule.signOut(auth);
}
