// Info Radar — collector.
// Runs in GitHub Actions (open network) on a schedule, or locally.
//   node src/collect.mjs
//
// Pipeline: RSS sources -> dedup -> Jina extract -> Pollinations score+summarize
//           -> keep relevant -> commit data/items.json -> ntfy digest push
//
// Zero npm dependencies. Node 18+ (uses built-in fetch).

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { parseFeed } from "./core/rss.mjs";
import { extractArticle } from "./core/extract.mjs";
import { analyzeItem, writeDigest } from "./core/llm.mjs";
import { idFor, loadStore, saveStore } from "./core/store.mjs";
import { pushDigest } from "./core/notify.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CONFIG_PATH = resolve(ROOT, "config/sources.json");
const STORE_PATH = resolve(ROOT, "data/items.json");
const WEB_PATH = resolve(ROOT, "web/items.json");

const nowIso = () => new Date().toISOString();

async function fetchText(url, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "info-radar/1.0 (+github actions)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// Simple bounded-concurrency map.
async function pool(items, limit, worker) {
  const out = [];
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return out;
}

async function main() {
  const cfg = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  const { profile, notify, sources } = cfg;
  const store = await loadStore(STORE_PATH);
  const seen = new Set(store.seen || []);
  store.seen = store.seen || [];

  // 1) Gather candidate items from all feeds.
  let candidates = [];
  for (const src of sources.filter((s) => s.type === "rss")) {
    try {
      const xml = await fetchText(src.url);
      const entries = parseFeed(xml);
      for (const e of entries) {
        const id = idFor(e.link);
        if (seen.has(id)) continue;
        candidates.push({ id, source: src.name, ...e });
      }
      console.log(`[collect] ${src.name}: ${entries.length} entries`);
    } catch (e) {
      console.log(`[collect] ${src.name} failed: ${e.message}`);
    }
  }

  // Dedup within this run and cap the workload.
  const uniq = new Map();
  for (const c of candidates) if (!uniq.has(c.id)) uniq.set(c.id, c);
  candidates = [...uniq.values()].slice(0, profile.max_items_per_run || 40);
  console.log(`[collect] ${candidates.length} new candidates to analyze`);

  // 2) Extract + analyze with bounded concurrency.
  const analyzed = await pool(candidates, 4, async (c) => {
    const fulltext = await extractArticle(c.link);
    const verdict = await analyzeItem({
      title: c.title,
      summary: c.summary,
      fulltext,
      interests: profile.interests,
      language: profile.language,
    });
    seen.add(c.id);
    if (!verdict) return null;
    return {
      id: c.id,
      title: c.title,
      link: c.link,
      source: c.source,
      published: c.published || null,
      collected_at: nowIso(),
      score: verdict.score,
      why: verdict.why,
      summary: verdict.summary,
      tags: verdict.tags,
    };
  });

  // 3) Keep relevant ones.
  const minScore = profile.min_score ?? 55;
  const kept = analyzed.filter((x) => x && x.score >= minScore);
  kept.sort((a, b) => b.score - a.score);
  console.log(`[collect] kept ${kept.length}/${candidates.length} (min_score=${minScore})`);

  // 4) Persist.
  store.items.unshift(...kept);
  store.seen = [...seen].slice(-5000); // cap memory of processed ids
  store.updated = nowIso();
  await saveStore(STORE_PATH, store, { keep: 1000 });

  // Public copy for the static frontend (no internal "seen" list).
  await writeFile(
    WEB_PATH,
    JSON.stringify({ updated: store.updated, items: store.items.slice(0, 500) }, null, 2) + "\n",
    "utf8"
  );

  // 5) Digest push.
  if (kept.length) {
    const topN = kept.slice(0, notify?.digest_top_n || 8);
    const text = await writeDigest({ items: topN, language: profile.language });
    const body =
      (text ? text + "\n\n" : "") +
      topN.map((it) => `• [${it.score}] ${it.title}\n  ${it.link}`).join("\n");
    const ok = await pushDigest({
      topic: process.env[notify?.ntfy_topic_env || "NTFY_TOPIC"],
      title: `📡 Info Radar — ${kept.length} new`,
      body,
      clickUrl: topN[0]?.link,
    });
    console.log(`[collect] digest push: ${ok ? "sent" : "skipped/failed"}`);
  } else {
    console.log("[collect] nothing relevant this run — no digest.");
  }

  console.log("[collect] done.");
}

main().catch((e) => {
  console.error("[collect] fatal:", e);
  process.exit(1);
});
