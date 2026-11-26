/**
 * The one place the app decides where an answer comes from.
 *
 * Vault Mode: only the device. If the device cannot answer, the call fails
 * closed, there is no path from here to the cloud.
 * Hybrid Mode: the device first; if it cannot, the caller is told consent is
 * required, and the only way to the cloud afterwards is `runApprovedCloud`,
 * which refuses without a matching approval.
 */

import { ConsentInvalidError, ConsentRequiredError, DeviceUnavailableError } from "./errors.js";
import { assertConsent, type Approval, type ConsentRequest } from "../../../shared/privacy/consent.js";
import { CLOUD_DESTINATION_PREFIX, DEFAULT_CLOUD_MODEL, ON_DEVICE_MODEL_LABEL } from "./types.js";
import type { Engine, InferenceResult, KeepsakeMode } from "./types.js";

export interface RunOptions {
  mode: KeepsakeMode;
  prompt: string;
  engine: Engine;
  /** Cloud model to use in Hybrid Mode. Defaults to the free-tier default. */
  model?: string;
  /** On-device download progress. */
  onProgress?: (progress: number) => void;
}

/** The destination string a consent is bound to for a given cloud model. */
export function destinationFor(model: string = DEFAULT_CLOUD_MODEL): string {
  return `${CLOUD_DESTINATION_PREFIX}:${model}`;
}

/**
 * Run a prompt in the active mode. In Hybrid Mode this only ever returns an
 * on-device answer; when that is impossible it throws `ConsentRequiredError`
 * so the caller can present the sanitized payload and ask.
 */
export async function runInference(options: RunOptions): Promise<InferenceResult> {
  const { mode, engine } = options;
  try {
    const result = await engine.generate("on-device", options.prompt, {
      onProgress: options.onProgress,
    });
    return { text: result.text, source: "on-device", model: ON_DEVICE_MODEL_LABEL };
  } catch (error) {
    if (mode === "vault") {
      // Fail closed. A Vault request never becomes a cloud request.
      //
      // The engine already explains a device failure in device terms (see
      // `deviceFailureMessage`), so the message is passed through as written
      // rather than prefixed again, the notice that shows it already names
      // Vault Mode, and the old prefix produced "Vault Mode could not use the
      // on-device model: the cloud request did not complete".
      throw new DeviceUnavailableError(
        error instanceof Error && error.message ? error.message : undefined,
      );
    }
    throw new ConsentRequiredError();
  }
}

export interface CloudRunOptions {
  /** The exact sanitized text that would leave the device. */
  sanitized: string;
  engine: Engine;
  /** The approval to check against the request. */
  approval: Approval | null;
  /** The request this approval must match (payload hash, operation, destination). */
  request: ConsentRequest;
  model?: string;
}

/**
 * Send an approved, already-sanitized payload to the cloud. Refuses unless the
 * approval matches the exact payload, operation and destination. The response
 * is always labelled `cloud`; if the engine wrongly reported on-device, the
 * call fails rather than mislabel an answer as local.
 */
export async function runApprovedCloud(options: CloudRunOptions): Promise<InferenceResult> {
  const model = options.model ?? DEFAULT_CLOUD_MODEL;
  try {
    assertConsent(options.approval, options.request);
  } catch (error) {
    throw new ConsentInvalidError(error instanceof Error ? error.message : "consent did not match");
  }
  const result = await options.engine.generate("cloud", options.sanitized, { model });
  if (result.reportedSource === "on_device") {
    throw new ConsentInvalidError("the cloud call was reported as on-device");
  }
  return { text: result.text, source: "cloud", model };
}

export { ON_DEVICE_MODEL_LABEL, DEFAULT_CLOUD_MODEL, CLOUD_DESTINATION_PREFIX };
export * from "./types.js";
export * from "./errors.js";
