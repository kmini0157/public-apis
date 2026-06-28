// Local, keyless text embeddings via transformers.js (runs in the browser).
// Model: Xenova/all-MiniLM-L6-v2 -> 384-dim normalized vectors.

import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2";
import { cosine } from "./vec.js";

export { cosine };

// Cache the downloaded model in the browser so subsequent loads are instant.
env.allowLocalModels = false;
env.useBrowserCache = true;

let _extractor = null;
let _loading = null;

export function isReady() {
  return !!_extractor;
}

// progressCb receives transformers.js progress events (for a loading bar).
export async function loadModel(progressCb) {
  if (_extractor) return _extractor;
  if (_loading) return _loading;
  _loading = pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
    progress_callback: progressCb,
  }).then((p) => {
    _extractor = p;
    _loading = null;
    return p;
  });
  return _loading;
}

// Embed a single string -> Float array (length 384).
export async function embed(text) {
  const ex = await loadModel();
  const out = await ex(text, { pooling: "mean", normalize: true });
  return Array.from(out.data);
}

// Embed many strings sequentially (keeps memory low on phones).
export async function embedBatch(texts, onEach) {
  const out = [];
  for (let i = 0; i < texts.length; i++) {
    out.push(await embed(texts[i]));
    if (onEach) onEach(i + 1, texts.length);
  }
  return out;
}
