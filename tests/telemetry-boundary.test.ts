import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * Scan the code that handles private text for logging and telemetry paths.
 */

const ROOT = new URL("../", import.meta.url).pathname;

/** Every first-party source file (the app's own code, not dependencies). */
function sourceFiles(): string[] {
  const roots = ["src", "shared"];
  const out: string[] = [];
  for (const dir of roots) {
    const walk = (current: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules") continue;
          walk(full);
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          out.push(full);
        }
      }
    };
    walk(path.join(ROOT, dir));
  }
  return out;
}

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

function relative(file: string): string {
  return path.relative(ROOT, file);
}

/**
 * Imports that would send data to a third party. Firebase's own `firebase/ai`
 * is deliberately allowed, it is the required inference path, but analytics,
 * crash reporting and product telemetry are not.
 */
const FORBIDDEN_IMPORTS = [
  /from\s+["']firebase\/analytics["']/,
  /from\s+["']firebase\/remote-config["']/,
  /from\s+["']firebase\/firestore["']/,
  /from\s+["']@firebase\/firestore["']/,
  /from\s+["']@sentry\//,
  /from\s+["']posthog-js["']/,
  /from\s+["']mixpanel["']/,
  /from\s+["']@amplitude\//,
  /from\s+["']logrocket["']/,
  /from\s+["']@datadog\//,
  /from\s+["']rrweb["']/,
];

test("no first-party module imports analytics, crash reporting or Firestore", () => {
  const offences: string[] = [];
  for (const file of sourceFiles()) {
    const text = read(file);
    for (const pattern of FORBIDDEN_IMPORTS) {
      if (pattern.test(text)) offences.push(`${relative(file)} matches ${pattern}`);
    }
  }
  assert.deepEqual(offences, [], `forbidden telemetry import found:\n${offences.join("\n")}`);
});

test("the Keepsake modules that carry private text do not log it", () => {
  // The modules that hold, move, redact or store a person's text. A console
  // call here is the shortest path from a private prompt to a log sink.
  const privateTextModules = [
    "src/lib/inference/firebase-ai.ts",
    "src/lib/inference/ask.ts",
    "src/lib/inference/index.ts",
    "src/lib/keepsake/idb.ts",
    "src/lib/keepsake/vault-context.tsx",
    "src/lib/inference/keepsake-context.tsx",
    "src/lib/inference/chat-turns.ts",
    "shared/keepsake/store.ts",
    "shared/privacy/redact.ts",
    "shared/privacy/consent.ts",
    "shared/privacy/rules.ts",
  ];
  const offences: string[] = [];
  for (const rel of privateTextModules) {
    const file = path.join(ROOT, rel);
    assert.ok(fs.existsSync(file), `expected module ${rel} to exist`);
    const text = read(file);
    // Strip comments so a doc comment mentioning "logs" is not a false hit.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    if (/\bconsole\s*\./.test(code)) offences.push(rel);
  }
  assert.deepEqual(offences, [], `private-text module writes to the console: ${offences.join(", ")}`);
});

test("the on-device store has no field for the raw sent payload", () => {
  // The store's shape is itself part of the guarantee: a cloud answer keeps the
  // consent hash, never the bytes that were sent, so there is nowhere for the
  // payload to be persisted even if a caller wanted to.
  const source = read(path.join(ROOT, "shared/keepsake/store.ts"));
  assert.ok(/consentHash\??:/.test(source), "the message shape should carry a consent hash");
  assert.ok(!/\bpayload\b\s*[?]?:/.test(source), "the store must not declare a payload field");
  assert.ok(!/\bsanitized\b\s*[?]?:/.test(source), "the store must not declare a sanitized-text field");
});

test("the browser store is IndexedDB-backed, never a cloud store", () => {
  const text = read(path.join(ROOT, "src/lib/keepsake/idb.ts"));
  // Strip comments: the module explains in prose why it is not Firestore.
  const source = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(/indexedDB\.open/.test(source), "the browser port should use IndexedDB");
  assert.ok(!/firestore|firebase\/firestore/i.test(source), "the local store must not be a cloud store");
  // And the fallback is memory, not a network store.
  assert.ok(/MemoryStorage/.test(source), "the fallback should be in-memory");
});
