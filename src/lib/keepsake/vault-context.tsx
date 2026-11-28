/**
 * The React binding for the Vault store.
 *
 * The store itself is pure (`shared/keepsake/store.ts`); this holds the React
 * state around it and exposes exactly the operations a chat surface needs. It
 * keeps the "on-device only" promise honest: every call here goes to the local
 * store, never to `api()`, so a Vault conversation is never persisted remotely.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  VaultStore,
  newId,
  type VaultMessage,
  type VaultSession,
} from "../../../shared/keepsake/store.js";
import type { InferenceSource, KeepsakeMode } from "../../../shared/inference.js";
import { browserVaultStorage } from "./idb.js";

export interface VaultState {
  /** Newest first. Empty until the store has loaded. */
  sessions: VaultSession[];
  loaded: boolean;
  createSession: (mode: KeepsakeMode) => Promise<VaultSession>;
  renameSession: (id: string, title: string | null) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  listMessages: (sessionId: string) => Promise<VaultMessage[]>;
  /** Append a message and return it. */
  appendMessage: (input: {
    sessionId: string;
    role: "user" | "assistant";
    content: string;
    source?: InferenceSource | null;
    consentHash?: string | null;
    model?: string | null;
  }) => Promise<VaultMessage>;
  /** Wipe every Keepsake conversation on this device. */
  clearAll: () => Promise<void>;
}

const VaultContext = createContext<VaultState | null>(null);

export function VaultProvider({ children }: { children: ReactNode }) {
  // One store for the app's lifetime. `browserVaultStorage()` picks IndexedDB or
  // an in-memory fallback; neither is a network store.
  const storeRef = useRef<VaultStore | null>(null);
  if (!storeRef.current) storeRef.current = new VaultStore(browserVaultStorage());
  const store = storeRef.current;

  const [sessions, setSessions] = useState<VaultSession[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    setSessions(await store.listSessions());
  }, [store]);

  useEffect(() => {
    void (async () => {
      await refresh();
      setLoaded(true);
    })();
  }, [refresh]);

  const createSession = useCallback(
    async (mode: KeepsakeMode) => {
      const session = await store.createSession(mode);
      await refresh();
      return session;
    },
    [store, refresh],
  );

  const renameSession = useCallback(
    async (id: string, title: string | null) => {
      await store.renameSession(id, title);
      await refresh();
    },
    [store, refresh],
  );

  const deleteSession = useCallback(
    async (id: string) => {
      await store.deleteSession(id);
      await refresh();
    },
    [store, refresh],
  );

  const listMessages = useCallback((sessionId: string) => store.listMessages(sessionId), [store]);

  const appendMessage = useCallback(
    async (input: {
      sessionId: string;
      role: "user" | "assistant";
      content: string;
      source?: InferenceSource | null;
      consentHash?: string | null;
      model?: string | null;
    }) => {
      const message: VaultMessage = {
        id: newId("m"),
        session_id: input.sessionId,
        role: input.role,
        content: input.content,
        source: input.source ?? null,
        consentHash: input.consentHash ?? null,
        model: input.model ?? null,
        created_at: new Date().toISOString(),
      };
      await store.addMessage(message);
      await refresh();
      return message;
    },
    [store, refresh],
  );

  const clearAll = useCallback(async () => {
    await store.clear();
    await refresh();
  }, [store, refresh]);

  const value = useMemo<VaultState>(
    () => ({
      sessions,
      loaded,
      createSession,
      renameSession,
      deleteSession,
      listMessages,
      appendMessage,
      clearAll,
    }),
    [sessions, loaded, createSession, renameSession, deleteSession, listMessages, appendMessage, clearAll],
  );

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

export function useVault(): VaultState {
  const value = useContext(VaultContext);
  if (!value) throw new Error("useVault must be used inside VaultProvider");
  return value;
}
