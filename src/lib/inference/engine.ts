/**
 * The engine factory. One place builds the live Firebase AI Logic engine so the
 * on-device model is prepared once per session rather than per request, and so
 * nothing else in the app has to know how the engine is constructed.
 *
 * Resolution is lazy: the Firebase app is only asked for once an inference
 * actually runs (the SDK is loaded on demand), and the result is remembered.
 */

import { getFirebaseApp } from "../firebase.js";
import { FirebaseAiEngine } from "./firebase-ai.js";
import { InferenceError } from "./errors.js";
import type { Engine } from "./types.js";

let enginePromise: Promise<Engine> | null = null;

/**
 * The shared engine. Rejects with a clear message when Firebase is not
 * configured, which is the honest answer: without a Firebase project there is
 * no inference path at all, on-device or cloud.
 */
export function getEngine(): Promise<Engine> {
  enginePromise ??= (async () => {
    const app = await getFirebaseApp();
    return new FirebaseAiEngine(app);
  })();
  enginePromise.catch(() => {
    // A failed setup (Firebase still starting up) must be retryable.
    enginePromise = null;
  });
  return enginePromise;
}

/** Drop the shared engine, e.g. on sign-out so next sign-in re-resolves it. */
export function resetEngine(): void {
  enginePromise = null;
}

export { InferenceError };
