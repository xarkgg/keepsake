/**
 * The inference boundary. The rest of the app talks to these types only; the
 * one module that imports `firebase/ai` is `firebase-ai.ts`, and it implements
 * the `Engine` interface so tests can inject a fake and assert on behaviour
 * (for example, that Vault Mode never reaches the cloud) without the SDK.
 */

import type { InferenceSource } from "../../../shared/inference.js";

// The two vocabulary types are shared with the store and the privacy core, so
// they are defined once in `shared/` and re-exported here for convenience.
export type { InferenceSource, KeepsakeMode } from "../../../shared/inference.js";

/** On-device model readiness, mirroring Chrome's Prompt API states. */
export type DeviceAvailability =
  | "available"
  | "downloadable"
  | "downloading"
  | "unsupported"
  | "unknown";

/** The result of one inference call, with the receipt that goes with it. */
export interface InferenceResult {
  text: string;
  source: InferenceSource;
  /** The model that produced it, e.g. "gemini-nano" or "gemini-4-hydrogen". */
  model: string;
}

/** What the caller asks the engine for. */
export interface GenerateOptions {
  /** On-device model download progress, 0..1. */
  onProgress?: (progress: number) => void;
  /** Cloud model name; ignored for on-device. */
  model?: string;
}

/** The engine's own report of where a piece of text came from. */
export interface EngineResult {
  text: string;
  /** The SDK's raw `inferenceSource`, if it reported one. */
  reportedSource?: "on_device" | "in_cloud";
}

/**
 * A model backend. Keepsake has exactly one real implementation (Firebase AI
 * Logic); the interface exists so the mode logic above it is testable.
 */
export interface Engine {
  /** Is the on-device model usable on this device right now? */
  availability(): Promise<DeviceAvailability>;
  /** Prepare the on-device model (may download). Must follow a user gesture. */
  initializeDeviceModel(onProgress?: (progress: number) => void): Promise<void>;
  /** Run one generation, strictly on-device or strictly in the cloud. */
  generate(where: "on-device" | "cloud", prompt: string, options?: GenerateOptions): Promise<EngineResult>;
}

/** Where cloud requests are sent; part of what a consent is bound to. */
export const CLOUD_DESTINATION_PREFIX = "firebase-ai-logic";

/**
 * How the cloud AI service must be built.
 *
 * With App Check replay protection on, which the AI Logic setup turns on, a
 * normal App Check token is answered `401 Firebase App Check token is invalid`
 * even though attestation succeeded, because only a single-use token is
 * accepted. `useLimitedUseAppCheckTokens` makes the SDK mint one per request.
 */
export const CLOUD_AI_SETUP = { useLimitedUseAppCheckTokens: true } as const;

/** Default cloud model used for the request and its consent destination. */
export const DEFAULT_CLOUD_MODEL = "gemini-3.5-flash-lite";

/** Timeout for one cloud attempt, in milliseconds. */
export const CLOUD_REQUEST_TIMEOUT_MS = 12_000;

/** The label shown for the on-device model. */
export const ON_DEVICE_MODEL_LABEL = "gemini-nano";
