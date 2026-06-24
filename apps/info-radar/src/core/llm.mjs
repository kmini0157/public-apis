// Keyless LLM calls via Pollinations text API.
// POST https://text.pollinations.ai/ { messages, model, jsonMode }

const ENDPOINT = "https://text.pollinations.ai/";
const MODEL = process.env.POLLINATIONS_MODEL || "openai";

async function chat(messages, { json = false, timeoutMs = 40000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, model: MODEL, jsonMode: json, private: true }),
    });
    if (!res.ok) throw new Error(`pollinations ${res.status}`);
    return (await res.text()).trim();
  } finally {
    clearTimeout(t);
  }
}

function parseJsonLoose(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {}
  }
  return null;
}

// Score + summarize one item against the user's interests.
// Returns { score:0-100, why, summary, tags:[] } or null on failure.
export async function analyzeItem({ title, summary, fulltext, interests, language }) {
  const interestList = (interests || []).map((s) => `- ${s}`).join("\n");
  const body = (fulltext || summary || "").slice(0, 6000);
  const sys =
    "You are a personal information filter. Judge how relevant an article is to the user's interests, " +
    "then write a tight summary. Be strict: only score high when it genuinely matches. " +
    `Write "summary" and "why" in ${language === "ko" ? "Korean" : "English"}. ` +
    'Respond ONLY as JSON: {"score": <0-100 int>, "why": "<one short line>", "summary": "<2-3 sentences>", "tags": ["..."]}';
  const user =
    `User interests:\n${interestList}\n\n` +
    `Article title: ${title}\n` +
    `Article content:\n${body}`;
  try {
    const out = await chat(
      [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      { json: true }
    );
    const obj = parseJsonLoose(out);
    if (!obj) return null;
    return {
      score: Math.max(0, Math.min(100, parseInt(obj.score, 10) || 0)),
      why: String(obj.why || "").slice(0, 240),
      summary: String(obj.summary || "").slice(0, 600),
      tags: Array.isArray(obj.tags) ? obj.tags.slice(0, 6).map(String) : [],
    };
  } catch {
    return null;
  }
}

// Build a short natural-language digest from the top items.
export async function writeDigest({ items, language }) {
  if (!items.length) return "";
  const lines = items
    .map((it, i) => `${i + 1}. [${it.score}] ${it.title} — ${it.summary}`)
    .join("\n");
  const sys =
    `You write a punchy daily briefing in ${language === "ko" ? "Korean" : "English"}. ` +
    "Group related items, lead with what matters most, keep it under 1200 characters. No preamble.";
  try {
    return await chat(
      [
        { role: "system", content: sys },
        { role: "user", content: `Today's top items:\n${lines}` },
      ],
      { json: false }
    );
  } catch {
    return "";
  }
}
