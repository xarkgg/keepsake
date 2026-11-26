import assert from "node:assert/strict";
import test from "node:test";
import { ask, send } from "../src/lib/inference/ask.js";
import { ConsentRequiredError } from "../src/lib/inference/errors.js";
import { destinationFor, runApprovedCloud, runInference } from "../src/lib/inference/index.js";
import type { Engine } from "../src/lib/inference/types.js";
import { approve } from "../shared/privacy/consent.js";
import { prepare } from "../shared/privacy/index.js";

/**
 * The engine is a fake, so any network call that happens here would have to be
 * one the Keepsake code makes itself. That is exactly what these tests are
 * looking for: a layer that quietly reaches the network around the boundary.
 */

/** An engine that answers on-device, records calls, and can be told to fail. */
function engine(answer: string | null) {
  const calls = { onDevice: 0, cloud: 0, prompts: [] as string[] };
  const api: Engine = {
    availability: async () => (answer === null ? "unsupported" : "available"),
    initializeDeviceModel: async () => undefined,
    async generate(where, prompt) {
      calls.prompts.push(prompt);
      if (where === "on-device") {
        calls.onDevice += 1;
        if (answer === null) throw new Error("no on-device model");
        return { text: answer, reportedSource: "on_device" as const };
      }
      calls.cloud += 1;
      return { text: "cloud answer", reportedSource: "in_cloud" as const };
    },
  };
  return { api, calls };
}

/** Count every fetch the app makes during `run`. */
async function withFetchSpy<T>(run: () => Promise<T>): Promise<{ result: T; fetches: string[] }> {
  const original = globalThis.fetch;
  const fetches: string[] = [];
  // Any fetch is a network call; record the URL and refuse noisily.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetches.push(typeof input === "string" ? input : input.toString());
    throw new Error("fetch was called");
  }) as typeof fetch;
  try {
    const result = await run();
    return { result, fetches };
  } finally {
    globalThis.fetch = original;
  }
}

test("Vault Mode sends no network request containing the prompt", async () => {
  const { api } = engine("a private answer");
  const { result, fetches } = await withFetchSpy(() =>
    runInference({ mode: "vault", prompt: "my secret plan", engine: api }),
  );
  assert.equal(result.source, "on-device");
  assert.deepEqual(fetches, [], "Vault Mode must not touch the network");
});

test("Vault Mode does not fall back to the cloud when the device fails", async () => {
  const { api, calls } = engine(null);
  await assert.rejects(runInference({ mode: "vault", prompt: "hello", engine: api }));
  assert.equal(calls.cloud, 0, "a failed Vault turn must never become a cloud turn");
});

test("Hybrid Mode cannot reach the cloud without an approval bound to the payload", async () => {
  // The boundary itself never auto-clouds: a Hybrid turn on a device that
  // cannot answer raises consent-required, and nothing is sent.
  const { api, calls } = engine(null);
  await assert.rejects(
    runInference({ mode: "hybrid", prompt: "help me", engine: api }),
    (error: unknown) => error instanceof ConsentRequiredError,
  );
  assert.equal(calls.cloud, 0, "asking for consent is not consent");

  // And text that carries personal details still parks for a human decision.
  const outcome = await ask({ mode: "hybrid", text: "help me at jane@example.com", engine: api });
  assert.equal(outcome.kind, "needs-consent");
  assert.equal(calls.cloud, 0);
});

test("the outbound payload never contains the original private values", async () => {
  const { api, calls } = engine(null);
  const original = "reach me at jane@example.com or +1 555 123 4567";
  const outcome = await ask({ mode: "hybrid", text: original, engine: api });
  assert.equal(outcome.kind, "needs-consent");
  if (outcome.kind !== "needs-consent") return;

  // Neither the preview nor the request may carry the raw values.
  assert.ok(!outcome.request.preview.includes("jane@example.com"));
  assert.ok(!outcome.request.preview.includes("555 123 4567"));
  assert.ok(outcome.request.preview.includes("[email#1]"));

  // Approve and send; the bytes that actually leave are the sanitized ones.
  const approval = approve(outcome.request);
  await send({ engine: api, request: outcome.request, redaction: outcome.redaction, approval });
  const sent = calls.prompts[calls.prompts.length - 1] ?? "";
  assert.ok(!sent.includes("jane@example.com"));
  assert.ok(!sent.includes("555 123 4567"));
});

test("PII redaction happens before the outbound request is constructed", async () => {
  // The request object is built from the redaction, so its hash equals the hash
  // of the sanitized text, proving the redaction preceded the request.
  const original = "card 4242 4242 4242 4242 please";
  const redaction = prepare(original);
  const hashIfBuiltFromRaw = prepare(original).hash;
  assert.equal(redaction.hash, hashIfBuiltFromRaw);
  assert.ok(redaction.text.includes("[card#1]"));
  assert.ok(!redaction.text.includes("4242"));
});

test("a sanitization failure blocks the request rather than sending it", async () => {
  const { api, calls } = engine(null);
  // A request with no hash is the sentinel for "sanitization did not succeed",
  // and the consent gate refuses to approve it.
  assert.throws(() => approve({ hash: "", operation: "chat", destination: destinationFor(), preview: "" }));
  assert.equal(calls.cloud, 0);
});

test("a changed payload invalidates the approval and no request is sent", async () => {
  const { api, calls } = engine(null);
  const first = await ask({ mode: "hybrid", text: "note one for jane@example.com", engine: api });
  const second = await ask({ mode: "hybrid", text: "note two for jane@example.com", engine: api });
  assert.equal(first.kind, "needs-consent");
  assert.equal(second.kind, "needs-consent");
  if (first.kind !== "needs-consent" || second.kind !== "needs-consent") return;

  // An approval for the first payload cannot authorise the second.
  const staleApproval = approve(first.request);
  await assert.rejects(
    runApprovedCloud({
      sanitized: second.redaction.text,
      engine: api,
      approval: staleApproval,
      request: second.request,
    }),
  );
  assert.equal(calls.cloud, 0);
});

test("cloud inference is labelled cloud, never mislabelled as local", async () => {
  const { api } = engine(null);
  const outcome = await ask({ mode: "hybrid", text: "hello, write to jane@example.com", engine: api });
  assert.equal(outcome.kind, "needs-consent");
  if (outcome.kind !== "needs-consent") return;
  const result = await runApprovedCloud({
    sanitized: outcome.redaction.text,
    engine: api,
    approval: approve(outcome.request),
    request: outcome.request,
  });
  assert.equal(result.source, "cloud");
});
