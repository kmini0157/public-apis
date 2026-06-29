// Second Brain — UI controller. Wires the DOM to ingestion, embedding,
// storage, semantic search, and the RAG chat. All on-device.

import { loadModel, embedBatch } from "./embed.js";
import * as db from "./db.js";
import * as ex from "./extract.js";
import { ask } from "./rag.js";
import { Recorder, transcribe } from "./voice.js";
import { encryptJSON, decryptJSON, isEncrypted } from "./crypto.js";
import {
  keywords,
  docVectors,
  clusterDocs,
  clusterLabel,
  summarizeCluster,
  findDuplicates,
} from "./cluster.js";
import { Sync } from "./sync.js";

const lsGet = (k, d = "") => localStorage.getItem(k) ?? d;
const lsSet = (k, v) => localStorage.setItem(k, v ?? "");
const LS = {
  get url() { return lsGet("sb.radarUrl"); },
  set url(v) { lsSet("sb.radarUrl", v); },
  get auto() { return lsGet("sb.radarAuto") === "1"; },
  set auto(v) { lsSet("sb.radarAuto", v ? "1" : "0"); },
  // Multi-device sync config (stored locally; backend only sees ciphertext).
  get syncUrl() { return lsGet("sb.syncUrl"); },
  set syncUrl(v) { lsSet("sb.syncUrl", v); },
  get syncKey() { return lsGet("sb.syncKey"); },
  set syncKey(v) { lsSet("sb.syncKey", v); },
  get syncPass() { return lsGet("sb.syncPass"); },
  set syncPass(v) { lsSet("sb.syncPass", v); },
  get syncOn() { return lsGet("sb.syncOn") === "1"; },
  set syncOn(v) { lsSet("sb.syncOn", v ? "1" : "0"); },
  // Whether to persist the passphrase on this device (off => session-only).
  get syncRemember() { return lsGet("sb.syncRemember", "1") === "1"; },
  set syncRemember(v) { lsSet("sb.syncRemember", v ? "1" : "0"); },
  // Cluster sensitivity (slider value 40–85 -> cosine threshold 0.40–0.85).
  get clusterThreshold() { return parseInt(lsGet("sb.clusterThreshold", "60"), 10); },
  set clusterThreshold(v) { lsSet("sb.clusterThreshold", String(v)); },
};

const $ = (s) => document.querySelector(s);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2200);
}

function setStatus(s) {
  $("#status").textContent = s;
}

function showProgress(frac, text) {
  const bar = $("#progress");
  if (frac == null) {
    bar.style.display = "none";
    $("#progressText").textContent = "";
    return;
  }
  bar.style.display = "block";
  bar.querySelector("i").style.width = Math.round(frac * 100) + "%";
  $("#progressText").textContent = text || "";
}

// ---- Ingestion ----------------------------------------------------------

async function ingest(parsed) {
  if (!parsed.text || parsed.text.trim().length < 20) {
    toast("내용이 너무 짧습니다.");
    return;
  }
  const chunks = ex.chunkText(parsed.text);
  if (!chunks.length) {
    toast("청크를 만들 수 없습니다.");
    return;
  }
  showProgress(0, `임베딩 0/${chunks.length}…`);
  const vecs = await embedBatch(chunks, (done, total) =>
    showProgress(done / total, `임베딩 ${done}/${total}…`)
  );
  const docId = uid();
  const now = Date.now();
  await db.putDoc({
    id: docId,
    title: parsed.title,
    source: parsed.source,
    chunkCount: chunks.length,
    addedAt: now,
    tags: keywords(parsed.text),
  });
  await db.putChunks(
    chunks.map((text, i) => ({
      id: `${docId}:${i}`,
      docId,
      title: parsed.title,
      source: parsed.source,
      text,
      vec: vecs[i],
    }))
  );
  showProgress(null);
  await renderDocs();
  maybeAutoPush();
  toast(`저장 완료: ${parsed.title} (${chunks.length}청크)`);
}

