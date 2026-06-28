// Retrieval + answer generation.
// Retrieval is local (cosine over IndexedDB vectors). Generation uses
// Puter.js (keyless, in-browser LLM). Falls back gracefully if unavailable.

import { embed } from "./embed.js";
import { cosine } from "./vec.js";
import { getAllChunks } from "./db.js";

// Semantic search: returns top-k chunks with their similarity score.
export async function search(query, k = 6) {
  const qv = await embed(query);
  const chunks = await getAllChunks();
  const scored = chunks.map((c) => ({ ...c, score: cosine(qv, c.vec) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

function normalize(res) {
  return typeof res === "string" ? res : res?.message?.content ?? res?.text ?? String(res);
}

// Retrieve, then ask the LLM to answer strictly from the retrieved notes.
// Pass onToken to stream the answer incrementally (receives the full text so far).
export async function ask(query, { k = 6, onToken } = {}) {
  const hits = await search(query, k);
  if (!hits.length) {
    const msg = "아직 저장된 지식이 없습니다. 먼저 자료를 추가해 주세요.";
    if (onToken) onToken(msg);
    return { answer: msg, hits: [] };
  }
  const context = hits
    .map((h, i) => `[${i + 1}] (출처: ${h.title})\n${h.text}`)
    .join("\n\n");
  const prompt =
    "너는 사용자의 '제2의 뇌'다. 아래 '내 노트'만 근거로 한국어로 정확하고 간결하게 답하라. " +
    "노트에 없는 내용은 추측하지 말고 모른다고 말하라. 사용한 근거는 [번호]로 인용하라.\n\n" +
    "=== 내 노트 ===\n" + context + "\n\n=== 질문 ===\n" + query;

  let answer = "";
  try {
    if (!window.puter?.ai?.chat) throw new Error("Puter.js를 불러오지 못했습니다.");
    if (onToken) {
      // Streaming path: yield tokens as they arrive.
      const stream = await window.puter.ai.chat(prompt, { stream: true });
      if (stream && typeof stream[Symbol.asyncIterator] === "function") {
        for await (const part of stream) {
          const t = part?.text ?? part?.delta ?? (typeof part === "string" ? part : "");
          if (t) {
            answer += t;
            onToken(answer);
          }
        }
        if (!answer) {
          // Iterable yielded nothing; fall back to a single call.
          answer = normalize(await window.puter.ai.chat(prompt));
          onToken(answer);
        }
      } else {
        // Provider ignored { stream: true } and returned a non-iterable result.
        answer = normalize(stream);
        onToken(answer);
      }
    } else {
      answer = normalize(await window.puter.ai.chat(prompt));
    }
  } catch (e) {
    // No-LLM fallback: just surface the most relevant note text.
    answer =
      "⚠️ LLM 호출 실패(" + e.message + "). 가장 관련 높은 노트를 대신 보여드립니다:\n\n" +
      hits[0].text;
    if (onToken) onToken(answer);
  }
  return { answer, hits };
}
