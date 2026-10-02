// ================================================================
// LEADERBOARD — db.js
// IndexedDB local store.
//
// Version 1 (original): one store — active_rounds (live round cache)
// Version 2 (local-first): five stores —
//   active_rounds  live round write-through cache (unchanged)
//   players        local player / friends list
//   courses        course definitions
//   rounds         completed and paused round history
//   settings       owner profile, theme, preferences
//
// The version-1 active_rounds store and all its functions are
// UNCHANGED so the existing live-scoring path keeps working.
// ================================================================

const DB_NAME    = 'leaderboard_local';
const DB_VERSION = 2;          // bumped from 1 to add new stores
const STORE_ACTIVE  = 'active_rounds';
const STORE_PLAYERS = 'players';
const STORE_COURSES = 'courses';
const STORE_ROUNDS  = 'rounds';
const STORE_SETTINGS = 'settings';

// ── Internal: open (or reuse) the database ──────────────────────
let _db = null;
function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = e => {
      const db      = e.target.result;
      const oldVer  = e.oldVersion;

      // Version 1 store — create only if not present (upgrade from scratch)
      if (!db.objectStoreNames.contains(STORE_ACTIVE)) {
        db.createObjectStore(STORE_ACTIVE, { keyPath: 'roundId' });
      }

      // Version 2 stores — only created on upgrade from v1 or fresh install
      if (oldVer < 2) {
        if (!db.objectStoreNames.contains(STORE_PLAYERS)) {
          const ps = db.createObjectStore(STORE_PLAYERS, { keyPath: 'id' });
          ps.createIndex('name',      'name',      { unique: false });
          ps.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_COURSES)) {
          const cs = db.createObjectStore(STORE_COURSES, { keyPath: 'id' });
          cs.createIndex('name',      'name',      { unique: false });
          cs.createIndex('isDefault', 'isDefault', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_ROUNDS)) {
          const rs = db.createObjectStore(STORE_ROUNDS, { keyPath: 'id' });
          rs.createIndex('status',      'status',      { unique: false });
          rs.createIndex('completedAt', 'completedAt', { unique: false });
          rs.createIndex('createdAt',   'createdAt',   { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
          db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
        }
      }
    };

    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror   = e => reject(e.target.error);
  });
}

// ── Generic helpers ──────────────────────────────────────────────
function idbGet(store, key) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = e => resolve(e.target.result ?? null);
    req.onerror   = e => reject(e.target.error);
  }));
}

function idbPut(store, record) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).put(record);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  }));
}

function idbDelete(store, key) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  }));
}

function idbGetAll(store) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const results = [];
    const req = db.transaction(store, 'readonly').objectStore(store).openCursor();
    req.onsuccess = e => {
      const cursor = e.target.result;
      if (cursor) { results.push(cursor.value); cursor.continue(); }
      else resolve(results);
    };
    req.onerror = e => reject(e.target.error);
  }));
}

function idbGetByIndex(store, indexName, value) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const results = [];
    const idx = db.transaction(store, 'readonly').objectStore(store).index(indexName);
    const req = idx.openCursor(IDBKeyRange.only(value));
    req.onsuccess = e => {
      const cursor = e.target.result;
      if (cursor) { results.push(cursor.value); cursor.continue(); }
      else resolve(results);
    };
    req.onerror = e => reject(e.target.error);
  }));
}

// Clear an entire store (used by backup restore)
function idbClearStore(store) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).clear();
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  }));
}

// Bulk-put many records into a store in a single transaction
function idbPutMany(store, records) {
  if (!records.length) return Promise.resolve();
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readwrite');
    const obj = tx.objectStore(store);
    records.forEach(r => obj.put(r));
    tx.oncomplete = () => resolve();
    tx.onerror    = e => reject(e.target.error);
  }));
}

// ================================================================
// ACTIVE ROUNDS — original API, unchanged
// ================================================================

export async function idbSave(roundId, state, dirty = true) {
  const db   = await openDB();
  const rec  = { roundId, state, dirty, savedAt: Date.now() };
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_ACTIVE, 'readwrite');
    const req = tx.objectStore(STORE_ACTIVE).put(rec);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

export async function idbLoad(roundId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_ACTIVE, 'readonly');
    const req = tx.objectStore(STORE_ACTIVE).get(roundId);
    req.onsuccess = e => resolve(e.target.result ?? null);
    req.onerror   = e => reject(e.target.error);
  });
}

export async function idbMarkClean(roundId) {
  const db  = await openDB();
  const rec = await idbLoad(roundId);
  if (!rec) return;
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_ACTIVE, 'readwrite');
    const req = tx.objectStore(STORE_ACTIVE).put({ ...rec, dirty: false });
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

export async function idbClear(roundId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_ACTIVE, 'readwrite');
    const req = tx.objectStore(STORE_ACTIVE).delete(roundId);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

export async function idbGetDirty() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx      = db.transaction(STORE_ACTIVE, 'readonly');
    const results = [];
    const req     = tx.objectStore(STORE_ACTIVE).openCursor();
    req.onsuccess = e => {
      const cursor = e.target.result;
      if (cursor) {
        if (cursor.value.dirty) results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    req.onerror = e => reject(e.target.error);
  });
}

// ================================================================
// PLAYERS store
// ================================================================

export const players = {
  get:    id      => idbGet(STORE_PLAYERS, id),
  getAll: ()      => idbGetAll(STORE_PLAYERS),
  put:    record  => idbPut(STORE_PLAYERS, record),
  delete: id      => idbDelete(STORE_PLAYERS, id),
  clear:  ()      => idbClearStore(STORE_PLAYERS),
  putMany: records => idbPutMany(STORE_PLAYERS, records),
};

// ================================================================
// COURSES store
// ================================================================

export const courses = {
  get:    id      => idbGet(STORE_COURSES, id),
  getAll: ()      => idbGetAll(STORE_COURSES),
  put:    record  => idbPut(STORE_COURSES, record),
  delete: id      => idbDelete(STORE_COURSES, id),
  clear:  ()      => idbClearStore(STORE_COURSES),
  putMany: records => idbPutMany(STORE_COURSES, records),
  getDefaults: () => idbGetByIndex(STORE_COURSES, 'isDefault', true),
};

// ================================================================
// ROUNDS store
// ================================================================

export const rounds = {
  get:    id      => idbGet(STORE_ROUNDS, id),
  getAll: ()      => idbGetAll(STORE_ROUNDS),
  put:    record  => idbPut(STORE_ROUNDS, record),
  delete: id      => idbDelete(STORE_ROUNDS, id),
  clear:  ()      => idbClearStore(STORE_ROUNDS),
  putMany: records => idbPutMany(STORE_ROUNDS, records),
  getByStatus: status => idbGetByIndex(STORE_ROUNDS, 'status', status),
};

// ================================================================
// SETTINGS store
// ================================================================

export const settings = {
  get:    key    => idbGet(STORE_SETTINGS, key).then(r => r?.value ?? null),
  set:    (key, value) => idbPut(STORE_SETTINGS, { key, value }),
  delete: key    => idbDelete(STORE_SETTINGS, key),
  getAll: ()     => idbGetAll(STORE_SETTINGS),
  clear:  ()     => idbClearStore(STORE_SETTINGS),
  putMany: records => idbPutMany(STORE_SETTINGS, records),
};