// Bulk ingest (e.g. Info Radar). Dedupes against already-stored sources,
// embeds every chunk across all new docs in one pass.
async function ingestMany(parsedList, label = "항목") {
  // Dedup against already-stored sources AND within this batch itself.
  const seen = new Set((await db.getDocs()).map((d) => d.source));
  const fresh = [];
  for (const p of parsedList) {
    if (p.source && !seen.has(p.source)) {
      seen.add(p.source);
      fresh.push(p);
    }
  }
  if (!fresh.length) {
    toast("새로 가져올 항목이 없습니다 (모두 중복).");
    return;
  }
  // Build chunk list with provenance back to each doc.
  const jobs = [];
  for (const p of fresh) {
    const chunks = ex.chunkText(p.text);
    if (!chunks.length) continue;
    const docId = uid();
    jobs.push({ docId, parsed: p, chunks });
  }
  const flat = jobs.flatMap((j) => j.chunks);
  showProgress(0, `임베딩 0/${flat.length}…`);
  const vecs = await embedBatch(flat, (done, total) =>
    showProgress(done / total, `임베딩 ${done}/${total}…`)
  );
  let vi = 0;
  const now = Date.now();
  for (const j of jobs) {
    await db.putDoc({
      id: j.docId,
      title: j.parsed.title,
      source: j.parsed.source,
      chunkCount: j.chunks.length,
      addedAt: now,
      tags: keywords(j.parsed.text),
    });
    await db.putChunks(
      j.chunks.map((text, i) => ({
        id: `${j.docId}:${i}`,
        docId: j.docId,
        title: j.parsed.title,
        source: j.parsed.source,
        text,
        vec: vecs[vi++],
      }))
    );
  }
  showProgress(null);
  await renderDocs();
  maybeAutoPush();
  toast(`가져옴: ${jobs.length}개 ${label} (${flat.length}청크)`);
}

async function guardedIngest(fn) {
  try {
    setStatus("처리 중…");
    await loadModel((p) => {
      if (p?.status === "progress" && p.total) {
        showProgress(p.loaded / p.total, `모델 다운로드 ${(p.progress || 0).toFixed(0)}%`);
      }
    });
    await fn();
    setStatus("준비됨");
  } catch (e) {
    showProgress(null);
    setStatus("준비됨");
    toast("오류: " + e.message);
    console.error(e);
  }
}

// ---- Rendering ----------------------------------------------------------

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function renderDocs() {
  const docs = await db.getDocs();
  $("#docCount").textContent = docs.length;
  $("#docs").innerHTML =
    docs
      .map((d) => {
        const isUrl = /^https?:/.test(d.source || "");
        const src = isUrl
          ? `<a href="${esc(d.source)}" target="_blank" rel="noopener">${esc(new URL(d.source).hostname)}</a>`
          : esc(d.source || "");
        const tags = (d.tags || []).length
          ? `<div class="tags">${d.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>`
          : "";
        return `<div class="doc">
          <div class="t">${esc(d.title)}</div>
          <div class="m">${src} · ${d.chunkCount || 0}청크 · ${new Date(d.addedAt).toLocaleDateString("ko-KR")}
            <button class="del" data-id="${d.id}" title="삭제">✕</button></div>
          ${tags}
        </div>`;
      })
      .join("") || '<div class="muted">아직 없음. 왼쪽 위에서 추가하세요.</div>';
}

