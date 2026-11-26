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
   * bound to. Never the payload itself. Lets the UI prove an answer left the
   * device only under consent, without keeping the sent bytes.
   */
  consentHash?: string | null;
  /** The model that produced an assistant answer, when known. */
  model?: string | null;
  created_at: string;
}

/**
 * The storage port. An implementation only has to move strings; the store owns
 * every rule about what those strings mean.
 */
export interface VaultStorage {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** Every key this store may have written (the store filters by prefix). */
  keys(): Promise<string[]>;
}

/** An in-memory port: the test double, and the fallback when IndexedDB is absent. */
export class MemoryStorage implements VaultStorage {
  private map = new Map<string, string>();

  async read(key: string): Promise<string | null> {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  async write(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
  async keys(): Promise<string[]> {
    return [...this.map.keys()];
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
    const sessions = parseArray<VaultSession>(await this.storage.read(SESSION_INDEX));
    sessions.push(session);
    await this.storage.write(SESSION_INDEX, JSON.stringify(sessions));
    return session;
  }

  async renameSession(id: string, title: string | null): Promise<void> {
    const sessions = parseArray<VaultSession>(await this.storage.read(SESSION_INDEX));
    const next = sessions.map((session) =>
      session.id === id ? { ...session, title, updated_at: this.now() } : session,
    );
    await this.storage.write(SESSION_INDEX, JSON.stringify(next));
  }

  /** Removes a session and every message it owns. Deletion is total. */
  async deleteSession(id: string): Promise<void> {
    const sessions = parseArray<VaultSession>(await this.storage.read(SESSION_INDEX));
    await this.storage.write(
      SESSION_INDEX,
      JSON.stringify(sessions.filter((session) => session.id !== id)),
    );
    await this.storage.remove(messagesKey(id));
  }

  async listMessages(sessionId: string): Promise<VaultMessage[]> {
    return parseArray<VaultMessage>(await this.storage.read(messagesKey(sessionId)));
  }

  async addMessage(message: VaultMessage): Promise<void> {
    const messages = parseArray<VaultMessage>(await this.storage.read(messagesKey(message.session_id)));
    messages.push(message);
    await this.storage.write(messagesKey(message.session_id), JSON.stringify(messages));
    // Touch the session so it floats to the top of the list.
    const sessions = parseArray<VaultSession>(await this.storage.read(SESSION_INDEX));
    const next = sessions.map((session) =>
      session.id === message.session_id ? { ...session, updated_at: this.now() } : session,
    );
    await this.storage.write(SESSION_INDEX, JSON.stringify(next));
  }

  /** Wipe everything this store owns. Used by "delete all my data". */
  async clear(): Promise<void> {
    const keys = await this.storage.keys();
    for (const key of keys) {
      if (key === SESSION_INDEX || key.startsWith(MESSAGES_PREFIX)) await this.storage.remove(key);
    }
  }
}
