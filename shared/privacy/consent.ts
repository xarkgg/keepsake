/**
 * The consent gate. The single rule it exists to enforce: a cloud request may
 * go out only when a person has approved *this exact payload, for this
 * operation, to this destination*, and any change to any of the three makes
 * the approval no longer valid.
 *
 * Nothing here performs I/O. It is pure state and pure checks, which is what
 * lets the "changed payload invalidates approval" guarantee be tested directly.
 */

export interface ConsentRequest {
  /** SHA-256 of the sanitized payload that would leave the device. */
  hash: string;
  /** What the request does, e.g. "chat" or "summarize". */
  operation: string;
  /** Where it would go, e.g. "firebase-ai-logic:gemini-4-hydrogen". */
  destination: string;
  /** The exact sanitized text shown to the person for approval. */
  preview: string;
}

export interface Approval {
  hash: string;
  operation: string;
  destination: string;
  approvedAt: number;
}

export type ConsentRefusal =
  | "no-approval"
  | "payload-changed"
  | "operation-changed"
  | "destination-changed";

export type ConsentCheck = { ok: true } | { ok: false; reason: ConsentRefusal };

/**
 * A payload that failed to sanitize must never be approvable. The gate takes
 * this sentinel rather than a boolean so the failure is impossible to ignore.
 */
export class SanitizationError extends Error {
  constructor(message = "Sanitization failed; the request was refused.") {
    super(message);
    this.name = "SanitizationError";
  }
}

export function approve(request: ConsentRequest, now: number = Date.now()): Approval {
  if (!request.hash) throw new SanitizationError();
  return {
    hash: request.hash,
    operation: request.operation,
    destination: request.destination,
    approvedAt: now,
  };
}

/**
 * Does `approval` authorise `request`? The first mismatch found is reported, so
 * the UI can say precisely why it is asking again.
 */
export function checkConsent(approval: Approval | null | undefined, request: ConsentRequest): ConsentCheck {
  if (!approval) return { ok: false, reason: "no-approval" };
  if (approval.hash !== request.hash) return { ok: false, reason: "payload-changed" };
  if (approval.operation !== request.operation) return { ok: false, reason: "operation-changed" };
  if (approval.destination !== request.destination) return { ok: false, reason: "destination-changed" };
  return { ok: true };
}

/** Throwing form for call sites that must not continue without consent. */
export function assertConsent(approval: Approval | null | undefined, request: ConsentRequest): void {
  const check = checkConsent(approval, request);
  if (!check.ok) {
    throw new Error(`Cloud request refused: ${check.reason}.`);
  }
}

/**
 * Holds at most one active approval. In practice the app keeps the approval for
 * the payload currently on screen; approving a new payload replaces it, which
 * is also how "the approval is bound to one payload" is enforced over time.
 */
export class ConsentGate {
  private approval: Approval | null = null;

  approve(request: ConsentRequest, now: number = Date.now()): Approval {
    this.approval = approve(request, now);
    return this.approval;
  }

  check(request: ConsentRequest): ConsentCheck {
    return checkConsent(this.approval, request);
  }

  assert(request: ConsentRequest): void {
    assertConsent(this.approval, request);
  }

  current(): Approval | null {
    return this.approval;
  }

  clear(): void {
    this.approval = null;
  }
}
