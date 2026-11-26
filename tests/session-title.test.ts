import assert from "node:assert/strict";
import test from "node:test";
import { deriveSessionTitle, isGreetingOnly, sanitizeSessionName, SESSION_NAME_MAX } from "../shared/session-title.js";

/**
 * Naming a chat session is a pure rule with no database or network use, so it is
 * checked directly here: greetings and pleasantries must not become a name, and
 * the name must be the request the person actually made.
 */

test("greetings and pleasantries are recognised as openers", () => {
  for (const opener of ["hi", "hey", "Hello!", "good morning", "thanks", "ok", "cool", "you there?", "what's up"]) {
    assert.equal(isGreetingOnly(opener), true, `${opener} should be an opener`);
  }
});

test("a lone emoji or two is not a request", () => {
  assert.equal(isGreetingOnly("👋"), true);
  assert.equal(isGreetingOnly("🙂🙂"), true);
  assert.equal(isGreetingOnly("hey 🙂"), true);
  assert.equal(isGreetingOnly("write me a poem about the sea"), false);
});

test("a greeting attached to a real request keeps the request", () => {
  assert.equal(isGreetingOnly("hi, find me a laptop under $900"), false);
  assert.equal(isGreetingOnly("hey what is the price of ethereum"), false);
});

test("a session is named from the request, not the greeting", () => {
  assert.equal(
    deriveSessionTitle(["hey", "good morning!", "help me plan a trip to Rome in April"]),
    "help me plan a trip",
  );
  // Every message an opener: still nothing to name it after.
  assert.equal(deriveSessionTitle(["hi", "thanks", "ok"]), null);
  // The first sentence is the name; the rest is dropped, and the cap ends it on
  // a word rather than mid-word.
  assert.equal(
    deriveSessionTitle(["Summarise this contract. It is long and I do not have time."]),
    "Summarise this",
  );
});

test("a derived name is capped for the list", () => {
  const name = deriveSessionTitle([`compare ${"a".repeat(200)}`]);
  assert.ok(name && name.length <= SESSION_NAME_MAX, `name should be capped at ${SESSION_NAME_MAX} characters`);
  assert.equal(SESSION_NAME_MAX, 20);
});

/**
 * The model names a session once the reply has landed, and its output is not
 * trustworthy: it adds quotes, a "Name:" prefix, a trailing period, markdown, or
 * several candidates. Every one of those must be reduced to a clean, short name.
 */
test("a model-proposed name is cleaned and capped", () => {
  assert.equal(sanitizeSessionName("Plan a Trip to Rome"), "Plan a Trip to Rome");
  assert.equal(sanitizeSessionName('"Plan a Trip to Rome"'), "Plan a Trip to Rome");
  assert.equal(sanitizeSessionName("Name: Plan a Trip to Rome."), "Plan a Trip to Rome");
  assert.equal(sanitizeSessionName("Title: **Weekly meal plan**"), "Weekly meal plan");
  assert.equal(sanitizeSessionName("Debug the login flow\nSecond line ignored"), "Debug the login flow");
  assert.equal(sanitizeSessionName("`find a laptop`"), "find a laptop");
  // Longer than the cap: cut to the same length a derived name uses.
  const long = sanitizeSessionName("A very long session name that runs on and on");
  assert.ok(long && long.length <= SESSION_NAME_MAX, "a sanitized name must be capped");
  // Nothing to keep.
  assert.equal(sanitizeSessionName(""), null);
  assert.equal(sanitizeSessionName("   \n  "), null);
  assert.equal(sanitizeSessionName('""'), null);
});
