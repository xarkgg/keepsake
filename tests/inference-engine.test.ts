import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  ConsentInvalidError,
  ConsentRequiredError,
  DeviceUnavailableError,
  runApprovedCloud,
  runInference,
} from "../src/lib/inference/index.js";
import { InferenceError } from "../src/lib/inference/errors.js";
import type { DeviceAvailability, Engine } from "../src/lib/inference/types.js";
import { approve } from "../shared/privacy/consent.js";
import { destinationFor } from "../src/lib/inference/index.js";
import { redact } from "../shared/privacy/redact.js";

/**
 * The inference-side acceptance criteria. These check the behaviour around the
 * model, which is where the privacy model can quietly break: a device state
 * reported wrongly, a failure that turns into a cloud call, or an error that
 * surfaces an SDK string instead of a plain one.
 */

/** An engine whose on-device availability is scripted. */
function availabilityEngine(state: DeviceAvailability, opts: { failGenerate?: boolean } = {}): Engine {
  return {
    availability: async () => state,
    initializeDeviceModel: async () => undefined,
    async generate(where) {
      if (opts.failGenerate) throw new Error("model exploded");
      return where === "on-device"
        ? { text: "ok", reportedSource: "on_device" as const }
        : { text: "ok", reportedSource: "in_cloud" as const };
    },
  };
}

// --- on-device availability is reported honestly ---------------------------

test("each device state is reported as itself, not collapsed to a boolean", async () => {
  for (const state of ["available", "downloadable", "downloading", "unsupported", "unknown"] as const) {
    assert.equal(await availabilityEngine(state).availability(), state);
  }
});

test("an unsupported device fails a Vault request closed, never to the cloud", async () => {
  let cloudCalls = 0;
  const engine: Engine = {
    availability: async () => "unsupported",
    initializeDeviceModel: async () => {
      throw new Error("cannot initialize without a device model");
    },
    async generate(where) {
      if (where === "cloud") cloudCalls += 1;
      throw new Error("the on-device model is not available on this device");
    },
  };
  await assert.rejects(
    runInference({ mode: "vault", prompt: "hello", engine }),
    (error: unknown) => error instanceof DeviceUnavailableError,
  );
  assert.equal(cloudCalls, 0);
});

test("an unsupported device makes Hybrid ask for consent, not auto-fall back", async () => {
  let cloudCalls = 0;
  const engine: Engine = {
    availability: async () => "unsupported",
    initializeDeviceModel: async () => undefined,
    async generate(where) {
      if (where === "cloud") cloudCalls += 1;
      throw new Error("no device model");
    },
  };
  await assert.rejects(
    runInference({ mode: "hybrid", prompt: "hello", engine }),
    (error: unknown) => error instanceof ConsentRequiredError,
  );
  assert.equal(cloudCalls, 0);
});

test("model download progress is surfaced while the device model is prepared", async () => {
  const seen: number[] = [];
  const engine: Engine = {
    availability: async () => "downloadable",
    async initializeDeviceModel(onProgress) {
      onProgress?.(0.25);
      onProgress?.(0.75);
      onProgress?.(1);
    },
    async generate() {
      return { text: "ok", reportedSource: "on_device" };
    },
  };
  await engine.initializeDeviceModel((value) => seen.push(value));
  assert.deepEqual(seen, [0.25, 0.75, 1]);
});

// --- cloud errors are handled, and never mislabelled -----------------------

test("a cloud failure surfaces as a failure, with no result labelled on-device", async () => {
  const engine: Engine = {
    availability: async () => "unsupported",
    initializeDeviceModel: async () => undefined,
    async generate() {
      throw new Error("503 service unavailable");
    },
  };
  const redaction = redact("hello");
  const request = { hash: redaction.hash, operation: "chat", destination: destinationFor(), preview: redaction.text };
  await assert.rejects(runApprovedCloud({ sanitized: redaction.text, engine, approval: approve(request), request }));
});

