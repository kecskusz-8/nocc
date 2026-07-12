// Persists exchanged keys, keyed by (channel, owning user), per
// ARCHITECTURE.md's key storage section. Records are always inserted, never
// overwritten, since a (channel, uidHash) pair accumulates history over
// time. No rotation/pruning logic yet — just storage and lookup.

const DB_NAME = 'nocc';
const DB_VERSION = 1;
const STORE = 'keys';

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('by_channel_user', ['channel', 'uidHash']);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

export async function saveKey({ channel, uidHash, token, createdAt = Date.now() }) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const request = tx.objectStore(STORE).add({ channel, uidHash, token, createdAt });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getKeysFor(channel, uidHash) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const index = tx.objectStore(STORE).index('by_channel_user');
    const request = index.getAll([channel, uidHash]);
    request.onsuccess = () => resolve(request.result.sort((a, b) => b.createdAt - a.createdAt));
    request.onerror = () => reject(request.error);
  });
}

export async function getAllKeys() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
