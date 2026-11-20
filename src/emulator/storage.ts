/**
 * Lightweight browser IndexedDB storage for persisting user-uploaded
 * Kickstart ROMs, ADF disk images, and save-state snapshots locally.
 */

import {
  SAVE_SLOT_INDICES,
  SaveSlotData,
  SaveSlotIndex,
  SaveSlotSummary,
  SerializedAmigaState,
} from './types';

const DB_NAME = 'amiga500_ocsecs_db';
const DB_VERSION = 1;
const STORE_FILES = 'files';

export interface StoredBinaryFile {
  key: string;
  name: string;
  bytes: Uint8Array;
  savedAt: number;
}

let cachedDbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (cachedDbPromise) return cachedDbPromise;
  cachedDbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_FILES)) {
          db.createObjectStore(STORE_FILES, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onclose = () => {
          cachedDbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        cachedDbPromise = null;
        resolve(null);
      };
    } catch {
      cachedDbPromise = null;
      resolve(null);
    }
  });
  return cachedDbPromise;
}

export async function saveBinaryToStorage(key: string, name: string, bytes: Uint8Array): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_FILES, 'readwrite');
    tx.objectStore(STORE_FILES).put({
      key,
      name,
      bytes,
      savedAt: Date.now(),
    } satisfies StoredBinaryFile);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function loadBinaryFromStorage(key: string): Promise<StoredBinaryFile | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_FILES, 'readonly');
    const req = tx.objectStore(STORE_FILES).get(key);
    req.onsuccess = () => resolve((req.result as StoredBinaryFile) ?? null);
    req.onerror = () => resolve(null);
  });
}

export async function deleteFromStorage(key: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_FILES, 'readwrite');
    tx.objectStore(STORE_FILES).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function saveStateSnapshot(slot: string, state: SerializedAmigaState): Promise<void> {
  const json = JSON.stringify(state);
  const bytes = new TextEncoder().encode(json);
  await saveBinaryToStorage(`savestate_${slot}`, `Slot ${slot}`, bytes);
}

export async function loadStateSnapshot(slot: string): Promise<SerializedAmigaState | null> {
  const rec = await loadBinaryFromStorage(`savestate_${slot}`);
  if (!rec) return null;
  try {
    const json = new TextDecoder().decode(rec.bytes);
    return JSON.parse(json) as SerializedAmigaState;
  } catch {
    return null;
  }
}

export function createEmptySlotMap(): Record<SaveSlotIndex, SaveSlotSummary | null> {
  return {
    1: null,
    2: null,
    3: null,
    4: null,
    5: null,
  };
}

export async function saveSlotData(slot: SaveSlotIndex, data: SaveSlotData): Promise<SaveSlotSummary> {
  const summary: SaveSlotSummary = {
    slot,
    timestamp: data.timestamp,
    df0Name: data.df0Disk?.name ?? '',
    df1Name: data.df1Disk?.name ?? '',
    screenshotDataUrl: data.screenshotDataUrl,
  };

  const db = await openDb();
  if (!db) return summary;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_FILES, 'readwrite');
      const store = tx.objectStore(STORE_FILES);
      store.put({ key: `savestate_meta_${slot}`, summary });
      store.put({ key: `savestate_data_${slot}`, payload: data });
      tx.oncomplete = () => resolve(summary);
      tx.onerror = () => resolve(summary);
    } catch {
      resolve(summary);
    }
  });
}

export async function loadSlotData(slot: SaveSlotIndex): Promise<SaveSlotData | null> {
  const db = await openDb();
  if (!db) return null;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_FILES, 'readonly');
      const req = tx.objectStore(STORE_FILES).get(`savestate_data_${slot}`);
      req.onsuccess = () => {
        const rec = req.result as { payload?: SaveSlotData } | undefined;
        resolve(rec?.payload ?? null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function listSaveSlotSummaries(): Promise<Record<SaveSlotIndex, SaveSlotSummary | null>> {
  const empty = createEmptySlotMap();
  const db = await openDb();
  if (!db) return empty;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_FILES, 'readonly');
      const store = tx.objectStore(STORE_FILES);
      const out = createEmptySlotMap();

      for (const slot of SAVE_SLOT_INDICES) {
        const req = store.get(`savestate_meta_${slot}`);
        req.onsuccess = () => {
          const rec = req.result as { summary?: SaveSlotSummary } | undefined;
          if (rec?.summary) {
            out[slot] = rec.summary;
          }
        };
      }

      tx.oncomplete = () => resolve(out);
      tx.onerror = () => resolve(empty);
    } catch {
      resolve(empty);
    }
  });
}

export async function deleteSlotData(slot: SaveSlotIndex): Promise<void> {
  const db = await openDb();
  if (!db) return;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_FILES, 'readwrite');
      const store = tx.objectStore(STORE_FILES);
      store.delete(`savestate_meta_${slot}`);
      store.delete(`savestate_data_${slot}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

