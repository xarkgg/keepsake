import assert from "node:assert/strict";
import test from "node:test";
import { ChatTurns, turnBusy } from "../src/lib/inference/chat-turns.js";
import type { Engine, EngineResult } from "../src/lib/inference/types.js";
import { sha256Hex } from "../shared/privacy/sha256.js";

const first = { sessionId: "chat-a", turnId: "message-a" };
const other = { sessionId: "chat-b", turnId: "message-b" };
const personal = "Reply to ada@example.com";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function engine(generate: Engine["generate"]): Engine {
  return { availability: async () => "unsupported", initializeDeviceModel: async () => {}, generate };
}

function deviceUnavailable(): never { throw new Error("No local model"); }

function review(turns: ChatTurns) {
  const state = turns.snapshot();
  assert.equal(state.phase, "review");
  return state.card;
}

test("an engine setup failure unlocks the turn and allows a subsequent request", async () => {
  let initial = true;
  const turns = new ChatTurns(async () => {
    if (initial) { initial = false; throw new Error("Setup unavailable"); }
    return engine(async () => ({ text: "Ready", reportedSource: "on_device" }));
  });
  assert.equal(await turns.request(first, "vault", "hello"), null);
  assert.equal(turns.snapshot().phase, "blocked");
  assert.equal(turnBusy(turns.snapshot()), false);
  assert.equal((await turns.request(other, "vault", "hello"))?.result.text, "Ready");
  assert.equal(turns.snapshot().phase, "idle");
});

test("a card is bound to its original chat and message, even if its caller changes", async () => {
  const sent: string[] = [];
  const turns = new ChatTurns(async () => engine(async (where, prompt) => {
    if (where === "on-device") return deviceUnavailable();
    sent.push(prompt);
    return { text: "Approved reply", reportedSource: "in_cloud" };
  }));
  const owner = { ...first };
  await turns.request(owner, "hybrid", personal);
  const card = review(turns);
  owner.sessionId = other.sessionId;
  assert.equal(await turns.approve({ ...card, owner }), null);
  assert.equal(await turns.approve({ ...card, owner: { ...first, turnId: other.turnId } }), null);
  assert.deepEqual(sent, []);
  const reply = await turns.approve(card);
  assert.deepEqual(reply?.owner, first);
  assert.deepEqual(sent, ["Reply to [email#1]"]);
  assert.ok(reply?.consentHash);
  assert.equal(await turns.approve(card), null);
});

test("declining a no-match preview keeps it local and consent covers only one turn", async () => {
  const sent: string[] = [];
  const turns = new ChatTurns(async () => engine(async (where, text) => {
    if (where === "on-device") return deviceUnavailable();
    sent.push(text);
    return { text: "Reply", reportedSource: "in_cloud" };
  }));
  const text = "We can no longer afford the rent.";
  await turns.request(first, "hybrid", text);
  const declined = review(turns);
  turns.reset();
  assert.equal(await turns.approve(declined), null);
  await turns.request(first, "hybrid", text);
  const next = review(turns);
  assert.equal(await turns.approve(declined), null, "even an identical preview for the same message needs a new click");
  assert.deepEqual(sent, []);
  const reply = await turns.approve(next);
  assert.equal(reply?.consentHash, sha256Hex(text));
  assert.equal(await turns.approve(next), null);
  assert.deepEqual(sent, [text]);
});

test("leaving before the device finishes cannot park an old card or start a cloud fallback", async () => {
  for (const prompt of ["a clean question", personal]) {
    const entered = deferred<void>();
    const local = deferred<EngineResult>();
    let cloudCalls = 0;
    const turns = new ChatTurns(async () => engine(async (where) => {
      if (where === "on-device") { entered.resolve(); return local.promise; }
      cloudCalls++;
      return { text: "unexpected" };
    }));
    const pending = turns.request(first, "hybrid", prompt);
    await entered.promise;
    turns.reset();
    local.reject(new Error("No local model"));
    assert.equal(await pending, null);
    assert.equal(turns.snapshot().phase, "idle");
    assert.equal(cloudCalls, 0);
  }
});

test("an approved reply finishing after navigation keeps its origin and cannot erase a later card", async () => {
  const started = deferred<void>();
  const cloud = deferred<EngineResult>();
  let sends = 0;
  const turns = new ChatTurns(async () => engine(async (where) => {
    if (where === "on-device") return deviceUnavailable();
    sends++;
    started.resolve();
    return cloud.promise;
  }));
  await turns.request(first, "hybrid", personal);
  const firstCard = review(turns);
  const approved = turns.approve(firstCard);
  await started.promise;
  assert.equal(await turns.approve(firstCard), null);
  turns.reset();
  await turns.request(other, "hybrid", personal);
  const newCard = turns.snapshot();
  assert.equal(newCard.phase, "review");
  cloud.resolve({ text: "First reply", reportedSource: "in_cloud" });
  assert.deepEqual((await approved)?.owner, first);
  assert.equal(turns.snapshot(), newCard);
  turns.reset();
  assert.equal(await turns.approve(newCard.card), null);
  assert.equal(sends, 1);
});

test("failed approval preserves the same redacted card for another decision", async () => {
  const prompts: string[] = [];
  const turns = new ChatTurns(async () => engine(async (where, prompt) => {
    if (where === "on-device") return deviceUnavailable();
    prompts.push(prompt);
    if (prompts.length === 1) throw new Error("Unavailable");
    return { text: "Sent" };
  }));
  await turns.request(first, "hybrid", personal);
  const card = review(turns);
  assert.equal(await turns.approve(card), null);
  assert.equal(turns.snapshot().phase, "review");
  assert.equal(turnBusy(turns.snapshot()), false);
  assert.equal((await turns.approve(card))?.result.text, "Sent");
  assert.deepEqual(prompts, ["Reply to [email#1]", "Reply to [email#1]"]);
});
