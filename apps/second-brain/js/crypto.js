// Optional passphrase encryption for backups (Web Crypto, on-device).
// AES-GCM with a PBKDF2-derived key. No server, no keys to manage.

const MAGIC = "sb_enc";
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(passphrase, salt) {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptJSON(obj, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(JSON.stringify(obj))
  );
  return { [MAGIC]: 1, salt: b64(salt), iv: b64(iv), data: b64(ct) };
}

export function isEncrypted(obj) {
  return obj && obj[MAGIC] === 1 && obj.salt && obj.iv && obj.data;
}

export async function decryptJSON(blob, passphrase) {
  const key = await deriveKey(passphrase, unb64(blob.salt));
  let pt;
  try {
    pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(blob.iv) },
      key,
      unb64(blob.data)
    );
  } catch {
    throw new Error("암호가 틀렸거나 파일이 손상되었습니다.");
  }
  return JSON.parse(dec.decode(pt));
}
