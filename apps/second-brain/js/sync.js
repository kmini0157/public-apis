// Multi-device sync over a free Supabase project, end-to-end encrypted.
// The backend only ever stores an opaque AES-GCM blob; the passphrase never
// leaves the browser. The "space" id is derived from the passphrase, so two
// devices that share the same passphrase automatically share the same space.

import { exportAll, importAll } from "./db.js";
import { encryptJSON, decryptJSON } from "./crypto.js";

const te = new TextEncoder();

// Derive the space id with the SAME key-stretching used for encryption, so an
// observer of the (logged/stored) space value can't cheaply brute-force the
// passphrase. A FIXED app-domain salt keeps the id deterministic across devices
// that share the passphrase, while PBKDF2's cost makes each guess as expensive
// as attacking the ciphertext itself.
const SPACE_SALT = te.encode("second-brain:space-id:v2");

async function spaceIdFrom(passphrase) {
  const base = await crypto.subtle.importKey("raw", te.encode(passphrase), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: SPACE_SALT, iterations: 150000, hash: "SHA-256" },
    base,
    128
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
    this._pulling = null; // in-flight pull() promise, used as a lock
    this._rt = null; // supabase-js client (realtime), if active
    this._channel = null;
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

  // Cheap existence/timestamp probe that does NOT decrypt — used to decide
  // whether a failed pull means "remote absent" (safe to create) vs
  // "remote exists but unreadable" (must not clobber).
  async _remoteMeta() {
    const r = await fetch(
      `${this.url}/rest/v1/brain_sync?space=eq.${this.space}&select=updated_at`,
      { headers: this.headers() }
    );
    if (!r.ok) throw new Error("동기화 조회 실패 (HTTP " + r.status + ")");
    const rows = await r.json();
    return rows.length ? rows[0] : null;
  }

  // Deduped pull: concurrent callers (the interval tick and push()) share one
  // in-flight request, so the freshness gate can't race and importAll/onChange
  // run at most once per remote change.
  async pull() {
    if (this._pulling) return this._pulling;
    this._pulling = this._pullOnce().finally(() => {
      this._pulling = null;
    });
    return this._pulling;
  }

  async _pullOnce() {
    const r = await fetch(
      `${this.url}/rest/v1/brain_sync?space=eq.${this.space}&select=blob,updated_at`,
      { headers: this.headers() }
    );
    if (!r.ok) throw new Error("동기화 받기 실패 (HTTP " + r.status + ")");
    const rows = await r.json();
    if (!rows.length) return { applied: false, remoteExisted: false };
    const row = rows[0];
    if (this.lastUpdated && row.updated_at <= this.lastUpdated)
      return { applied: false, remoteExisted: true };
    const data = await decryptJSON(row.blob, this.pass);
    const res = await importAll(data);
    this.lastUpdated = row.updated_at;
    return { applied: true, remoteExisted: true, ...res };
  }

  // Merge remote first (avoid clobbering a peer's concurrent edits), then
  // upload the union of everything this device now holds. Never overwrites a
  // remote row we failed to merge, and never replaces a remote with an empty
  // local export.
  async push() {
    let pulled = null;
    try {
      pulled = await this.pull();
    } catch (e) {
      // pull failed: distinguish "remote genuinely absent" (safe to create)
      // from "remote exists but we couldn't read/decrypt it" (must not clobber).
      let meta = null;
      try {
        meta = await this._remoteMeta();
      } catch {
        throw e; // indeterminate (offline / error) — abort instead of clobbering
      }
      if (meta) {
        throw new Error(
          "원격 데이터를 먼저 병합하지 못해 올리기를 중단했습니다. 암호·연결을 확인하세요. (" + e.message + ")"
        );
      }
      // remote genuinely absent -> safe to create it from local data
    }

    const local = await exportAll();
    // Guard: never replace an existing remote row with a near-empty local export.
    if (!local.docs.length && pulled && pulled.remoteExisted) {
      return { ok: true, skipped: true };
    }

    const blob = await encryptJSON(local, this.pass);
    const body = JSON.stringify([
      { space: this.space, blob, updated_at: new Date().toISOString() },
    ]);
    const r = await fetch(`${this.url}/rest/v1/brain_sync`, {
      method: "POST",
      headers: this.headers({ Prefer: "resolution=merge-duplicates,return=representation" }),
      body,
    });
    if (!r.ok)
      throw new Error("동기화 올리기 실패 (HTTP " + r.status + ") " + (await r.text()).slice(0, 140));
    const rows = await r.json().catch(() => []);
    if (rows[0]?.updated_at) this.lastUpdated = rows[0].updated_at;
    return { ok: true };
  }

  // Pull-and-notify, skipping if a pull is already in flight so overlapping
  // triggers (interval tick + realtime event) can't double-apply / double-notify.
  async _tick() {
    if (this._pulling) return;
    try {
      const r = await this.pull();
      if (r.applied) this.onChange(r);
    } catch {
      /* transient network error; keep going */
    }
  }

  // Near-real-time: poll on an interval, and additionally subscribe to Supabase
  // Realtime when available (instant updates). Polling stays as a safety net in
  // case Realtime isn't enabled on the table or the socket drops.
  start(intervalMs = 8000) {
    this.stop();
    this.timer = setInterval(() => this._tick(), intervalMs);
    this.startRealtime();
  }

  async startRealtime() {
    try {
      const { createClient } = await import(
        "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm"
      );
      this._rt = createClient(this.url, this.key, { auth: { persistSession: false } });
      this._channel = this._rt
        .channel("brain_sync:" + this.space)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "brain_sync", filter: "space=eq." + this.space },
          () => this._tick()
        )
        .subscribe();
      return true;
    } catch {
      // Realtime unavailable (offline, CDN blocked, table not in publication) —
      // polling already covers updates.
      return false;
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this._channel) {
      try {
        this._rt?.removeChannel(this._channel);
      } catch {
        /* ignore */
      }
      this._channel = null;
      this._rt = null;
    }
  }
}
