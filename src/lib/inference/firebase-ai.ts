/**
 * The single module that imports `firebase/ai`, and it imports it lazily so the
 * SDK stays in its own chunk and is fetched when model setup or inference
 * needs it. Everything above this file works against the `Engine` interface.
 *
 * Strictness is enforced by construction: a Vault call builds its model with
 * `ONLY_ON_DEVICE` (which throws rather than fall back), and a cloud call
 * builds it with `ONLY_IN_CLOUD`. There is no `PREFER_*` anywhere in Keepsake.
 */

import type {
  DeviceAvailability,
  Engine,
  EngineResult,
  GenerateOptions,
} from "./types.js";
import { CLOUD_AI_SETUP, CLOUD_REQUEST_TIMEOUT_MS, DEFAULT_CLOUD_MODEL } from "./types.js";
import {
  appCheckFailureMessage,
  engineFailureMessage,
  InferenceError,
  isTransientCloudError,
} from "./errors.js";
import { ensureAppCheck, getCloudFirebaseApp } from "../firebase.js";
import { SYSTEM_INSTRUCTION } from "../../../shared/keepsake/prompt.js";

type AiModule = typeof import("firebase/ai");
type FirebaseApp = import("firebase/app").FirebaseApp;
type GenerativeModel = import("firebase/ai").GenerativeModel;
type DeviceCreateOptions = import("firebase/ai").LanguageModelCreateOptions;
type DeviceModelProvider = {
  availability(options: DeviceCreateOptions): Promise<string>;
  create(options: DeviceCreateOptions): Promise<{ destroy(): void }>;
};

function deviceModelProvider(): DeviceModelProvider | undefined {
  return (globalThis as { LanguageModel?: DeviceModelProvider }).LanguageModel;
}

let modPromise: Promise<AiModule> | null = null;
function loadAi(): Promise<AiModule> {
  modPromise ??= import("firebase/ai");
  return modPromise;
}

/**
 * The live Firebase AI Logic engine. Construct it with an already-initialized
 * FirebaseApp; the app already initializes one for authentication.
 */
export class FirebaseAiEngine implements Engine {
  private readonly app: FirebaseApp;
  private deviceModel: GenerativeModel | null = null;
  private readonly deviceCreateOptions: DeviceCreateOptions = {
    expectedInputs: [{ type: "text", languages: ["en"] }],
    expectedOutputs: [{ type: "text", languages: ["en"] }],
    initialPrompts: [
      { role: "system", content: [{ type: "text", value: SYSTEM_INSTRUCTION }] },
    ],
  };

  constructor(app: FirebaseApp) {
    this.app = app;
  }

  private async device(): Promise<GenerativeModel> {
    if (!this.deviceModel) {
      const { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } = await loadAi();
      const ai = getAI(this.app, { backend: new GoogleAIBackend() });
      // ONLY_ON_DEVICE: throws if the local model is unavailable. Never a
      // silent cloud fallback, that is the whole point of Vault Mode.
      //
      // The persona has to arrive as a session prompt, not as a request field:
      // with a hybrid `mode`, the SDK ignores everything except `mode`,
      // `onDeviceParams` and `inCloudParams`, and its on-device adapter never
      // forwards a request-level `systemInstruction` at all. Chrome's Prompt API
      // takes it in `initialPrompts`, which is the only place the local model
      // will see it. Without this, "who are you?" answers as the provider.
      this.deviceModel = getGenerativeModel(ai, {
        mode: InferenceMode.ONLY_ON_DEVICE,
        onDeviceParams: {
          createOptions: this.deviceCreateOptions,
        },
      });
    }
    return this.deviceModel;
  }

  private async cloud(model: string): Promise<GenerativeModel> {
    const { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } = await loadAi();
    // Reuse the App Check-enabled service, but select the model named in this approval.
    const app = await getCloudFirebaseApp();
    const ai = getAI(app, { backend: new GoogleAIBackend(), ...CLOUD_AI_SETUP });
    return getGenerativeModel(ai, {
      mode: InferenceMode.ONLY_IN_CLOUD,
      inCloudParams: { model, systemInstruction: SYSTEM_INSTRUCTION },
    });
  }