function addMsg(role, text) {
  const log = $("#chatlog");
  const div = document.createElement("div");
  div.className = "msg " + role;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

// ---- Clustering (auto-grouping of similar notes) ------------------------

async function renderClusters() {
  $("#clusterInfo").textContent = "분석 중…";
  const [docs, chunks] = await Promise.all([db.getDocs(), db.getAllChunks()]);
  const vecs = await docVectors(chunks);
  const tagsById = new Map(docs.map((d) => [d.id, d.tags || []]));
  const groups = clusterDocs(vecs, LS.clusterThreshold / 100);
  const multi = groups.filter((g) => g.length > 1);
  const singles = groups.filter((g) => g.length === 1).flat();
  $("#clusterInfo").textContent = `${vecs.length}개 노트 · ${multi.length}개 묶음 · 단독 ${singles.length}`;
  if (!vecs.length) {
    $("#clusters").innerHTML = '<div class="muted">먼저 노트를 추가하세요.</div>';
    return;
  }
  const member = (m) => {
    const isUrl = /^https?:/.test(m.source || "");
    const link = isUrl ? ` <a href="${esc(m.source)}" target="_blank" rel="noopener">↗</a>` : "";
    return `<div class="member">• ${esc(m.title)}${link}</div>`;
  };
  let html = multi
    .map((g) => {
      const summary = summarizeCluster(g, chunks);
      const sum = summary.length
        ? `<div class="summary">${summary.map((s) => `<div>• ${esc(s)}</div>`).join("")}</div>`
        : "";
      return `<div class="cluster"><h4>${esc(clusterLabel(g, tagsById))} <span class="muted">(${g.length})</span></h4>${sum}${g
        .map(member)
        .join("")}</div>`;
    })
    .join("");
  if (singles.length) {
    html += `<div class="cluster"><h4 class="muted">단독 노트 <span class="muted">(${singles.length})</span></h4>${singles
      .map(member)
      .join("")}</div>`;
  }
  $("#clusters").innerHTML = html || '<div class="muted">묶을 노트가 부족합니다.</div>';
}

// ---- Duplicate / conflict resolution ------------------------------------

async function renderDups() {
  $("#dupInfo").textContent = "검사 중…";
  const [docs, vecs] = await Promise.all([db.getDocs(), docVectors()]);
  const addedById = new Map(docs.map((d) => [d.id, d.addedAt || 0]));
  const groups = findDuplicates(vecs);
  $("#dupInfo").textContent = groups.length ? `${groups.length}개 중복 그룹` : "중복 없음 ✓";
  $("#dups").innerHTML = groups.length
    ? groups
        .map((g, gi) => {
          // newest first, so "keep newest" is the obvious default at the top
          const sorted = [...g].sort((a, b) => (addedById.get(b.docId) || 0) - (addedById.get(a.docId) || 0));
          const members = sorted
            .map((m) => {
              const when = new Date(addedById.get(m.docId) || 0).toLocaleDateString("ko-KR");
              return `<div class="member">• ${esc(m.title)} <span class="muted">(${when})</span>
                <button class="keep" data-keep="${m.docId}" data-group="${gi}">이거 남기고 정리</button></div>`;
            })
            .join("");
          return `<div class="cluster" data-group="${gi}"><h4 class="muted">중복 ${g.length}개</h4>${members}</div>`;
        })
        .join("")
    : '<div class="muted">중복/충돌이 없습니다.</div>';
  // stash group membership for the merge action
  renderDups._groups = groups;
}

async function mergeDupGroup(groupIndex, keepId) {
  const group = (renderDups._groups || [])[groupIndex];
  if (!group) return;
  const toDelete = group.filter((m) => m.docId !== keepId);
  if (!toDelete.length) return;
  if (!confirm(`${toDelete.length}개 중복 노트를 삭제하고 1개만 남길까요? (삭제는 다른 기기에도 전파됩니다)`)) return;
  for (const m of toDelete) await db.deleteDoc(m.docId);
  await renderDocs();
  await renderDups();
  maybeAutoPush();
  toast(`${toDelete.length}개 중복 정리됨`);
}

// ---- Multi-device sync state -------------------------------------------

let sync = null;
let pushTimer = null;

// Debounced push after local changes when sync is active. Pin the push to the
// exact connection that was live when the change happened: if sync was stopped
// or replaced (reconnect) before the timer fires, skip — never push through a
// different instance or dereference a null one.
function maybeAutoPush() {
  const s = sync;
  if (!s) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    if (sync !== s) return;
    s.push()
      .then(() => setSyncStatus("동기화됨 ✓"))
      .catch((e) => setSyncStatus("올리기 실패: " + e.message));
  }, 1500);
}

function setSyncStatus(s) {
  $("#syncStatus").textContent = s;
}

