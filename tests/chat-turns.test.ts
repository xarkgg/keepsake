import assert from "node:assert/strict";
import test from "node:test";
import { ChatTurns, turnBusy } from "../src/lib/inference/chat-turns.js";
import type { Engine, EngineResult } from "../src/lib/inference/types.js";

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
  owner.sessionId = other.sessionId;
  assert.equal(await turns.approve(owner), null);
  assert.equal(await turns.approve({ ...first, turnId: other.turnId }), null);
  assert.deepEqual(sent, []);
  const reply = await turns.approve(first);
  assert.deepEqual(reply?.owner, first);
  assert.deepEqual(sent, ["Reply to [email#1]"]);
  assert.ok(reply?.consentHash);
  assert.equal(await turns.approve(first), null);
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
  const approved = turns.approve(first);
  await started.promise;
  assert.equal(await turns.approve(first), null);
  turns.reset();
  await turns.request(other, "hybrid", personal);
  const newCard = turns.snapshot();
  assert.equal(newCard.phase, "review");
  cloud.resolve({ text: "First reply", reportedSource: "in_cloud" });
  assert.deepEqual((await approved)?.owner, first);
  assert.equal(turns.snapshot(), newCard);
  turns.reset();
  assert.equal(await turns.approve(other), null);
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
  assert.equal(await turns.approve(first), null);
  assert.equal(turns.snapshot().phase, "review");
  assert.equal(turnBusy(turns.snapshot()), false);
  assert.equal((await turns.approve(first))?.result.text, "Sent");
  assert.deepEqual(prompts, ["Reply to [email#1]", "Reply to [email#1]"]);
});
