// IndexedDB store for the second brain.
// Three object stores: "docs" (one per ingested item), "chunks" (text +
// embedding vector, many per doc), and "tombstones" (deletion markers so
// removals propagate across devices via sync). Everything stays on-device.

const DB_NAME = "second-brain";
const DB_VERSION = 2;

let _db = null;

export function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("docs")) {
        db.createObjectStore("docs", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("chunks")) {
        const cs = db.createObjectStore("chunks", { keyPath: "id" });
        cs.createIndex("docId", "docId", { unique: false });
      }
      if (!db.objectStoreNames.contains("tombstones")) {
        db.createObjectStore("tombstones", { keyPath: "id" });
      }
    };
    req.onsuccess = () => {
      _db = req.result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode) {
  return openDB().then((db) => db.transaction(store, mode).objectStore(store));
}

function reqToPromise(req) {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export async function putDoc(doc) {
  return reqToPromise((await tx("docs", "readwrite")).put(doc));
}

export async function getDocs() {
  const docs = await reqToPromise((await tx("docs", "readonly")).getAll());
  return docs.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

export async function putChunks(chunks) {
  const store = await tx("chunks", "readwrite");
  await Promise.all(chunks.map((c) => reqToPromise(store.put(c))));
}

export async function getAllChunks() {
  return reqToPromise((await tx("chunks", "readonly")).getAll());
}

export async function getDoc(id) {
  return reqToPromise((await tx("docs", "readonly")).get(id));
}

export async function getAllTombstones() {
  return reqToPromise((await tx("tombstones", "readonly")).getAll());
}

export async function putTombstone(t) {
  return reqToPromise((await tx("tombstones", "readwrite")).put(t));
}

// Remove a doc and its chunks (no tombstone written) — internal helper.
function removeDocData(docId) {
  return openDB().then(
    (db) =>
      new Promise((res, rej) => {
        const t = db.transaction(["docs", "chunks"], "readwrite");
        t.objectStore("docs").delete(docId);
        const idx = t.objectStore("chunks").index("docId");
        const cur = idx.openCursor(IDBKeyRange.only(docId));
        cur.onsuccess = () => {
          const c = cur.result;
          if (c) {
            c.delete();
            c.continue();
          }
        };
        t.oncomplete = () => res();
        t.onerror = () => rej(t.error);
      })
  );
}

// Public delete: remove the doc AND record a tombstone so the deletion
// propagates to other devices on the next sync.
export async function deleteDoc(docId) {
  const doc = await getDoc(docId);
  await removeDocData(docId);
  await putTombstone({ id: docId, source: doc?.source || null, deletedAt: Date.now() });
}

export async function exportAll() {
  const [docs, chunks, tombstones] = await Promise.all([
    getDocs(),
    getAllChunks(),
    getAllTombstones(),
  ]);
  return { version: 2, exportedAt: new Date().toISOString(), docs, chunks, tombstones };
}

// --- Pure deletion-reconciliation helpers (no IndexedDB; unit-testable) ---

// Union of tombstones, keeping the latest deletedAt per id.
export function mergeTombstones(existing, incoming) {
  const m = new Map((existing || []).map((t) => [t.id, t]));
  for (const t of incoming || []) {
    if (!t || !t.id) continue;
    const prev = m.get(t.id);
    if (!prev || (t.deletedAt || 0) > (prev.deletedAt || 0)) m.set(t.id, t);
  }
  return [...m.values()];
}

// Ids of docs that a tombstone deletes: present and not newer than the marker.
// A genuine re-add (addedAt > deletedAt) survives.
export function docsToRemove(tombstones, docs) {
  const byId = new Map((docs || []).map((d) => [d.id, d]));
  const out = [];
  for (const t of tombstones || []) {
    const doc = byId.get(t.id);
    if (doc && (doc.addedAt || 0) <= (t.deletedAt || 0)) out.push(t.id);
  }
  return out;
}

// Merge incoming data, then reconcile deletions: a tombstone removes any doc
// whose addedAt is not newer than the tombstone's deletedAt. Tombstones are
// kept (and merged latest-wins) so deletions keep propagating, while a genuine
// re-add (newer addedAt) survives.
export async function importAll(data) {
  if (!data || !Array.isArray(data.docs) || !Array.isArray(data.chunks)) {
    throw new Error("백업 형식이 올바르지 않습니다.");
  }
  const merged = mergeTombstones(await getAllTombstones(), data.tombstones);
  for (const t of merged) await putTombstone(t);
  for (const d of data.docs) await putDoc(d);
  await putChunks(data.chunks);
  const remove = docsToRemove(merged, await getDocs());
  for (const id of remove) await removeDocData(id);
  return { docs: data.docs.length, chunks: data.chunks.length, removed: remove.length };
}

export async function clearAll() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction(["docs", "chunks", "tombstones"], "readwrite");
    t.objectStore("docs").clear();
    t.objectStore("chunks").clear();
    t.objectStore("tombstones").clear();
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}
