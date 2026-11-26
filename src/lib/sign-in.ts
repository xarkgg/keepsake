/**
 * Email/password sign-in with two possible credential stores.
 *
 * When Firebase is configured it is the credential authority for accounts the
 * product registers through the UI. A few accounts exist only in the app's own
 * database though: they were provisioned through the API rather than the
 * sign-up form, and the published demo account is exactly that. Firebase does
 * not know them, so its sign-in fails even though the app can verify the same
 * credentials itself. In that case fall back to the app's own password check
 * rather than telling a person with correct credentials that they are wrong.
 *
 * The fallback only runs after Firebase refused the attempt, and the app's own
 * route verifies a real password hash, so accounts registered through Firebase
 * (which carry no app-side password) still fail there and keep the Firebase
 * error, including "verify your address". Registration never falls back: an
 * address Firebase already has should be signed in with, not re-registered.
 */
export async function signInWithFallback(input: {
  firebaseReady: boolean;
  firebaseSignIn: () => Promise<void>;
  serverSignIn: () => Promise<void>;
}): Promise<"firebase" | "server"> {
  if (!input.firebaseReady) {
    await input.serverSignIn();
    return "server";
  }
  try {
    await input.firebaseSignIn();
    return "firebase";
  } catch (firebaseError) {
    try {
      await input.serverSignIn();
      return "server";
    } catch {
      throw firebaseError;
    }
  }
}
