/**
 * The sanitizer. Turns private text into a redacted payload plus a set of
 * findings and a stable hash, using only the deterministic rules in `rules.ts`.
 *
 * Two properties matter and are covered by tests:
 *  - the redacted text contains none of the matched values, and
 *  - the result is deterministic, so the same input always yields the same
 *    payload and the same hash (this is what makes consent binding work).
 */

import { findMatches, type RawMatch } from "./rules.js";
import { sha256Hex } from "./sha256.js";

export interface Finding {
  /** Rule id, e.g. "email". */
  rule: string;
  /** Human label for the consent preview, e.g. "email address". */
  label: string;
  count: number;
  /** The placeholders this finding produced, in order. */
  placeholders: string[];
}

/** Where a redaction sits in the sanitized text, so a preview can highlight it. */
export interface RedactionSpan {
  rule: string;
  label: string;
  placeholder: string;
  start: number;
  end: number;
}

export interface Redaction {
  /** The sanitized payload, the only text that may leave the device. */
  text: string;
  findings: Finding[];
  spans: RedactionSpan[];
  /** Number of values replaced. */
  count: number;
  /** SHA-256 of `text`; the value a consent is bound to. */
  hash: string;
}

/** A placeholder is `[<rule>#<n>]`; `n` counts per rule, in order of appearance. */
function placeholderFor(rule: string, n: number): string {
  return `[${rule}#${n}]`;
}

/**
 * Choose non-overlapping matches. Sorted by position, then by rule confidence,
 * then by length, a match is kept only if it does not overlap one already kept.
 * Sorting by confidence means a card number beats the phone-number reading of
 * the same digits.
 */
function selectMatches(matches: RawMatch[]): RawMatch[] {
  const ordered = [...matches].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.end - b.start - (a.end - a.start);
  });
  const chosen: RawMatch[] = [];
  let lastEnd = -1;
  for (const match of ordered) {
    if (match.start < lastEnd) continue;
    chosen.push(match);
    lastEnd = match.end;
  }
  return chosen;
}

export function redact(input: string): Redaction {
  const text = typeof input === "string" ? input : String(input ?? "");
  const selected = selectMatches(findMatches(text));

  let out = "";
  let cursor = 0;
  const counters = new Map<string, number>();
  const findings = new Map<string, Finding>();
  const spans: RedactionSpan[] = [];

  for (const match of selected) {
    const n = (counters.get(match.rule) ?? 0) + 1;
    counters.set(match.rule, n);
    const placeholder = placeholderFor(match.rule, n);

    out += text.slice(cursor, match.start);
    const start = out.length;
    out += placeholder;
    const end = out.length;
    cursor = match.end;

    const finding = findings.get(match.rule) ?? { rule: match.rule, label: match.label, count: 0, placeholders: [] };
    finding.count += 1;
    finding.placeholders.push(placeholder);
    findings.set(match.rule, finding);

    spans.push({ rule: match.rule, label: match.label, placeholder, start, end });
  }
  out += text.slice(cursor);

  return {
    text: out,
    findings: [...findings.values()],
    spans,
    count: selected.length,
    hash: sha256Hex(out),
  };
}

/** True when the input contained nothing the pipeline recognises as private. */
export function isClean(redaction: Redaction): boolean {
  return redaction.count === 0;
}
