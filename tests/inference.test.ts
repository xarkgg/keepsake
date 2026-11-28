import assert from "node:assert/strict";
import test from "node:test";
import {
  ConsentInvalidError,
  ConsentRequiredError,
  DeviceUnavailableError,
  destinationFor,
  runApprovedCloud,
  runInference,
} from "../src/lib/inference/index.js";
import type { Engine } from "../src/lib/inference/types.js";
import { approve, type ConsentRequest } from "../shared/privacy/consent.js";
import { redact } from "../shared/privacy/redact.js";

/**
 * A fake engine that records what it was asked to do. `onDevice` is the answer
 * the device produces, or `null` to simulate a device that cannot answer at all
 * (no model, or an unavailable one), which is exactly the case the mode logic
 * has to handle without ever reaching the cloud on its own.
 */
function fakeEngine(onDevice: string | null): Engine & {
  calls: { onDevice: number; cloud: number; lastPrompt: string | null };
} {
  const calls = { onDevice: 0, cloud: 0, lastPrompt: null };
  return {
    calls,
    availability: async () => (onDevice === null ? "unsupported" : "available"),
    initializeDeviceModel: async () => undefined,
    async generate(where, prompt) {
      if (where === "on-device") {
        calls.onDevice += 1;
        calls.lastPrompt = prompt;
        if (onDevice === null) throw new Error("no on-device model");
        return { text: onDevice, reportedSource: "on_device" as const };
      }
      calls.cloud += 1;
      calls.lastPrompt = prompt;
      return { text: "cloud answer", reportedSource: "in_cloud" as const };
    },
  };
}

const onDeviceEngine = (answer: string | null) => fakeEngine(answer);
const cloudEngine = (answer: string) => {
  const engine = fakeEngine("unused");
  engine.generate = async (where, prompt) => {
    engine.calls.cloud += 1;
    engine.calls.lastPrompt = prompt;
    return { text: answer, reportedSource: "in_cloud" as const };
  };
  return engine;
};


test("Vault Mode returns an on-device answer and never goes to the cloud", async () => {
  const engine = onDeviceEngine("local answer");
  const result = await runInference({ mode: "vault", prompt: "hello", engine });
  assert.equal(result.text, "local answer");
  assert.equal(result.source, "on-device");
  assert.equal(engine.calls.cloud, 0);
  assert.equal(engine.calls.onDevice, 1);
});

test("Vault Mode fails closed when the device has no model", async () => {
  const engine = onDeviceEngine(null); // no on-device model
  await assert.rejects(
    runInference({ mode: "vault", prompt: "hello", engine }),
    (error: unknown) => error instanceof DeviceUnavailableError,
  );
  // The important part: a failed Vault turn does not become a cloud turn.
  assert.equal(engine.calls.cloud, 0);
});

test("Hybrid Mode answers on-device when it can", async () => {
  const engine = onDeviceEngine("local answer");
  const result = await runInference({ mode: "hybrid", prompt: "hello", engine });
  assert.equal(result.source, "on-device");
  assert.equal(engine.calls.cloud, 0);
});

test("Hybrid Mode asks for consent instead of falling back to the cloud", async () => {
  const engine = onDeviceEngine(null);
  await assert.rejects(
    runInference({ mode: "hybrid", prompt: "hello", engine }),
    (error: unknown) => error instanceof ConsentRequiredError,
  );
  // Consent-required is not consent: nothing was sent.
  assert.equal(engine.calls.cloud, 0);
});

// --- the approved cloud path ---------------------------------------------

function consentFor(input: string, operation = "chat"): { request: ConsentRequest; sanitized: string } {
  const redaction = redact(input);
  return {
    sanitized: redaction.text,
    request: {
      hash: redaction.hash,
      operation,
      destination: destinationFor(),
      preview: redaction.text,
    },
  };
}

test("an approved cloud call sends the sanitized text and is labelled cloud", async () => {
  const engine = cloudEngine("cloud answer");
  const { request, sanitized } = consentFor("email me at jane@example.com");
  const result = await runApprovedCloud({
    sanitized,
    engine,
    approval: approve(request),
    request,
  });
  assert.equal(result.source, "cloud");
  assert.equal(result.text, "cloud answer");
  // What left the device is the redacted text, never the raw email.
  assert.equal(engine.calls.lastPrompt, "email me at [email#1]");
  assert.ok(!engine.calls.lastPrompt?.includes("jane@example.com"));
});

test("a cloud call is refused without an approval", async () => {
  const engine = cloudEngine("should not happen");
  const { request, sanitized } = consentFor("hello");
  await assert.rejects(
    runApprovedCloud({ sanitized, engine, approval: null, request }),
    (error: unknown) => error instanceof ConsentInvalidError,
  );
  assert.equal(engine.calls.cloud, 0);
});

test("a cloud call is refused when the payload changed after approval", async () => {
  const engine = cloudEngine("should not happen");
  const { request, sanitized } = consentFor("original note");
  const approval = approve(request);
  // The user edits the text, so the sanitized payload (and its hash) changes.
  const changed = consentFor("a different note");
  await assert.rejects(
    runApprovedCloud({ sanitized: changed.sanitized, engine, approval, request: changed.request }),
    (error: unknown) => error instanceof ConsentInvalidError,
  );
  assert.equal(engine.calls.cloud, 0);
});

test("a cloud call is refused when the destination changed", async () => {
  const engine = cloudEngine("should not happen");
  const { request, sanitized } = consentFor("hello");
  const approval = approve({ ...request, destination: destinationFor("some-other-model") });
  await assert.rejects(
    runApprovedCloud({ sanitized, engine, approval, request }),
    (error: unknown) => error instanceof ConsentInvalidError,
  );
  // A stale request can still match its approval even after the caller changes the actual model.
  await assert.rejects(
    runApprovedCloud({ sanitized, engine, approval: approve(request), request, model: "some-other-model" }),
    ConsentInvalidError,
  );
  assert.equal(engine.calls.cloud, 0);
});

test("a response wrongly reported as on-device is refused, not mislabelled", async () => {
  const engine: Engine = {
    availability: async () => "available",
    initializeDeviceModel: async () => undefined,
    async generate() {
      return { text: "answer", reportedSource: "on_device" };
    },
  };
  const { request, sanitized } = consentFor("hello");
  await assert.rejects(
    runApprovedCloud({ sanitized, engine, approval: approve(request), request }),
    (error: unknown) => error instanceof ConsentInvalidError,
  );
});
