/**
 * Keepsake's privacy core, shared by the browser and the tests.
 *
 * `prepare()` is the one entry point the app calls before any cloud request:
 * it sanitizes the text with deterministic rules and returns the exact payload
 * that would leave the device, with a hash a consent can be bound to.
 */

export { redact, isClean } from "./redact.js";
export type { Redaction, Finding, RedactionSpan } from "./redact.js";
export { findMatches, RULES } from "./rules.js";
export type { RawMatch, RuleSpec } from "./rules.js";
export { sha256Hex } from "./sha256.js";
export {
  approve,
  checkConsent,
  assertConsent,
  ConsentGate,
  SanitizationError,
} from "./consent.js";
export type { Approval, ConsentCheck, ConsentRefusal, ConsentRequest } from "./consent.js";

import { redact, type Redaction } from "./redact.js";

/**
 * Sanitize a value for a cloud request. Everything the app sends outbound that
 * was derived from user content goes through here first.
 */
export function prepare(input: string): Redaction {
  return redact(input);
}
