// Second Brain — UI controller. Wires the DOM to ingestion, embedding,
// storage, semantic search, and the RAG chat. All on-device.

import { loadModel, embedBatch } from "./embed.js";
import * as db from "./db.js";
import * as ex from "./extract.js";
import { ask } from "./rag.js";
import { Recorder, transcribe } from "./voice.js";
import { encryptJSON, decryptJSON, isEncrypted } from "./crypto.js";

const LS = {
  get url() { return localStorage.getItem("sb.radarUrl") || ""; },
  set url(v) { localStorage.setItem("sb.radarUrl", v || ""); },
  get auto() { return localStorage.getItem("sb.radarAuto") === "1"; },
  set auto(v) { localStorage.setItem("sb.radarAuto", v ? "1" : "0"); },
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
  toast(`저장 완료: ${parsed.title} (${chunks.length}청크)`);
}

// Bulk ingest (e.g. Info Radar). Dedupes against already-stored sources,
// embeds every chunk across all new docs in one pass.
async function ingestMany(parsedList, label = "항목") {
  const existing = new Set((await db.getDocs()).map((d) => d.source));
  const fresh = parsedList.filter((p) => p.source && !existing.has(p.source));
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
        return `<div class="doc">
          <div class="t">${esc(d.title)}</div>
          <div class="m">${src} · ${d.chunkCount || 0}청크 · ${new Date(d.addedAt).toLocaleDateString("ko-KR")}
            <button class="del" data-id="${d.id}" title="삭제">✕</button></div>
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

// ---- Chat ---------------------------------------------------------------

async function handleAsk() {
  const q = $("#ask").value.trim();
  if (!q) return;
  $("#ask").value = "";
  addMsg("u", q);
  const bubble = addMsg("a", "생각 중…");
  try {
    await loadModel();
    const { answer, hits } = await ask(q);
    bubble.textContent = answer;
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

// If opened by the bookmarklet (#clip=...), auto-save the clipped selection.
async function handleClipFromHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const clip = h.get("clip");
  if (!clip) return;
  history.replaceState(null, "", location.pathname + location.search);
  await guardedIngest(async () => {
    const parsed = ex.fromClip(h.get("t") || "웹 클립", h.get("u") || "", clip);
    await ingest(parsed);
  });
}

(async function init() {
  setup();
  setupBookmarklet();
  await renderDocs();
  setStatus("준비됨 (모델은 첫 사용 시 다운로드)");
  await handleClipFromHash();
  // Register the service worker for offline / installable app shell.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
})();