test("an error thrown by the boundary keeps its typed identity", () => {
  assert.ok(new DeviceUnavailableError() instanceof InferenceError);
  assert.ok(new ConsentRequiredError() instanceof InferenceError);
  assert.ok(new ConsentInvalidError("reason") instanceof InferenceError);
});

test("a device failure is explained in device terms, never as a cloud failure", async () => {
  const { deviceFailureMessage, engineFailureMessage } = await import("../src/lib/inference/errors.js");

  // The real bug: `generate()` ended both paths with `cloudFailureMessage`, so a
  // Vault failure read "The cloud request did not complete", a network the
  // request never touched.
  const noModel = deviceFailureMessage(new Error("LanguageModel is not available in this browser"));
  assert.match(noModel, /browser|Chrome/i, "an unsupported browser is named as the cause");
  assert.match(noModel, /nothing left this device|nothing was sent/i, "and that nothing left the device");

  assert.match(
    deviceFailureMessage(new Error("the model is still downloading")),
    /not ready|downloading/i,
    "a model still downloading is described as not ready yet",
  );
  assert.match(
    deviceFailureMessage(new Error("The input exceeds the model's context window")),
    /longer than|shorten/i,
    "an over-long prompt is described as too long",
  );

  for (const error of [
    new Error("LanguageModel is not available in this browser"),
    new Error("the model is still downloading"),
    new Error("The input exceeds the model's context window"),
    new Error(""),
  ]) {
    const copy = deviceFailureMessage(error);
    assert.ok(!/cloud|server|network|connection/i.test(copy), `device copy must not mention the cloud: ${copy}`);
    assert.ok(copy.length > 40, "the copy has to be a sentence, not a fragment");
  }

  // The path decides the copy, so neither can be labelled with the other's.
  const deviceFail = engineFailureMessage("on-device", new Error("503 service unavailable"));
  assert.ok(!/cloud/i.test(deviceFail), `an on-device failure must not be a cloud message: ${deviceFail}`);
  const cloudFail = engineFailureMessage("cloud", new Error("503 service unavailable"));
  assert.match(cloudFail, /cloud/i, "a cloud failure still says so");
});

test("a pending device model points to the download control", async () => {
  const { deviceFailureMessage } = await import("../src/lib/inference/errors.js");
  assert.match(deviceFailureMessage(new Error("model is still downloading")), /Where it thinks/);
  assert.match(deviceFailureMessage(new Error("model is still downloading")), /start or watch/i);
});

test("model download failures give cause-specific setup instructions", async () => {
  const { deviceDownloadFailureMessage } = await import("../src/lib/inference/errors.js");
  const activation = Object.assign(new Error("User activation is required"), { name: "NotAllowedError" });
  assert.match(deviceDownloadFailureMessage(activation), /click|Press Start the download/i);
  assert.match(deviceDownloadFailureMessage(new Error("not enough disk space")), /22 GB.*profile/i);
  assert.match(deviceDownloadFailureMessage(new Error("connection is metered")), /unmetered/i);
  const generic = deviceDownloadFailureMessage(new Error("model setup failed"));
  assert.match(generic, /chrome:\/\/on-device-internals/);
  assert.ok(!/not enough|insufficient|full disk/i.test(generic), "an unknown failure cannot be blamed on disk space");
});

