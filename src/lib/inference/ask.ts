/**
 * Keepsake's request orchestration: the single place the app turns a person's
 * text into an answer while honouring the privacy model.
 *
 * It is deliberately pure and injectable (no React, no globals) so the whole
 * decision, answer locally, ask for consent, or refuse, is unit-testable.
 * The UI renders the outcome; it does not re-implement the policy.
 */

import { prepare, type Redaction } from "../../../shared/privacy/index.js";
import type { Approval, ConsentRequest } from "../../../shared/privacy/consent.js";
import { ConsentRequiredError, DeviceUnavailableError } from "./errors.js";
import { destinationFor, runApprovedCloud, runInference } from "./index.js";
import type { Engine, InferenceResult, KeepsakeMode } from "./types.js";

/** Which cloud operation a consent is being requested for. */
export type Operation = "chat" | "summarize";

export type AskOutcome =
  | { kind: "answered"; result: InferenceResult }
  | {
      kind: "needs-consent";
      /** The sanitized payload; the exact bytes that would leave the device. */
      redaction: Redaction;
      /** The request an approval must match. */
      request: ConsentRequest;
      /** Why the cloud is needed, for the UI to explain. */
      reason: string;
    }
  | { kind: "blocked"; message: string };

export interface AskInput {
  mode: KeepsakeMode;
  text: string;
  engine: Engine;
  model?: string;
  operation?: Operation;
  /** Do not start a cloud fallback for a view that has been left. */
  signal?: AbortSignal;
}

/**
 * Try to answer `text` under `mode`.
 *
 * - Vault: only the device. A device that cannot answer produces `blocked`
 *   (never a cloud request).
 * - Hybrid: the device first. When it cannot answer, prepare the full prompt
 *   for review. The number of redactions never authorizes a cloud send.
 */
export async function ask(input: AskInput): Promise<AskOutcome> {
  const { mode, text, engine, model } = input;

  if (mode === "vault") {
    try {
      const result = await runInference({ mode, prompt: text, engine, model });
      return { kind: "answered", result };
    } catch (error) {
      if (error instanceof DeviceUnavailableError) return { kind: "blocked", message: error.message };
      throw error;
    }
  }

  try {
    const result = await runInference({ mode, prompt: text, engine, model });
    return { kind: "answered", result };
  } catch (error) {
    if (!(error instanceof ConsentRequiredError)) throw error;
    input.signal?.throwIfAborted();
    // The task needs the cloud. Build the sanitized payload and the request an
    // approval must match. If sanitizing throws, the request is refused.
    const redaction = prepare(text);
    const operation: Operation = input.operation ?? "chat";
    const request: ConsentRequest = Object.freeze({
      hash: redaction.hash,
      operation,
      destination: destinationFor(model),
      preview: redaction.text,
    });
    return { kind: "needs-consent", redaction, request, reason: "This task needs cloud inference." };
  }
}

export interface SendInput {
  engine: Engine;
  /** The approved request, exactly as it was previewed. */
  request: ConsentRequest;
  /** The sanitized payload that goes out. */
  redaction: Redaction;
  /** The approval from the consent gate. */
  approval: Approval | null;
  model?: string;
}

/** The one way to send an approved cloud request. Returns a receipt-labelled answer. */
export async function send(input: SendInput): Promise<InferenceResult> {
  return runApprovedCloud({
    sanitized: input.redaction.text,
    engine: input.engine,
    approval: input.approval,
    request: input.request,
    model: input.model,
  });
}
