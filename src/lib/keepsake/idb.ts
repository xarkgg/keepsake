/**
 * The browser storage port for the Vault store: one IndexedDB database, one
 * object store of plain strings, keyed by the store's own keys.
 *
 * IndexedDB (not localStorage) is used deliberately. It is a real local
 * database that does not travel with the page the way a cookie does, it holds
 * more than a few megabytes, and, unlike Firestore's offline persistence, it
 * is local-only, so nothing here can later synchronise to a cloud service.
 *
 * If IndexedDB is unavailable (private mode, an old browser), the store falls
 * back to memory: the session still works for the visit, and nothing is written
 * anywhere durable. It never silently degrades to a remote store.
 */

import type { VaultStorage, VaultTransaction } from "../../../shared/keepsake/store.js";
import { MemoryStorage } from "../../../shared/keepsake/store.js";

const DB_NAME = "keepsake-vault";
const DB_VERSION = 1;
const STORE_NAME = "kv";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the local store."));
  });
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Local store request failed."));
  });
}

async function readString(store: IDBObjectStore, key: string): Promise<string | null> {
  const value = await result(store.get(key));
  return typeof value === "string" ? value : null;
}

class IndexedDbStorage implements VaultStorage {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    this.db ??= openDb();
    return this.db;
  }

  async read(key: string): Promise<string | null> {
    const db = await this.open();
    return readString(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME), key);
  }

  async mutate(update: (tx: VaultTransaction) => Promise<void>): Promise<void> {
    const db = await this.open();
    // IndexedDB serializes overlapping readwrite transactions across tabs too.
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const committed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("Local changes were not saved."));
    });
    const port: VaultTransaction = {
      read: (key) => readString(store, key),
      write: async (key, value) => { await result(store.put(value, key)); },
      remove: async (key) => { await result(store.delete(key)); },
      keys: async () => (await result(store.getAllKeys())).filter((key): key is string => typeof key === "string"),
    };
    const work = Promise.resolve().then(() => update(port)).catch((error: unknown) => {
      try { transaction.abort(); } catch { /* Already aborted by a failed request. */ }
      throw error;
    });
    await Promise.all([work, committed]);
  }
}

/**
 * The storage the app uses. IndexedDB where it exists, memory otherwise, never
 * a network store.
 */
export function browserVaultStorage(): VaultStorage {
  if (typeof indexedDB === "undefined") return new MemoryStorage();
  return new IndexedDbStorage();
}
