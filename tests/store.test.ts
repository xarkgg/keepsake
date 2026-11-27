import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStorage, VaultStore } from "../shared/keepsake/store.js";

/**
 * The store's rules are what keep Vault content on the device: nothing is
 * written anywhere the store does not own, a session's messages belong to it,
 * and deletion is total. These run against the in-memory port, which is the
 * same port IndexedDB implements.
 */

function storeWith(clock = () => new Date().toISOString()) {
  const storage = new MemoryStorage();
  return { storage, store: new VaultStore(storage, clock) };
}

test("a new store is empty", async () => {
  const { store } = storeWith();
  assert.deepEqual(await store.listSessions(), []);
});

test("a session round-trips through storage with no title until named", async () => {
  const { store } = storeWith();
  const session = await store.createSession("vault");
  assert.equal(session.title, null);
  assert.equal(session.mode, "vault");
  const listed = await store.listSessions();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, session.id);
});

test("messages belong to their session and keep their source receipt", async () => {
  const { store } = storeWith();
  const session = await store.createSession("hybrid");
  await store.addMessage({
    id: "m1",
    session_id: session.id,
    role: "user",
    content: "hello",
    source: null,
    created_at: new Date().toISOString(),
  });
  await store.addMessage({
    id: "m2",
    session_id: session.id,
    role: "assistant",
    content: "hi",
    source: "on-device",
    model: "gemini-nano",
    created_at: new Date().toISOString(),
  });

  const messages = await store.listMessages(session.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.source, null);
  assert.equal(messages[1]?.source, "on-device");
  assert.equal(messages[1]?.model, "gemini-nano");
});

test("a cloud answer can carry the consent hash but not the payload", async () => {
  const { store } = storeWith();
  const session = await store.createSession("hybrid");
  await store.addMessage({
    id: "m1",
    session_id: session.id,
    role: "assistant",
    content: "answer",
    source: "cloud",
    consentHash: "abc123",
    model: "gemini-4-hydrogen",
    created_at: new Date().toISOString(),
  });
  const [message] = await store.listMessages(session.id);
  assert.equal(message?.consentHash, "abc123");
  // There is no field on a stored message for the raw payload; the shape itself
  // is the guarantee that it cannot be persisted here.
  assert.equal("sanitized" in (message ?? {}), false);
});

test("the session list is newest-first by activity", async () => {
  let tick = 0;
  const { store } = storeWith(() => `2026-01-01T00:00:0${tick++}.000Z`);
  const a = await store.createSession("vault");
  const b = await store.createSession("vault");
  // Adding a message to `a` touches it, so it floats above the newer `b`.
  await store.addMessage({
    id: "m",
    session_id: a.id,
    role: "user",
    content: "x",
    source: null,
    created_at: new Date().toISOString(),
  });
  const listed = await store.listSessions();
  assert.equal(listed[0]?.id, a.id);
  assert.equal(listed[1]?.id, b.id);
});

test("deleting a session removes its messages too", async () => {
  const { store } = storeWith();
  const session = await store.createSession("vault");
  await store.addMessage({
    id: "m",
    session_id: session.id,
    role: "user",
    content: "secret",
    source: null,
    created_at: new Date().toISOString(),
  });
  await store.deleteSession(session.id);
  assert.deepEqual(await store.listSessions(), []);
  assert.deepEqual(await store.listMessages(session.id), []);
});

test("renaming a session changes only its title", async () => {
  const { store } = storeWith();
  const session = await store.createSession("vault");
  await store.renameSession(session.id, "Trip planning");
  const found = await store.getSession(session.id);
  assert.equal(found?.title, "Trip planning");
  assert.equal(found?.mode, "vault");
});

test("clear() wipes every key the store owns", async () => {
  const { store, storage } = storeWith();
  const session = await store.createSession("vault");
  await store.addMessage({
    id: "m",
    session_id: session.id,
    role: "user",
    content: "x",
    source: null,
    created_at: new Date().toISOString(),
  });
  // A key the store does not own must survive: clear() is scoped to Keepsake's
  // own data, so it can never delete an unrelated record.
  await storage.mutate((tx) => tx.write("something.else", "keep me"));
  await store.clear();
  assert.deepEqual(await store.listSessions(), []);
  assert.equal(await storage.read("something.else"), "keep me");
});

test("a corrupt blob degrades to empty rather than throwing", async () => {
  const storage = new MemoryStorage();
  await storage.mutate((tx) => tx.write("keepsake.sessions", "{not json"));
  const store = new VaultStore(storage);
  assert.deepEqual(await store.listSessions(), []);
});

test("a read returns a copy, so a caller cannot mutate stored state", async () => {
  const { store } = storeWith();
  await store.createSession("vault");
  const first = await store.listSessions();
  first[0]!.title = "mutated";
  const second = await store.listSessions();
  assert.equal(second[0]?.title, null);
});

test("independent writers preserve simultaneous sessions, messages and renames", async () => {
  const port = new MemoryStorage();
  const a = new VaultStore(port);
  const b = new VaultStore(port);
  const [first, second] = await Promise.all([a.createSession("vault"), b.createSession("hybrid")]);
  const message = { session_id: first.id, role: "user" as const, content: "sample", source: null, created_at: first.created_at };
  await Promise.all([a.addMessage({ ...message, id: "one" }), b.addMessage({ ...message, id: "two" }), b.renameSession(first.id, "Renamed")]);
  assert.deepEqual((await a.listMessages(first.id)).map((item) => item.id).sort(), ["one", "two"]);
  assert.equal((await b.getSession(first.id))?.title, "Renamed");
  assert.ok(await a.getSession(second.id));
  await a.deleteSession(first.id);
  await assert.rejects(b.addMessage({ ...message, id: "late" }), /no longer exists/);
  assert.deepEqual(await b.listMessages(first.id), []);
});

test("an aborted mutation rolls back and releases the next writer", async () => {
  const port = new MemoryStorage();
  await assert.rejects(port.mutate(async (tx) => { await tx.write("x", "partial"); throw new Error("cancelled"); }));
  assert.equal(await port.read("x"), null);
  await port.mutate((tx) => tx.write("x", "saved"));
  assert.equal(await port.read("x"), "saved");
});
