// Item store: a plain JSON file committed back to the repo (free, versioned).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

export function idFor(url) {
  return createHash("sha1").update(url).digest("hex").slice(0, 16);
}

export async function loadStore(path) {
  try {
    const raw = await readFile(path, "utf8");
    const data = JSON.parse(raw);
    if (Array.isArray(data.items)) return data;
  } catch {}
  return { updated: null, items: [] };
}

export async function saveStore(path, store, { keep = 1000 } = {}) {
  // newest first, cap total size so the committed file stays small.
  store.items.sort((a, b) => (b.collected_at || "").localeCompare(a.collected_at || ""));
  store.items = store.items.slice(0, keep);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(store, null, 2) + "\n", "utf8");
}
