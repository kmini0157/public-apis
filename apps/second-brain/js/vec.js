// Pure vector math, dependency-free (kept separate from embed.js so it can be
// used/tested without loading the transformers.js model bundle).

// Vectors from the embedder are L2-normalized, so dot product == cosine.
export function cosine(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
