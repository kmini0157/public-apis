// Auto-tagging + clustering of notes, fully on-device (no LLM, no network).
// Doc vectors = mean of chunk vectors; clusters = connected components over
// a cosine-similarity threshold; tags = simple keyword extraction.

import { cosine } from "./vec.js";
import { getAllChunks } from "./db.js";

// Light stopword list (Korean particles/verbs + common English) for tagging.
const STOP = new Set(
  ("the a an and or of to in is are was were be for on with at by from this that these those it its as " +
    "을 를 이 가 은 는 에 의 도 와 과 로 으로 에서 에게 한 하다 있다 없다 되다 등 및 수 것 그 저 위해 통해 대한 " +
    "그리고 하지만 또는 또한 때문 같은 더 매우 정말 모든 어떤")
    .split(/\s+/)
);

// Strip a single trailing Korean particle from longer tokens to clean tags.
function departicle(t) {
  if (t.length >= 3 && /[가-힣]$/.test(t) && /[을를이가은는에의도와과로]$/.test(t)) {
    return t.slice(0, -1);
  }
  return t;
}

// Top-k keywords from text -> used as auto-tags on a document.
export function keywords(text, k = 5) {
  const freq = new Map();
  for (const raw of (text || "").toLowerCase().split(/[^0-9a-z가-힣]+/)) {
    let t = raw.trim();
    if (!t) continue;
    t = departicle(t);
    if (t.length < 2 || STOP.has(t) || /^\d+$/.test(t)) continue;
    freq.set(t, (freq.get(t) || 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, k)
    .map(([w]) => w);
}

// Mean-pool each document's chunk vectors into a single normalized vector.
export async function docVectors(chunks) {
  chunks = chunks || (await getAllChunks());
  const byDoc = new Map();
  for (const c of chunks) {
    if (!Array.isArray(c.vec)) continue;
    let e = byDoc.get(c.docId);
    if (!e) {
      e = { docId: c.docId, title: c.title, source: c.source, sum: new Array(c.vec.length).fill(0), n: 0 };
      byDoc.set(c.docId, e);
    }
    for (let i = 0; i < c.vec.length; i++) e.sum[i] += c.vec[i];
    e.n++;
  }
  const out = [];
  for (const e of byDoc.values()) {
    let norm = 0;
    const v = e.sum.map((x) => x / e.n);
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    out.push({ docId: e.docId, title: e.title, source: e.source, vec: v.map((x) => x / norm) });
  }
  return out;
}

// Greedy connected-components clustering (union-find) by cosine >= threshold.
// Returns clusters sorted largest-first; singletons included.
export function clusterDocs(docVecs, threshold = 0.6) {
  const n = docVecs.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => {
    parent[find(a)] = find(b);
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (cosine(docVecs[i].vec, docVecs[j].vec) >= threshold) union(i, j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(docVecs[i]);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

// Normalized mean (centroid) of a set of vectors.
export function centroid(vectors) {
  if (!vectors.length) return [];
  const dim = vectors[0].length;
  const sum = new Array(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) sum[i] += v[i];
  const mean = sum.map((x) => x / vectors.length);
  let n = 0;
  for (const x of mean) n += x * x;
  n = Math.sqrt(n) || 1;
  return mean.map((x) => x / n);
}

function leadSentence(text, max = 180) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  const m = clean.match(/^.*?[.!?。？！](\s|$)/);
  let s = m ? m[0].trim() : clean;
  if (s.length > max) s = s.slice(0, max).trim() + "…";
  return s;
}

// Extractive, on-device cluster summary: take a leading sentence from the most
// central chunk of each of the k member docs nearest the cluster centroid (one
// bullet per distinct doc, for coverage). Keyless and language-agnostic.
export function summarizeCluster(members, chunks, k = 3) {
  const cen = centroid(members.map((m) => m.vec));
  if (!cen.length) return [];
  const memberIds = new Set(members.map((m) => m.docId));
  const scored = chunks
    .filter((c) => memberIds.has(c.docId) && Array.isArray(c.vec))
    .map((c) => ({ c, score: cosine(cen, c.vec) }))
    .sort((a, b) => b.score - a.score);
  const picked = [];
  const usedDocs = new Set();
  for (const { c } of scored) {
    if (usedDocs.has(c.docId)) continue; // one line per doc, for coverage
    usedDocs.add(c.docId);
    const s = leadSentence(c.text);
    if (s) picked.push(s);
    if (picked.length >= k) break;
  }
  return picked;
}

// Find duplicate / near-duplicate docs: same source OR cosine >= threshold.
// Returns groups of size >= 2 (the candidates to merge/dedupe).
export function findDuplicates(docVecs, threshold = 0.95) {
  const n = docVecs.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => {
    parent[find(a)] = find(b);
  };
  const bySource = new Map();
  for (let i = 0; i < n; i++) {
    const s = docVecs[i].source;
    if (!s) continue;
    if (bySource.has(s)) union(bySource.get(s), i);
    else bySource.set(s, i);
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (cosine(docVecs[i].vec, docVecs[j].vec) >= threshold) union(i, j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(docVecs[i]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

// A short label for a cluster: most common auto-tags across its members.
export function clusterLabel(members, docTagsById) {
  const freq = new Map();
  for (const m of members) {
    for (const tag of docTagsById.get(m.docId) || []) {
      freq.set(tag, (freq.get(tag) || 0) + 1);
    }
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w);
  return top.length ? top.join(" · ") : members[0]?.title?.slice(0, 24) || "묶음";
}
