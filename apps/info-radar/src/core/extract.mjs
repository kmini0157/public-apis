// Full-text extraction via Jina Reader (keyless).
// https://r.jina.ai/<url> returns clean markdown of the page.

const JINA = "https://r.jina.ai/";

export async function extractArticle(url, { timeoutMs = 25000 } = {}) {
  if (!url) return "";
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(JINA + url, {
      signal: ctrl.signal,
      headers: {
        // Ask Jina for a leaner markdown response.
        "X-Return-Format": "markdown",
        Accept: "text/plain",
      },
    });
    if (!res.ok) return "";
    const text = await res.text();
    // Keep it bounded — we only need enough for the LLM to summarize.
    return text.slice(0, 12000);
  } catch {
    return "";
  } finally {
    clearTimeout(t);
  }
}
