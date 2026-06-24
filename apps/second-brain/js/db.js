// IndexedDB store for the second brain.
// Two object stores: "docs" (one per ingested item) and "chunks"
// (text + embedding vector, many per doc). Everything stays on-device.

const DB_NAME = "second-brain";
const DB_VERSION = 1;

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

export async function deleteDoc(docId) {
  const db = await openDB();
  return new Promise((res, rej) => {
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
  });
}

export async function exportAll() {
  const [docs, chunks] = await Promise.all([getDocs(), getAllChunks()]);
  return { version: 1, exportedAt: new Date().toISOString(), docs, chunks };
}

export async function importAll(data) {
  if (!data || !Array.isArray(data.docs) || !Array.isArray(data.chunks)) {
    throw new Error("백업 형식이 올바르지 않습니다.");
  }
  for (const d of data.docs) await putDoc(d);
  await putChunks(data.chunks);
  return { docs: data.docs.length, chunks: data.chunks.length };
}

export async function clearAll() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction(["docs", "chunks"], "readwrite");
    t.objectStore("docs").clear();
    t.objectStore("chunks").clear();
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}
