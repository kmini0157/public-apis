// Second Brain — UI controller. Wires the DOM to ingestion, embedding,
// storage, semantic search, and the RAG chat. All on-device.

import { loadModel, embedBatch } from "./embed.js";
import * as db from "./db.js";
import * as ex from "./extract.js";
import { ask } from "./rag.js";

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

  $("#send").addEventListener("click", handleAsk);
  $("#ask").addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleAsk();
  });

  $("#export").addEventListener("click", async () => {
    const data = await db.exportAll();
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `second-brain-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    toast("백업 내보냄");
  });

  $("#import").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
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
}

(async function init() {
  setup();
  await renderDocs();
  setStatus("준비됨 (모델은 첫 사용 시 다운로드)");
})();
