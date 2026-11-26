import assert from "node:assert/strict";
import test from "node:test";
import { assemblePrompt, CONTEXT_TURNS, SYSTEM_INSTRUCTION } from "../shared/keepsake/prompt.js";
import type { VaultMessage } from "../shared/keepsake/store.js";

function message(role: "user" | "assistant", content: string, id = content): VaultMessage {
  return {
    id,
    session_id: "s1",
    role,
    content,
    source: role === "assistant" ? "on-device" : null,
    created_at: new Date().toISOString(),
  };
}

test("a first turn is exactly what the person typed", () => {
  assert.equal(assemblePrompt([], "  plan my week  "), "plan my week");
});

test("earlier turns are carried as a labelled transcript", () => {
  const history = [message("user", "hi"), message("assistant", "hello")];
  const prompt = assemblePrompt(history, "help me decide");
  assert.equal(prompt, "You: hi\nKeepsake: hello\n\nhelp me decide");
});

test("only the most recent turns are carried", () => {
  const history = Array.from({ length: CONTEXT_TURNS + 4 }, (_, i) =>
    message("user", `turn ${i}`, `m${i}`),
  );
  const prompt = assemblePrompt(history, "latest");
  // The oldest turns are dropped; the transcript holds exactly CONTEXT_TURNS.
  assert.ok(!prompt.includes("turn 0\n"));
  assert.ok(prompt.includes(`turn ${history.length - 1}`));
  const transcriptLines = prompt.split("\n\n")[0]?.split("\n") ?? [];
  assert.equal(transcriptLines.length, CONTEXT_TURNS);
});

test("the request is always the final part of the prompt", () => {
  const prompt = assemblePrompt([message("user", "before")], "the actual ask");
  assert.ok(prompt.endsWith("\n\nthe actual ask"));
});

test("assembly is deterministic", () => {
  const history = [message("user", "a")];
  assert.equal(assemblePrompt(history, "b"), assemblePrompt(history, "b"));
});

test("the model is told who it is answering as", () => {
  // A bare "who are you?" otherwise returns the provider's own boilerplate
  // ("I am a large language model, trained by Google… How can I help you
  // today?"), which is the wrong product voice and vendor text nobody asked
  // for. The identity is one short instruction, in one place.
  assert.match(SYSTEM_INSTRUCTION, /Keepsake/);
  assert.match(SYSTEM_INSTRUCTION, /private assistant/);
  // Honest when asked what is behind it, not evasive.
  assert.match(SYSTEM_INSTRUCTION, /AI assistant/);
  assert.match(SYSTEM_INSTRUCTION, /Firebase AI Logic/);
  // The two behaviours that produced the bad reply.
  assert.match(SYSTEM_INSTRUCTION, /trained on/i);
  assert.match(SYSTEM_INSTRUCTION, /further help/i);
  // It must not assert where an answer came from. A Hybrid reply is produced in
  // the cloud for all anyone reading the prose can know; the badge underneath is
  // the authority, and prose that contradicts it is the one inaccuracy this
  // product cannot afford.
  assert.match(SYSTEM_INSTRUCTION, /Never say where an answer was produced/);
  assert.match(SYSTEM_INSTRUCTION, /badge under the reply/);
  // It is a system instruction, not a second prompt: a tiny on-device budget
  // (9216 tokens per request) must stay mostly available for the request.
  assert.ok(
    SYSTEM_INSTRUCTION.split(/\s+/).length <= 100,
    `the instruction is ${SYSTEM_INSTRUCTION.split(/\s+/).length} words`,
  );
});
