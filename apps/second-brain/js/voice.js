// In-browser voice memos: record from the mic, transcribe locally with
// Whisper (transformers.js). Keyless, on-device, no audio leaves the browser.

import { pipeline } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2";

let _asr = null;
let _loading = null;

export async function loadASR(progressCb) {
  if (_asr) return _asr;
  if (_loading) return _loading;
  _loading = pipeline("automatic-speech-recognition", "Xenova/whisper-tiny", {
    progress_callback: progressCb,
  }).then((p) => {
    _asr = p;
    _loading = null;
    return p;
  });
  return _loading;
}

// Decode a recorded audio Blob to 16kHz mono Float32 samples for Whisper.
async function blobToPcm(blob) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx({ sampleRate: 16000 });
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    return buf.getChannelData(0);
  } finally {
    ctx.close?.();
  }
}

export async function transcribe(blob, { language = "korean", progressCb } = {}) {
  const asr = await loadASR(progressCb);
  const pcm = await blobToPcm(blob);
  const out = await asr(pcm, { language, task: "transcribe", chunk_length_s: 30 });
  return (typeof out === "string" ? out : out?.text || "").trim();
}

// Simple mic recorder wrapper around MediaRecorder.
export class Recorder {
  constructor() {
    this.chunks = [];
    this.media = null;
    this.stream = null;
  }
  get active() {
    return this.media && this.media.state === "recording";
  }
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    this.media = new MediaRecorder(this.stream);
    this.media.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.media.start();
  }
  stop() {
    return new Promise((resolve) => {
      if (!this.media) return resolve(null);
      this.media.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.media.mimeType || "audio/webm" });
        this.stream.getTracks().forEach((t) => t.stop());
        resolve(blob);
      };
      this.media.stop();
    });
  }
}