async function startSync({ silent = false, pass } = {}) {
  try {
    sync = new Sync({
      url: LS.syncUrl,
      anonKey: LS.syncKey,
      // Use the explicit passphrase (manual connect) or the remembered one
      // (auto-resume). When "remember" is off, LS.syncPass is empty by design.
      passphrase: pass != null ? pass : LS.syncPass,
      onChange: async (r) => {
        await renderDocs();
        toast(
          r?.removed
            ? `다른 기기 변경 반영 (삭제 ${r.removed}건 포함)`
            : "다른 기기 변경사항을 받았습니다."
        );
      },
    });
    await sync.init();
    setSyncStatus("연결됨 · 받는 중…");
    await sync.pull();
    await renderDocs();
    await sync.push(); // share what this device has
    sync.start();
    LS.syncOn = true;
    setSyncStatus("동기화 중 ✓ (자동)");
  } catch (e) {
    sync = null;
    LS.syncOn = false;
    setSyncStatus("연결 실패: " + e.message);
    if (!silent) toast("동기화 연결 실패: " + e.message);
  }
}

// ---- Chat ---------------------------------------------------------------

async function handleAsk() {
  const q = $("#ask").value.trim();
  if (!q) return;
  $("#ask").value = "";
  addMsg("u", q);
  const bubble = addMsg("a", "생각 중…");
  const log = $("#chatlog");
  try {
    await loadModel();
    const { hits } = await ask(q, {
      onToken: (full) => {
        bubble.textContent = full;
        log.scrollTop = log.scrollHeight;
      },
    });
    $("#hits").innerHTML = hits
      .map(
        (h, i) =>
          `<div class="hit"><span class="s">${(h.score * 100).toFixed(0)}%</span> [${i + 1}] ${esc(h.title)}<br><span class="muted">${esc(h.text.slice(0, 220))}…</span></div>`
      )
      .join("");
  } catch (e) {
    bubble.textContent = "오류: " + e.message;
  }
}

// ---- Wiring -------------------------------------------------------------

function setupTabs() {
  document.querySelectorAll(".tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach((x) => x.classList.remove("active"));
      document.querySelectorAll(".pane").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      $("#pane-" + b.dataset.tab).classList.add("active");
    })
  );
}

