/**
 * Deterministic detectors for personally identifiable and secret values.
 *
 * Detectors combine patterns with validators such as card checksums and
 * IPv4 octet checks. None of them calls a model.
 *
 * `priority` resolves overlaps: a value matched by two rules is treated as the
 * higher-confidence one. A 16-digit card number, for instance, also looks like
 * a phone number, and the card reading is the safer one to keep.
 */

export interface RawMatch {
  rule: string;
  label: string;
  value: string;
  start: number;
  end: number;
  priority: number;
}

export interface RuleSpec {
  /** Stable id used in findings and tests. */
  id: string;
  /** Shown to the user in the consent preview, e.g. "email address". */
  label: string;
  /** Global regular expression; every match is considered. */
  pattern: RegExp;
  /** Lower wins when two rules match the same span. */
  priority: number;
  /** Optional structural check applied after the pattern matches. */
  validate?: (value: string) => boolean;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = digits.charCodeAt(i) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Digits only, from a string that may contain spaces, dashes or dots. */
function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}

export const RULES: RuleSpec[] = [
  {
    // A private key block is unambiguous and catastrophic to leak.
    id: "private-key",
    label: "private key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    priority: 1,
  },
  {
    id: "jwt",
    label: "token",
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    priority: 1,
  },
  {
    id: "card",
    label: "card number",
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    priority: 1,
    validate: (value) => {
      const digits = digitsOf(value);
      return digits.length >= 13 && digits.length <= 19 && luhn(digits);
    },
  },
  {
    // Known API-key prefixes. A single generic "long string" rule would flag
    // ordinary text far too often, so keys are recognised by provider shape.
    id: "api-key",
    label: "API key",
    pattern:
      /\b(?:sk-[A-Za-z0-9_-]{16,}|sk_live_[A-Za-z0-9]{16,}|sk_test_[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|rk_live_[A-Za-z0-9]{16,})\b/g,
    priority: 2,
  },
  {
    id: "bearer",
    label: "bearer token",
    pattern: /\bBearer\s+[A-Za-z0-9._-]{10,}/gi,
    priority: 2,
  },
  {
    id: "email",
    label: "email address",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    priority: 3,
  },
  {
    id: "ipv4",
    label: "IP address",
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    priority: 4,
    validate: (value) => value.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255),
  },
  {
    // Last, because a phone number is the loosest shape. A candidate is a run
    // of digits that may contain spaces, dots, parens or dashes; the validator
    // then decides. A leading "+" is a strong signal; without one, a formatted
    // run must carry at least ten digits, which keeps "2026 1234" and similar
    // plain numbers out.
    id: "phone",
    label: "phone number",
    pattern: /\+?\d(?:[\d\s().-]{5,}\d)/g,
    priority: 5,
    validate: (value) => {
      const digits = digitsOf(value);
      if (digits.length < 7 || digits.length > 15) return false;
      if (value.trim().startsWith("+")) return true;
      return /[\s().-]/.test(value) && digits.length >= 10;
    },
  },
];

/**
 * Run every rule over `text` and return candidate matches, each carrying the
 * rule that found it. Overlaps are not resolved here, `redact.ts` does that.
 */
export function findMatches(text: string): RawMatch[] {
  const matches: RawMatch[] = [];
  for (const rule of RULES) {
    // A rule pattern is global; reset lastIndex so repeated calls are stable.
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(text)) !== null) {
      const value = match[0];
      if (!value) {
        // Guard against zero-length matches looping forever.
        rule.pattern.lastIndex += 1;
        continue;
      }
      if (rule.validate && !rule.validate(value)) continue;
      matches.push({
        rule: rule.id,
        label: rule.label,
        value,
        start: match.index,
        end: match.index + value.length,
        priority: rule.priority,
      });
    }
  }
  return matches;
}
