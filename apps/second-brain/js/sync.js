// Multi-device sync over a free Supabase project, end-to-end encrypted.
// The backend only ever stores an opaque AES-GCM blob; the passphrase never
// leaves the browser. The "space" id is derived from the passphrase, so two
// devices that share the same passphrase automatically share the same space.

import { exportAll, importAll } from "./db.js";
import { encryptJSON, decryptJSON } from "./crypto.js";

const te = new TextEncoder();

async function spaceIdFrom(passphrase) {
  const h = await crypto.subtle.digest("SHA-256", te.encode("second-brain:" + passphrase));
  return [...new Uint8Array(h)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export class Sync {
  constructor(cfg) {
    this.url = (cfg.url || "").replace(/\/+$/, "");
    this.key = cfg.anonKey || "";
    this.pass = cfg.passphrase || "";
    this.onChange = cfg.onChange || (() => {});
    this.space = null;
    this.lastUpdated = null; // server timestamp of the last row we applied/wrote
    this.timer = null;
  }

  headers(extra) {
    return {
      apikey: this.key,
      Authorization: "Bearer " + this.key,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async init() {
    if (!this.url || !this.key || !this.pass) throw new Error("URL·anon key·암호를 모두 입력하세요.");
    this.space = await spaceIdFrom(this.pass);
    return this.space;
  }

  // Fetch the remote blob; if newer than what we last applied, decrypt + merge.
  async pull() {
    const r = await fetch(
      `${this.url}/rest/v1/brain_sync?space=eq.${this.space}&select=blob,updated_at`,
      { headers: this.headers() }
    );
    if (!r.ok) throw new Error("동기화 받기 실패 (HTTP " + r.status + ")");
    const rows = await r.json();
    if (!rows.length) return { applied: false };
    const row = rows[0];
    if (this.lastUpdated && row.updated_at <= this.lastUpdated) return { applied: false };
    const data = await decryptJSON(row.blob, this.pass);
    const res = await importAll(data);
    this.lastUpdated = row.updated_at;
    return { applied: true, ...res };
  }

  // Merge remote first (avoid clobbering a peer's concurrent edits), then
  // upload the union of everything this device now holds.
  async push() {
    try {
      await this.pull();
    } catch {
      /* offline / empty — push what we have */
    }
    const blob = await encryptJSON(await exportAll(), this.pass);
    const body = JSON.stringify([
      { space: this.space, blob, updated_at: new Date().toISOString() },
    ]);
    const r = await fetch(`${this.url}/rest/v1/brain_sync`, {
      method: "POST",
      headers: this.headers({ Prefer: "resolution=merge-duplicates,return=representation" }),
      body,
    });
    if (!r.ok) throw new Error("동기화 올리기 실패 (HTTP " + r.status + ") " + (await r.text()).slice(0, 140));
    const rows = await r.json().catch(() => []);
    if (rows[0]?.updated_at) this.lastUpdated = rows[0].updated_at;
    return { ok: true };
  }

  // Near-real-time: poll for remote changes and apply them as they arrive.
  start(intervalMs = 8000) {
    this.stop();
    this.timer = setInterval(async () => {
      try {
        const r = await this.pull();
        if (r.applied) this.onChange(r);
      } catch {
        /* transient network error; keep polling */
      }
    }, intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
