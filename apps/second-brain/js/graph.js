// Similarity-network graph of notes, dependency-free and deterministic
// (circular seeding, no randomness) so the layout is stable and testable.

import { cosine } from "./vec.js";

// Nodes = docs; edges connect pairs with cosine >= threshold.
export function buildGraph(docVecs, threshold = 0.5) {
  const nodes = docVecs.map((d) => ({ id: d.docId, title: d.title, source: d.source }));
  const edges = [];
  for (let i = 0; i < docVecs.length; i++) {
    for (let j = i + 1; j < docVecs.length; j++) {
      const w = cosine(docVecs[i].vec, docVecs[j].vec);
      if (w >= threshold) edges.push({ a: i, b: j, w });
    }
  }
  return { nodes, edges };
}

// Simple force-directed layout: repulsion between all nodes, spring pull along
// edges (stronger for higher similarity), with cooling. Returns [{x,y}].
export function layoutGraph(nodes, edges, { width = 800, height = 460, iterations = 150 } = {}) {
  const n = nodes.length;
  const pos = nodes.map((_, i) => {
    const angle = (2 * Math.PI * i) / Math.max(1, n);
    const r = Math.min(width, height) * 0.35;
    return { x: width / 2 + r * Math.cos(angle), y: height / 2 + r * Math.sin(angle) };
  });
  if (n <= 1) return pos;
  const k = Math.sqrt((width * height) / n) * 0.6;
  for (let it = 0; it < iterations; it++) {
    const disp = pos.map(() => ({ x: 0, y: 0 }));
    // Repulsion (all pairs).
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = pos[i].x - pos[j].x;
        const dy = pos[i].y - pos[j].y;
        const d2 = dx * dx + dy * dy || 0.01;
        const f = (k * k) / d2;
        disp[i].x += dx * f;
        disp[i].y += dy * f;
        disp[j].x -= dx * f;
        disp[j].y -= dy * f;
      }
    }
    // Springs along edges.
    for (const e of edges) {
      const dx = pos[e.a].x - pos[e.b].x;
      const dy = pos[e.a].y - pos[e.b].y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.1;
      const f = ((d * d) / k) * e.w;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      disp[e.a].x -= fx;
      disp[e.a].y -= fy;
      disp[e.b].x += fx;
      disp[e.b].y += fy;
    }
    // Apply with cooling; keep nodes inside the canvas.
    const t = 0.1 * Math.min(width, height) * (1 - it / iterations) + 1;
    for (let i = 0; i < n; i++) {
      const d = Math.sqrt(disp[i].x * disp[i].x + disp[i].y * disp[i].y) || 0.1;
      pos[i].x += (disp[i].x / d) * Math.min(d, t);
      pos[i].y += (disp[i].y / d) * Math.min(d, t);
      pos[i].x = Math.max(24, Math.min(width - 24, pos[i].x));
      pos[i].y = Math.max(18, Math.min(height - 18, pos[i].y));
    }
  }
  return pos;
}
