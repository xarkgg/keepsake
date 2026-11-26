import assert from "node:assert/strict";
import test from "node:test";
import { ask, approveText, send } from "../src/lib/inference/ask.js";
import { destinationFor } from "../src/lib/inference/index.js";
import type { Engine } from "../src/lib/inference/types.js";
import { redact } from "../shared/privacy/redact.js";

function engineWith(onDevice: string | null): Engine & {
  calls: { onDevice: number; cloud: number; lastPrompt: string | null };
} {
  const calls = { onDevice: 0, cloud: 0, lastPrompt: null };
  return {
    calls,
    availability: async () => (onDevice === null ? "unsupported" : "available"),
    initializeDeviceModel: async () => undefined,
    async generate(where, prompt) {
      calls.lastPrompt = prompt;
      if (where === "on-device") {
        calls.onDevice += 1;
        if (onDevice === null) throw new Error("no local model");
        return { text: onDevice, reportedSource: "on_device" as const };
      }
      calls.cloud += 1;
      return { text: "cloud answer", reportedSource: "in_cloud" as const };
    },
  };
}

test("Vault answers on-device", async () => {
  const engine = engineWith("hi there");
  const outcome = await ask({ mode: "vault", text: "hello", engine });
  assert.equal(outcome.kind, "answered");
  if (outcome.kind === "answered") {
    assert.equal(outcome.result.source, "on-device");
    assert.equal(outcome.result.text, "hi there");
  }
  assert.equal(engine.calls.cloud, 0);
});

test("Vault blocks (does not ask for consent) when the device cannot answer", async () => {
  const engine = engineWith(null);
  const outcome = await ask({ mode: "vault", text: "hello", engine });
  assert.equal(outcome.kind, "blocked");
  assert.equal(engine.calls.cloud, 0);
});

test("Hybrid returns consent-required with the sanitized payload to review", async () => {
  const engine = engineWith(null);
  const outcome = await ask({
    mode: "hybrid",
    text: "summarise this: reach me at jane@example.com",
    engine,
  });
  assert.equal(outcome.kind, "needs-consent");
  if (outcome.kind === "needs-consent") {
    // The preview is the sanitized text, and it carries the email placeholder.
    assert.ok(outcome.request.preview.includes("[email#1]"));
    assert.ok(!outcome.request.preview.includes("jane@example.com"));
    assert.equal(outcome.request.destination, destinationFor());
    // The hash matches the sanitized payload, which is what a consent binds to.
    assert.equal(outcome.request.hash, redact(outcome.request.preview).hash);
  }
  assert.equal(engine.calls.cloud, 0);
});

test("Hybrid answers on-device without asking when it can", async () => {
  const engine = engineWith("local summary");
  const outcome = await ask({ mode: "hybrid", text: "hello", engine });
  assert.equal(outcome.kind, "answered");
  assert.equal(engine.calls.cloud, 0);
});

test("the full hybrid flow: ask, approve, send", async () => {
  const engine = engineWith(null);
  const text = "note: call 0803-123-4567";
  const outcome = await ask({ mode: "hybrid", text, engine });
  assert.equal(outcome.kind, "needs-consent");
  if (outcome.kind !== "needs-consent") return;

  const approval = approveText(text, "chat").approval;
  // The approval was generated from the same text, so it matches the request.
  const result = await send({ engine, request: outcome.request, redaction: outcome.redaction, approval });
  assert.equal(result.source, "cloud");
  // The phone number never left the device.
  assert.equal(engine.calls.lastPrompt, "note: call [phone#1]");
});

test("Hybrid sends a clean payload without a tap, and keeps only its fingerprint", async () => {
  // Asking permission for text that is already the person's own words trains
  // people to approve without reading. A payload with nothing personal in it is
  // sent directly, but the receipt still records the hash of what went out.
  const engine = engineWith(null);
  const outcome = await ask({ mode: "hybrid", text: "draft a short reminder", engine });
  assert.equal(outcome.kind, "answered");
  if (outcome.kind === "answered") {
    assert.ok(outcome.consentHash, "the receipt must record what left the device");
    assert.equal(outcome.consentHash, redact("draft a short reminder").hash);
  }
  assert.equal(engine.calls.cloud, 1, "a clean payload is sent once");
  assert.equal(engine.calls.lastPrompt, "draft a short reminder");
});

test("Hybrid still asks when the text carries personal details", async () => {
  const engine = engineWith(null);
  const outcome = await ask({ mode: "hybrid", text: "email jane@example.com", engine });
  assert.equal(outcome.kind, "needs-consent");
  assert.equal(engine.calls.cloud, 0, "personally-identifying text is never sent unseen");
});

test("send refuses when the payload was edited after approval", async () => {
  const engine = engineWith(null);
  const outcome = await ask({ mode: "hybrid", text: "original jane@example.com", engine });
  assert.equal(outcome.kind, "needs-consent");
  if (outcome.kind !== "needs-consent") return;

  const edited = approveText("different jane@example.com", "chat").approval; // approval for other text
  await assert.rejects(
    send({ engine, request: outcome.request, redaction: outcome.redaction, approval: edited }),
  );
  assert.equal(engine.calls.cloud, 0);
});