test("the engine picks its failure copy by path, not by a shared fallback", () => {
  const root = new URL("../", import.meta.url).pathname;
  const source = fs.readFileSync(path.join(root, "src/lib/inference/firebase-ai.ts"), "utf8");
  assert.match(
    source,
    /engineFailureMessage\(\s*where\s*,/,
    "the failure must be described according to the path that failed",
  );
  assert.ok(
    !/throw new InferenceError\(cloudFailureMessage/.test(source),
    "a shared cloud fallback is exactly the bug: it labelled device failures as cloud failures",
  );
  // App Check only guards the cloud path, so it must not explain a device error.
  assert.match(
    source,
    /where === "cloud"\) \{[\s\S]{0,120}appCheckFailureMessage/,
    "App Check copy is cloud-only",
  );
});

test("a busy model is recognised as retryable, and is explained without internals", async () => {
  const { cloudFailureMessage, isTransientCloudError } = await import("../src/lib/inference/errors.js");
  const busy = new Error(
    "AI: Error fetching from https://firebasevertexai.googleapis.com/v1beta/projects/x/models/y:generateContent: [500 ] This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later. (AI/fetch-error)",
  );
  assert.ok(isTransientCloudError(busy), "capacity errors must be retryable");
  const friendly = cloudFailureMessage(busy);
  assert.match(friendly, /capacity|try again/i, "the person is told it is temporary");
  assert.ok(!/vertexai|firebasevertexai|projects\/|\/models\//.test(friendly), "no endpoint or project may leak");

  // A 404 (model retired) is not a retry-and-hope case.
  const retired = new Error("AI: [404 ] model not found");
  assert.ok(!isTransientCloudError(retired));
  assert.match(cloudFailureMessage(retired), /no longer offers this model/i);
});

test("a spent free-tier quota is explained, and is not retried inside the turn", async () => {
  const { cloudFailureMessage, isQuotaError, isTransientCloudError } = await import(
    "../src/lib/inference/errors.js"
  );
  const quota = new Error(
    "AI: Error fetching from https://firebasevertexai.googleapis.com/v1beta/projects/x/models/y:generateContent: [429 ] You exceeded your current quota, please check your plan and billing details.",
  );
  assert.ok(isQuotaError(quota), "429 must be recognised as a spent quota");
  assert.ok(!isTransientCloudError(quota), "retrying a spent quota only adds delay");
  const friendly = cloudFailureMessage(quota);
  assert.match(friendly, /quota/i, "the person is told the quota is the cause");
  assert.match(friendly, /try again/i, "and that it comes back on its own");
  assert.ok(!/vertexai|firebasevertexai|projects\/|\/models\//.test(friendly), "no internals may leak");
});

test("a request the SDK abandoned on timeout is retryable and explained", async () => {
  const { cloudFailureMessage, isTransientCloudError } = await import("../src/lib/inference/errors.js");
  const timeout = Object.assign(new Error("Timeout has expired."), { name: "AbortError" });
  assert.ok(isTransientCloudError(timeout), "a timeout is capacity, so the same request may be retried");
  assert.match(cloudFailureMessage(timeout), /in time|try again/i);

  const offline = new TypeError("fetch failed");
  assert.ok(isTransientCloudError(offline), "a dead network is retryable");
  assert.match(cloudFailureMessage(offline), /connection|reached/i);
});

test("one cloud attempt cannot hang for the SDK's 180-second default", () => {
  // Measured: a capacity-blocked model hangs for the full SDK timeout and then
  // fails, so a person watches a thinking bubble for three minutes. The engine
  // must set its own ceiling, and the ceiling must be short enough to be a
  // visible failure rather than a dead wait.
  const root = new URL("../", import.meta.url).pathname;
  const source = fs.readFileSync(path.join(root, "src/lib/inference/firebase-ai.ts"), "utf8");
  assert.match(source, /timeout:\s*CLOUD_REQUEST_TIMEOUT_MS/, "the engine must pass its own timeout");
  const types = fs.readFileSync(path.join(root, "src/lib/inference/types.ts"), "utf8");
  const declared = types.match(/CLOUD_REQUEST_TIMEOUT_MS\s*=\s*([\d_]+)/)?.[1]?.replace(/_/g, "");
  assert.ok(declared, "the timeout must live in one constant");
  assert.ok(Number(declared) <= 15_000, `the ceiling must be short, got ${declared}ms`);
});

test("the default cloud model is a free-tier model that actually answers", () => {
  // This checks the configured model name, not live service capacity.
  const root = new URL("../", import.meta.url).pathname;
  const types = fs.readFileSync(path.join(root, "src/lib/inference/types.ts"), "utf8");
  const model = types.match(/DEFAULT_CLOUD_MODEL\s*=\s*"([^"]+)"/)?.[1];
  assert.ok(model, "the default model must be declared once");
  assert.ok(
    ["gemini-4-hydrogen", "gemini-3.8-flash", "gemini-3.5-flash-lite"].includes(model),
    `${model} is not one of the free-tier models`,
  );
});

// --- the Firebase-only rule, checked against the source -------------------

test("firebase/ai is the only model SDK the app imports", () => {
  const root = new URL("../", import.meta.url).pathname;
  const allowed = /^firebase\//;
  const forbiddenSdks = [
    /from\s+["']openai["']/,
    /from\s+["']@anthropic-ai\//,
    /from\s+["']@google-ai\/generativelanguage["']/,
    /from\s+["']@google\/generative-ai["']/,
    /from\s+["']@google-cloud\//,
    /from\s+["']cohere-ai["']/,
    /from\s+["']mistralai["']/,
  ];
  const offences: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        const text = fs.readFileSync(full, "utf8");
        for (const pattern of forbiddenSdks) {
          if (pattern.test(text)) offences.push(`${path.relative(root, full)} matches ${pattern}`);
        }
        // Any model SDK import must be from firebase/*.
        for (const match of text.matchAll(/from\s+["']([^"']+)["']/g)) {
          const spec = match[1] ?? "";
          const looksLikeModelSdk = /(openai|anthropic|generativelanguage|generative-ai|cohere|mistral|gemini)/i.test(spec);
          if (looksLikeModelSdk && !allowed.test(spec) && !spec.startsWith("./") && !spec.startsWith("../")) {
            offences.push(`${path.relative(root, full)} imports ${spec}`);
          }
        }
      }
    }
  };
  walk(path.join(root, "src"));
  walk(path.join(root, "shared"));
  assert.deepEqual(offences, [], `only firebase/ai may back inference:\n${offences.join("\n")}`);
});

test("the engine builds its models with ONLY_ON_DEVICE and ONLY_IN_CLOUD, never PREFER", () => {
  const root = new URL("../", import.meta.url).pathname;
  const source = fs.readFileSync(path.join(root, "src/lib/inference/firebase-ai.ts"), "utf8");
  assert.match(source, /InferenceMode\.ONLY_ON_DEVICE/);
  assert.match(source, /InferenceMode\.ONLY_IN_CLOUD/);
  assert.ok(!/PREFER_ON_DEVICE|PREFER_IN_CLOUD/.test(source), "a PREFER_* mode could bypass the consent gate");
});

test("both models are built with the Keepsake persona, not the provider's", () => {
  // The identity has to travel with BOTH paths. Vault Mode answers land in the
  // same thread as cloud answers, so a device answer that introduces itself as
  // something else is the same defect, one mode over.
  //
  // Where it travels matters as much as that it does: with a hybrid `mode` the
  // SDK ignores every top-level option except `mode`, `onDeviceParams` and
  // `inCloudParams`, so a top-level `systemInstruction` never reaches the wire.
  const root = new URL("../", import.meta.url).pathname;
  const source = fs.readFileSync(path.join(root, "src/lib/inference/firebase-ai.ts"), "utf8");
  assert.match(source, /SYSTEM_INSTRUCTION/, "the persona must be imported");
  // Cloud: a request-level field, inside inCloudParams.
  assert.match(
    source,
    /inCloudParams:\s*\{\s*model,\s*systemInstruction:\s*SYSTEM_INSTRUCTION\s*\}/,
    "the cloud model must carry the persona inside inCloudParams",
  );
  // Device: Chrome's Prompt API takes it as a session prompt.
  assert.match(
    source,
    /initialPrompts:\s*\[\s*\{\s*role:\s*"system",\s*content:\s*\[\s*\{\s*type:\s*"text",\s*value:\s*SYSTEM_INSTRUCTION\s*\}/,
    "the device model must carry the persona as an initial system prompt",
  );
  // The shape that silently does nothing.
  assert.ok(
    !/^\s{2,}systemInstruction:/m.test(source),
    "a top-level systemInstruction is ignored whenever mode is set",
  );
});

test("cloud inference is gated on App Check, and the on-device path is not", () => {
  // App Check protects cloud requests and must not gate local generation.
  const root = new URL("../", import.meta.url).pathname;
  const source = fs.readFileSync(path.join(root, "src/lib/inference/firebase-ai.ts"), "utf8");
  assert.match(source, /ensureAppCheck\(\)/, "the cloud path must consult App Check");
  assert.match(
    source,
    /where === "cloud" && !\(await ensureAppCheck\(\)\)/,
    "App Check must gate the cloud branch, not the whole generate call",
  );
});

test("a failed App Check attestation is explained instead of surfaced raw", async () => {
  // When reCAPTCHA cannot score the device, the SDK sends a placeholder token
  // and the model API answers 401. That message names an internal mechanism and
  // tells the person nothing, so it is replaced with an actionable one.
  const { appCheckFailureMessage } = await import("../src/lib/inference/errors.js");
  const raw = new Error(
    "AI: Error fetching from https://firebasevertexai.googleapis.com/v1beta/projects/x/models/y:generateContent: [401 ] Firebase App Check token is invalid. (AI/fetch-error)",
  );
  const friendly = appCheckFailureMessage(raw);
  assert.ok(friendly, "the App Check rejection must be recognised");
  assert.match(friendly, /app check/i, "the message must name what refused the request");
  // The refusal is almost always the attestation check being blocked in the
  // browser, so the message must point at that and name something to try. It
  // must not promise that a retry fixes it: it does not.
  assert.match(friendly, /block/i, "the message must say the check was blocked");
  assert.match(friendly, /ad blocker|private window|chrome/i, "the message must suggest a cause to try");
  assert.ok(!/vertexai|firebasevertexai|X-Firebase/i.test(friendly), "no internal endpoint may leak into the UI");

  assert.equal(appCheckFailureMessage(new Error("App attestation failed.")), friendly);
  // The App Check SDK's own throttle (a 403 from the token exchange makes it
  // refuse to try again for a day) used to read as "the request did not
  // complete", with nothing to do about it. It must be named too, and the fix
  // must be stated, because the throttle lives in page memory.
  const throttled = new Error("AppCheck: 403 error. Attempts allowed again after 01d:00m:00s (appCheck/initial-throttle).");
  const throttleFriendly = appCheckFailureMessage(throttled);
  assert.ok(throttleFriendly, "the SDK throttle must be recognised");
  assert.match(throttleFriendly ?? "", /reload/i, "the throttle clears on reload, so the message must say so");
  // Anything else must pass through untouched.
  assert.equal(appCheckFailureMessage(new Error("network down")), null);
  assert.equal(appCheckFailureMessage(undefined), null);
});

test("the cloud AI service is built to mint a single-use App Check token", () => {
  // With replay protection on, a normal App Check token is rejected 401 even
  // though attestation succeeded. That is a deployment setting, so the code
  // must always ask for a limited-use token rather than leave it to chance.
  const root = new URL("../", import.meta.url).pathname;
  const source = fs.readFileSync(path.join(root, "src/lib/inference/firebase-ai.ts"), "utf8");
  assert.match(source, /\.\.\.CLOUD_AI_SETUP/, "the cloud AI service must be built with CLOUD_AI_SETUP");
  const types = fs.readFileSync(path.join(root, "src/lib/inference/types.ts"), "utf8");
  assert.match(types, /useLimitedUseAppCheckTokens:\s*true/);
});
