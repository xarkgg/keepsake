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

import type { VaultStorage } from "../../../shared/keepsake/store.js";
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

class IndexedDbStorage implements VaultStorage {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    this.db ??= openDb();
    return this.db;
  }

  private async tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = run(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Local store request failed."));
    });
  }

  async read(key: string): Promise<string | null> {
    const value = await this.tx<string | undefined>("readonly", (store) => store.get(key));
    return typeof value === "string" ? value : null;
  }

  async write(key: string, value: string): Promise<void> {
    await this.tx("readwrite", (store) => store.put(value, key));
  }

  async remove(key: string): Promise<void> {
    await this.tx("readwrite", (store) => store.delete(key));
  }

  async keys(): Promise<string[]> {
    const keys = await this.tx<IDBValidKey[]>("readonly", (store) => store.getAllKeys());
    return keys.filter((key): key is string => typeof key === "string");
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
