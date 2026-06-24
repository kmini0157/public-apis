// Retrieval + answer generation.
// Retrieval is local (cosine over IndexedDB vectors). Generation uses
// Puter.js (keyless, in-browser LLM). Falls back gracefully if unavailable.

import { embed, cosine } from "./embed.js";
import { getAllChunks } from "./db.js";

// Semantic search: returns top-k chunks with their similarity score.
export async function search(query, k = 6) {
  const qv = await embed(query);
  const chunks = await getAllChunks();
  const scored = chunks.map((c) => ({ ...c, score: cosine(qv, c.vec) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

// Retrieve, then ask the LLM to answer strictly from the retrieved notes.
export async function ask(query, { k = 6 } = {}) {
  const hits = await search(query, k);
  if (!hits.length) {
    return { answer: "아직 저장된 지식이 없습니다. 먼저 자료를 추가해 주세요.", hits: [] };
  }
  const context = hits
    .map((h, i) => `[${i + 1}] (출처: ${h.title})\n${h.text}`)
    .join("\n\n");
  const prompt =
    "너는 사용자의 '제2의 뇌'다. 아래 '내 노트'만 근거로 한국어로 정확하고 간결하게 답하라. " +
    "노트에 없는 내용은 추측하지 말고 모른다고 말하라. 사용한 근거는 [번호]로 인용하라.\n\n" +
    "=== 내 노트 ===\n" + context + "\n\n=== 질문 ===\n" + query;

  let answer;
  try {
    if (!window.puter?.ai?.chat) throw new Error("Puter.js를 불러오지 못했습니다.");
    const res = await window.puter.ai.chat(prompt);
    answer = typeof res === "string" ? res : res?.message?.content ?? res?.text ?? String(res);
  } catch (e) {
    // No-LLM fallback: just surface the most relevant note text.
    answer =
      "⚠️ LLM 호출 실패(" + e.message + "). 가장 관련 높은 노트를 대신 보여드립니다:\n\n" +
      hits[0].text;
  }
  return { answer, hits };
}
