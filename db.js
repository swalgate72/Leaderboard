// ================================================================
// LEADERBOARD — db.js
// IndexedDB local store for live round state.
// Scores write here instantly; Supabase sync runs every 30 seconds.
// No UI, no Supabase calls — pure local storage only.
// ================================================================

const DB_NAME    = 'leaderboard_local';
const DB_VERSION = 1;
const STORE      = 'active_rounds';

// ── Internal: open (or reuse) the database ──────────────────────
let _db = null;
function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        // key = roundId (string UUID)
        db.createObjectStore(STORE, { keyPath: 'roundId' });
      }
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror   = e => reject(e.target.error);
  });
}

// ── Write a round's state locally ───────────────────────────────
// dirty = true  → needs pushing to Supabase
// dirty = false → just synced, no push needed
export async function idbSave(roundId, state, dirty = true) {
  const db   = await openDB();
  const rec  = { roundId, state, dirty, savedAt: Date.now() };
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).put(rec);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

// ── Read a round's state ─────────────────────────────────────────
export async function idbLoad(roundId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(roundId);
    req.onsuccess = e => resolve(e.target.result ?? null);
    req.onerror   = e => reject(e.target.error);
  });
}

// ── Mark a round as clean (just pushed to Supabase) ─────────────
export async function idbMarkClean(roundId) {
  const db  = await openDB();
  const rec = await idbLoad(roundId);
  if (!rec) return;
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).put({ ...rec, dirty: false });
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

// ── Delete a round's local record (on complete or delete) ────────
export async function idbClear(roundId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).delete(roundId);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

// ── Get all dirty rounds (for sync loop) ────────────────────────
export async function idbGetDirty() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx      = db.transaction(STORE, 'readonly');
    const results = [];
    const req     = tx.objectStore(STORE).openCursor();
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