function setup() {
  setupTabs();

  $("#addUrl").addEventListener("click", () =>
    guardedIngest(async () => {
      const url = $("#url").value.trim();
      if (!url) return toast("URL을 입력하세요.");
      setStatus("본문 추출 중…");
      const parsed = await ex.fromUrl(url);
      await ingest(parsed);
      $("#url").value = "";
    })
  );

  $("#addNote").addEventListener("click", () =>
    guardedIngest(async () => {
      const parsed = ex.fromNote($("#noteTitle").value.trim(), $("#noteText").value);
      await ingest(parsed);
      $("#noteTitle").value = "";
      $("#noteText").value = "";
    })
  );

  $("#addFile").addEventListener("click", () =>
    guardedIngest(async () => {
      const f = $("#file").files[0];
      if (!f) return toast("파일을 선택하세요.");
      setStatus("파일 읽는 중…");
      const parsed = /\.pdf$/i.test(f.name) ? await ex.fromPdf(f) : await ex.fromTextFile(f);
      await ingest(parsed);
      $("#file").value = "";
    })
  );

  $("#docs").addEventListener("click", async (e) => {
    const btn = e.target.closest("button.del");
    if (!btn) return;
    if (!confirm("이 항목을 삭제할까요?")) return;
    await db.deleteDoc(btn.dataset.id);
    await renderDocs();
    toast("삭제됨");
  });

  // Voice memo: toggle record, then transcribe locally into the note box.
  const rec = new Recorder();
  $("#record").addEventListener("click", async () => {
    const btn = $("#record");
    if (rec.active) {
      btn.textContent = "⏳ 변환…";
      btn.disabled = true;
      try {
        const blob = await rec.stop();
        setStatus("받아쓰는 중…");
        const text = await transcribe(blob, {
          progressCb: (p) => {
            if (p?.status === "progress" && p.total)
              showProgress(p.loaded / p.total, `Whisper 다운로드 ${(p.progress || 0).toFixed(0)}%`);
          },
        });
        showProgress(null);
        setStatus("준비됨");
        const ta = $("#noteText");
        ta.value = (ta.value ? ta.value + "\n" : "") + (text || "(인식된 음성 없음)");
        toast("받아쓰기 완료 — 확인 후 추가하세요.");
      } catch (e) {
        showProgress(null);
        setStatus("준비됨");
        toast("녹음 오류: " + e.message);
      }
      btn.textContent = "🎤 녹음";
      btn.disabled = false;
    } else {
      try {
        await rec.start();
        btn.textContent = "⏹ 중지";
      } catch (e) {
        toast("마이크 접근 실패: " + e.message);
      }
    }
  });

  // Info Radar import — from a URL or a local items.json file.
  // ingestMany only loads the embedding model when there are fresh items,
  // so auto-sync on open stays cheap when nothing changed.
  async function importRadar(json) {
    try {
      const parsed = ex.fromRadarItems(json);
      await ingestMany(parsed, "Radar 항목");
    } catch (e) {
      showProgress(null);
      toast("Radar 오류: " + e.message);
    } finally {
      setStatus("준비됨");
    }
  }
  async function syncRadar(url, { silent = false } = {}) {
    if (!url) return !silent && toast("items.json 주소를 입력하세요.");
    try {
      setStatus("Radar 불러오는 중…");
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      await importRadar(await res.json());
    } catch (e) {
      setStatus("준비됨");
      if (!silent) toast("Radar 가져오기 실패: " + e.message);
    }
  }
  $("#radarFetch").addEventListener("click", () => {
    LS.url = $("#radarUrl").value.trim();
    syncRadar(LS.url);
  });
  $("#radarUrl").addEventListener("change", () => (LS.url = $("#radarUrl").value.trim()));
  $("#radarAuto").addEventListener("change", (e) => (LS.auto = e.target.checked));
  $("#radarPick").addEventListener("click", () => $("#radarFile").click());
  $("#radarFile").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      await importRadar(JSON.parse(await f.text()));
    } catch (err) {
      toast("Radar 파일 오류: " + err.message);
    }
    e.target.value = "";
  });

  $("#send").addEventListener("click", handleAsk);
  $("#ask").addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleAsk();
  });

  $("#export").addEventListener("click", async () => {
    let data = await db.exportAll();
    const pass = prompt("백업 암호를 입력하면 암호화합니다.\n(비워두면 일반 JSON으로 저장)", "");
    if (pass === null) return; // cancelled
    let ext = "json";
    if (pass) {
      data = await encryptJSON(data, pass);
      ext = "sbenc.json";
    }
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `second-brain-backup-${new Date().toISOString().slice(0, 10)}.${ext}`;
    a.click();
    toast(pass ? "🔐 암호화 백업 내보냄" : "백업 내보냄");
  });

  $("#import").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      let data = JSON.parse(await f.text());
      if (isEncrypted(data)) {
        const pass = prompt("이 백업은 암호화되어 있습니다. 암호를 입력하세요.", "");
        if (pass === null) return;
        data = await decryptJSON(data, pass);
      }
      const r = await db.importAll(data);
      await renderDocs();
      toast(`가져옴: 문서 ${r.docs} · 청크 ${r.chunks}`);
    } catch (err) {
      toast("가져오기 실패: " + err.message);
    }
    e.target.value = "";
  });

  $("#clear").addEventListener("click", async () => {
    if (!confirm("모든 지식을 삭제합니다. 되돌릴 수 없어요. 계속할까요?")) return;
    await db.clearAll();
    await renderDocs();
    toast("전체 삭제됨");
  });

  // Clustering view.
  $("#clusterThreshold").value = LS.clusterThreshold;
  $("#clusterRefresh").addEventListener("click", async () => {
    await loadModel(); // ensure vectors exist / model warm
    await renderClusters();
  });
  let clusterDebounce = null;
  $("#clusterThreshold").addEventListener("input", (e) => {
    LS.clusterThreshold = parseInt(e.target.value, 10);
    clearTimeout(clusterDebounce);
    clusterDebounce = setTimeout(renderClusters, 250);
  });

  // Duplicate / conflict resolution.
  $("#dupScan").addEventListener("click", async () => {
    await loadModel();
    await renderDups();
  });
  $("#dups").addEventListener("click", (e) => {
    const btn = e.target.closest("button.keep");
    if (btn) mergeDupGroup(parseInt(btn.dataset.group, 10), btn.dataset.keep);
  });

  // Multi-device sync controls.
  $("#syncUrl").value = LS.syncUrl;
  $("#syncKey").value = LS.syncKey;
  $("#syncPass").value = LS.syncPass;
  $("#syncRemember").checked = LS.syncRemember;
  $("#syncConnect").addEventListener("click", async () => {
    const remember = $("#syncRemember").checked;
    LS.syncRemember = remember;
    LS.syncUrl = $("#syncUrl").value.trim();
    LS.syncKey = $("#syncKey").value.trim();
    // Only persist the passphrase when the user opts in; otherwise keep it in
    // memory for this session only (the Sync instance still holds it).
    LS.syncPass = remember ? $("#syncPass").value : "";
    if (sync) sync.stop();
    setSyncStatus("연결 중…");
    await startSync({ pass: $("#syncPass").value });
  });
  $("#syncPush").addEventListener("click", async () => {
    if (!sync) return toast("먼저 연결하세요.");
    setSyncStatus("올리는 중…");
    try {
      await sync.push();
      setSyncStatus("동기화됨 ✓");
      toast("올렸습니다.");
    } catch (e) {
      setSyncStatus("올리기 실패: " + e.message);
    }
  });

  // Restore Radar settings, then auto-sync now + every 30 min while open.
  $("#radarUrl").value = LS.url;
  $("#radarAuto").checked = LS.auto;
  if (LS.auto && LS.url) {
    syncRadar(LS.url, { silent: true });
    setInterval(() => LS.auto && LS.url && syncRadar(LS.url, { silent: true }), 30 * 60 * 1000);
  }
}

