/**
 * Keepsake's context store: conversations kept on the device.
 *
 * Conversation content stays behind a local storage port, implemented with
 * IndexedDB in the browser. It is never persisted server-side.
 *
 * The logic is deliberately pure, no React, no IndexedDB, no globals, so the
 * rules (ordering, deletion, the cloud/local distinction) are directly testable
 * with an in-memory port.
 */

import type { InferenceSource, KeepsakeMode } from "../inference.js";

/** One stored conversation. */
export interface VaultSession {
  id: string;
  /** The name shown in lists; null until there is a real request to name it by. */
  title: string | null;
  /** The mode in force when the session was created, for an honest label. */
  mode: KeepsakeMode;
  created_at: string;
  updated_at: string;
}

/** One stored message. */
export interface VaultMessage {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  /**
   * Where an assistant answer came from. Always null on a user message. This is
   * the receipt at message granularity: a conversation can mix a device answer
   * and a cloud answer, and each one records which it was.
   */
  source: InferenceSource | null;
  /**
   * For a cloud answer, the hash of the sanitized payload the approval was
   * bound to. The receipt keeps the fingerprint, never a second copy of the prompt.
   */
  consentHash?: string | null;
  /**
   * Older receipts can record that a prompt was sent without review.
   */
  unreviewed?: boolean | null;
  /** The model that produced an assistant answer, when known. */
  model?: string | null;
  created_at: string;
}

/**
 * The storage port. An implementation only has to move strings; the store owns
 * every rule about what those strings mean.
 */
export interface VaultTransaction {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** Every key this store may have written (the store filters by prefix). */
  keys(): Promise<string[]>;
}

export interface VaultStorage {
  read(key: string): Promise<string | null>;
  /** Read and write together. Only await operations on this transaction. */
  mutate(update: (tx: VaultTransaction) => Promise<void>): Promise<void>;
}

/** An in-memory port: the test double, and the fallback when IndexedDB is absent. */
export class MemoryStorage implements VaultStorage {
  private map = new Map<string, string>();
  private writes = Promise.resolve();

  async read(key: string): Promise<string | null> {
    await this.writes;
    return this.map.get(key) ?? null;
  }

  mutate(update: (tx: VaultTransaction) => Promise<void>): Promise<void> {
    const run = this.writes.then(async () => {
      const next = new Map(this.map);
      await update({
        read: async (key) => next.get(key) ?? null,
        write: async (key, value) => { next.set(key, value); },
        remove: async (key) => { next.delete(key); },
        keys: async () => [...next.keys()],
      });
      this.map = next;
    });
    this.writes = run.catch(() => undefined);
    return run;
  }
}

const SESSION_INDEX = "keepsake.sessions";
const MESSAGES_PREFIX = "keepsake.messages.";

function messagesKey(sessionId: string): string {
  return `${MESSAGES_PREFIX}${sessionId}`;
}

/**
 * Parse JSON that may be absent, truncated or from an older shape. A corrupt
 * blob must degrade to "nothing stored" rather than take the app down.
 */
function parseArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    return [];
  }
}

let counter = 0;
/** A time-ordered-ish id. Not security-sensitive; uniqueness is all that matters. */
export function newId(prefix: string): string {
  counter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}-${rand}`;
}

/**
 * The store. Every read returns a fresh array, so a caller can never mutate
 * stored state by holding a reference. Newest session first, newest message
 * last, the order a chat surface renders in.
 */
export class VaultStore {
  constructor(
    private storage: VaultStorage,
    private now: () => string = () => new Date().toISOString(),
  ) {}

  async listSessions(): Promise<VaultSession[]> {
    const sessions = parseArray<VaultSession>(await this.storage.read(SESSION_INDEX));
    return sessions.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  }

  async getSession(id: string): Promise<VaultSession | null> {
    const sessions = parseArray<VaultSession>(await this.storage.read(SESSION_INDEX));
    return sessions.find((session) => session.id === id) ?? null;
  }

  async createSession(mode: KeepsakeMode): Promise<VaultSession> {
    const at = this.now();
    const session: VaultSession = {
      id: newId("s"),
      title: null,
      mode,
      created_at: at,
      updated_at: at,
    };
    await this.storage.mutate(async (tx) => {
      const sessions = parseArray<VaultSession>(await tx.read(SESSION_INDEX));
      sessions.push(session);
      await tx.write(SESSION_INDEX, JSON.stringify(sessions));
    });
    return session;
  }

  async renameSession(id: string, title: string | null): Promise<void> {
    await this.storage.mutate(async (tx) => {
      const sessions = parseArray<VaultSession>(await tx.read(SESSION_INDEX));
      const session = sessions.find((item) => item.id === id);
      if (!session) return;
      session.title = title;
      session.updated_at = this.now();
      await tx.write(SESSION_INDEX, JSON.stringify(sessions));
    });
  }

  /** Removes a session and every message it owns. Deletion is total. */
  async deleteSession(id: string): Promise<void> {
    await this.storage.mutate(async (tx) => {
      const sessions = parseArray<VaultSession>(await tx.read(SESSION_INDEX));
      await tx.write(SESSION_INDEX, JSON.stringify(sessions.filter((session) => session.id !== id)));
      await tx.remove(messagesKey(id));
    });
  }

  async listMessages(sessionId: string): Promise<VaultMessage[]> {
    return parseArray<VaultMessage>(await this.storage.read(messagesKey(sessionId)));
  }

  async addMessage(message: VaultMessage): Promise<void> {
    await this.storage.mutate(async (tx) => {
      const sessions = parseArray<VaultSession>(await tx.read(SESSION_INDEX));
      const session = sessions.find((item) => item.id === message.session_id);
      if (!session) throw new Error("This conversation no longer exists.");
      const key = messagesKey(session.id);
      const messages = parseArray<VaultMessage>(await tx.read(key));
      messages.push(message);
      session.updated_at = this.now();
      await tx.write(key, JSON.stringify(messages));
      await tx.write(SESSION_INDEX, JSON.stringify(sessions));
    });
  }

  /** Wipe everything this store owns. Used by "delete all my data". */
  async clear(): Promise<void> {
    await this.storage.mutate(async (tx) => {
      for (const key of await tx.keys()) {
        if (key === SESSION_INDEX || key.startsWith(MESSAGES_PREFIX)) await tx.remove(key);
      }
    });
  }
}
