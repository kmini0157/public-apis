// Ingestion helpers: turn a URL, raw text, or PDF into clean text + chunks.

const JINA = "https://r.jina.ai/";

// Split text into overlapping chunks on sentence/paragraph boundaries.
export function chunkText(text, { size = 700, overlap = 120 } = {}) {
  const clean = (text || "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").trim();
  if (!clean) return [];
  // Prefer paragraph breaks, fall back to sentence-ish splits.
  const units = clean.split(/\n{2,}/).flatMap((p) =>
    p.length <= size ? [p] : p.split(/(?<=[.!?。？！])\s+/)
  );
  const chunks = [];
  let buf = "";
  for (const u of units) {
    if ((buf + " " + u).trim().length > size && buf) {
      chunks.push(buf.trim());
      buf = overlap > 0 ? buf.slice(-overlap) + " " + u : u;
    } else {
      buf = buf ? buf + "\n" + u : u;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks.filter((c) => c.length > 20);
}

// Fetch + clean an article via Jina Reader (keyless, CORS-enabled).
export async function fromUrl(url) {
  const res = await fetch(JINA + url, { headers: { "X-Return-Format": "markdown" } });
  if (!res.ok) throw new Error(`Jina 추출 실패 (HTTP ${res.status})`);
  const md = await res.text();
  // First markdown heading or the URL becomes the title.
  const title = (md.match(/^#\s+(.+)$/m)?.[1] || url).slice(0, 200).trim();
  return { title, source: url, text: md };
}

// Extract text from a PDF File using pdf.js (loaded on demand).
export async function fromPdf(file) {
  const pdfjs = await import(
    "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs"
  );
  pdfjs.GlobalWorkerOptions.workerSrc =
    "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs";
  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  let text = "";
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str).join(" ") + "\n\n";
  }
  return { title: file.name.replace(/\.pdf$/i, ""), source: `pdf:${file.name}`, text };
}

// A plain text / markdown file or pasted note.
export async function fromTextFile(file) {
  const text = await file.text();
  return { title: file.name, source: `file:${file.name}`, text };
}

export function fromNote(title, text) {
  return { title: title || "메모", source: "note", text };
}