// Build the highlight-clipper bookmarklet, pointing back at this exact app.
function setupBookmarklet() {
  const base = location.origin + location.pathname;
  const code =
    "javascript:(function(){var t=(window.getSelection?getSelection().toString():'').trim();" +
    "if(!t){alert('먼저 저장할 텍스트를 선택하세요.');return;}" +
    "var u=location.href,ti=document.title;" +
    "window.open('" + base + "#clip='+encodeURIComponent(t)+'&t='+encodeURIComponent(ti)+'&u='+encodeURIComponent(u),'_blank');})()";
  $("#clipBookmarklet").setAttribute("href", code);
}

// If opened by the bookmarklet (#clip=...), save the clipped selection.
// The hash is attacker-controllable (anyone can craft a #clip link), so
// confirm with the user before ingesting to prevent drive-by store poisoning.
async function handleClipFromHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const clip = h.get("clip");
  if (!clip) return;
  history.replaceState(null, "", location.pathname + location.search);
  const title = h.get("t") || "웹 클립";
  const src = h.get("u") || "";
  const preview = clip.slice(0, 200) + (clip.length > 200 ? "…" : "");
  if (!confirm(`이 클립을 저장할까요?\n\n제목: ${title}\n출처: ${src || "(없음)"}\n\n${preview}`)) return;
  await guardedIngest(async () => {
    const parsed = ex.fromClip(title, src, clip);
    await ingest(parsed);
  });
}

(async function init() {
  setup();
  setupBookmarklet();
  db.gcTombstones().catch(() => {}); // prune old deletion markers
  await renderDocs();
  setStatus("준비됨 (모델은 첫 사용 시 다운로드)");
  await handleClipFromHash();
  // Resume multi-device sync if it was on and configured.
  if (LS.syncOn && LS.syncUrl && LS.syncKey && LS.syncPass) {
    startSync({ silent: true });
  }
  // Register the service worker for offline / installable app shell.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
})();