  async availability(): Promise<DeviceAvailability> {
    // The on-device path rides Chrome's Prompt API. Report its real state so
    // the UI distinguishes a downloadable model from an unsupported browser.
    const lm = deviceModelProvider();
    if (!lm?.availability) return "unsupported";
    try {
      // Prepare the SDK before a download click. Checking availability does not
      // start a download, and both checks and creation use the same text options.
      await this.device();
      const state = await lm.availability(this.deviceCreateOptions);
      if (state === "available") return "available";
      if (state === "downloadable") return "downloadable";
      if (state === "downloading") return "downloading";
      return "unsupported";
    } catch {
      return "unknown";
    }
  }

  async initializeDeviceModel(onProgress?: (progress: number) => void): Promise<void> {
    const model = await this.device();
    const lm = deviceModelProvider();
    if (!lm?.availability || !lm.create) {
      throw new InferenceError("This browser has no built-in model to download.");
    }
    const state = await lm.availability(this.deviceCreateOptions);
    if (state === "available") {
      await model.initializeDeviceModel(onProgress);
      return;
    }
    if (state !== "downloadable" && state !== "downloading") {
      throw new InferenceError("The built-in model is not available on this device.");
    }
    // Await Chrome's installation promise directly, including immediate
    // rejections. This temporary session only installs the model, it never
    // receives a user's message. All generation still goes through AI Logic.
    const session = await lm.create({
      ...this.deviceCreateOptions,
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => onProgress?.(event.loaded));
      },
    });
    try {
      await model.initializeDeviceModel(onProgress);
    } finally {
      session.destroy();
    }
  }

  async generate(
    where: "on-device" | "cloud",
    prompt: string,
    options: GenerateOptions = {},
  ): Promise<EngineResult> {
    // Only cloud generation requires App Check. A missing site key must not
    // block the local model or permit an unattested cloud request.
    if (where === "cloud" && !(await ensureAppCheck())) {
      throw new InferenceError(
        "Cloud inference needs App Check, which is not configured for this deployment.",
      );
    }
    const model =
      where === "on-device"
        ? await this.device()
        : await this.cloud(options.model ?? DEFAULT_CLOUD_MODEL);
    // A busy model is retried with the same payload, request and destination, so
    // an approval stays honest; a spent quota is not retried because waiting
    // inside one turn cannot fix it. The on-device path is attempted once, a
    // local model that failed once will fail again in the same second.
    const attempts = where === "cloud" ? 3 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        // Without this the SDK waits its own 180 seconds before giving up, so a
        // person watches a thinking bubble for three minutes and then gets
        // nothing. Lite answers in about a second; this ceiling only trips when
        // the request has gone somewhere bad.
        const result = await model.generateContent(
          prompt,
          where === "cloud" ? { timeout: CLOUD_REQUEST_TIMEOUT_MS } : undefined,
        );
        const response = result.response;
        const reported = response.inferenceSource;
        return {
          text: response.text(),
          reportedSource: reported === "on_device" ? "on_device" : reported === "in_cloud" ? "in_cloud" : undefined,
        };
      } catch (error) {
        lastError = error;
        // A failed attestation arrives as a raw SDK string naming an internal
        // mechanism; say what happened and what to do instead. App Check only
        // guards the cloud path, so it must never explain a device failure.
        if (where === "cloud") {
          const friendly = appCheckFailureMessage(error);
          if (friendly) throw new InferenceError(friendly);
        }
        if (attempt < attempts - 1 && isTransientCloudError(error)) {
          await delay(800 * (attempt + 1));
          continue;
        }
        break;
      }
    }
    // Nothing above the engine should ever display a project id or an endpoint,
    // and this module never logs: the raw SDK error can carry request context,
    // and telemetry-boundary.test.ts forbids a console call on this path.
    //
    // The copy is chosen by WHICH PATH failed: a Vault failure that says "the
    // cloud request did not complete" is false and points at a network that was
    // never touched.
    throw new InferenceError(engineFailureMessage(where, lastError));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Is Firebase AI Logic's on-device path plausible in this browser at all? This
 * is a cheap capability probe used to explain the state before any SDK call.
 * The authoritative answer comes from `Engine.availability()` / initialize().
 */
export function promptApiSupported(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { LanguageModel?: unknown }).LanguageModel !== "undefined"
  );
}
