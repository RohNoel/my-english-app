import type { PersistedMasterVideoInfo, VisualStyleId } from '../types';

const DB_NAME = 'cinelingo_video_vault_v1';
const DB_VERSION = 1;
const STORE_MASTERS = 'masters';

export interface IndexedDbMasterRecord {
  style: VisualStyleId;
  info: PersistedMasterVideoInfo;
  cleanBlob: Blob;
  subtitledBlob: Blob;
  savedAt: string;
}

function openVaultDb(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || !('indexedDB' in window)) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const req = window.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_MASTERS)) {
          db.createObjectStore(STORE_MASTERS, { keyPath: 'style' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function saveMasterToIndexedDb(params: {
  style: VisualStyleId;
  info: PersistedMasterVideoInfo;
  cleanBlob: Blob;
  subtitledBlob: Blob;
}): Promise<boolean> {
  const db = await openVaultDb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_MASTERS, 'readwrite');
      const store = tx.objectStore(STORE_MASTERS);
      const record: IndexedDbMasterRecord = {
        style: params.style,
        info: params.info,
        cleanBlob: params.cleanBlob,
        subtitledBlob: params.subtitledBlob,
        savedAt: new Date().toISOString(),
      };
      store.put(record);
      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onerror = () => {
        db.close();
        resolve(false);
      };
    } catch {
      db.close();
      resolve(false);
    }
  });
}

export async function loadMasterFromIndexedDb(
  style: VisualStyleId
): Promise<IndexedDbMasterRecord | null> {
  const db = await openVaultDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_MASTERS, 'readonly');
      const store = tx.objectStore(STORE_MASTERS);
      const req = store.get(style);
      req.onsuccess = () => {
        const rec = req.result as IndexedDbMasterRecord | undefined;
        db.close();
        if (rec && rec.cleanBlob instanceof Blob && rec.cleanBlob.size > 4096) {
          resolve(rec);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => {
        db.close();
        resolve(null);
      };
    } catch {
      db.close();
      resolve(null);
    }
  });
}

export async function listIndexedDbMasters(): Promise<IndexedDbMasterRecord[]> {
  const db = await openVaultDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_MASTERS, 'readonly');
      const store = tx.objectStore(STORE_MASTERS);
      const req = store.getAll();
      req.onsuccess = () => {
        const list = (req.result as IndexedDbMasterRecord[] | undefined) ?? [];
        db.close();
        resolve(
          list.filter((rec) => rec && rec.cleanBlob instanceof Blob && rec.cleanBlob.size > 4096)
        );
      };
      req.onerror = () => {
        db.close();
        resolve([]);
      };
    } catch {
      db.close();
      resolve([]);
    }
  });
}
