// ClipKaro speech-to-text worker.
// Runs Whisper (transformers.js) on the GPU via WebGPU when available, otherwise on CPU (WASM),
// and returns real word-level timestamps.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5/dist/transformers.min.js';

env.allowLocalModels = false;

let asr = null, curKey = '', device = 'wasm', wordMode = true;

const post = (m) => self.postMessage(m);

async function load(model) {
  const key = model;
  if (asr && curKey === key) return;
  if (asr) { try { await asr.dispose(); } catch {} asr = null; }
  const progress_callback = (p) => post({ type: 'dl', p });
  const tryGpu = !!self.navigator?.gpu && !!(await self.navigator.gpu.requestAdapter().catch(() => null));
  if (tryGpu) {
    try {
      asr = await pipeline('automatic-speech-recognition', model, {
        device: 'webgpu',
        dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
        progress_callback,
      });
      device = 'webgpu';
    } catch (e) {
      console.warn('WebGPU load failed, falling back to CPU', e);
      asr = null;
    }
  }
  if (!asr) {
    asr = await pipeline('automatic-speech-recognition', model, { device: 'wasm', dtype: 'q8', progress_callback });
    device = 'wasm';
  }
  curKey = key;
  wordMode = true;
}

function wordsFromChunks(chunks, offset, blockLen) {
  const out = [];
  for (const c of chunks || []) {
    const text = (c.text || '').trim();
    if (!text) continue;
    let s = c.timestamp?.[0], e = c.timestamp?.[1];
    if (s == null) continue;
    if (e == null || e < s) e = Math.min(blockLen, s + 0.4);
    out.push({ w: text, s: offset + s, e: offset + Math.max(e, s + 0.08) });
  }
  return out;
}

// Spread segment-level timestamps over words (fallback only).
function wordsFromSegments(chunks, offset, blockLen) {
  const out = [];
  for (const c of chunks || []) {
    const words = (c.text || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const s = c.timestamp?.[0] ?? 0, e = c.timestamp?.[1] ?? Math.min(blockLen, s + 4);
    const total = words.reduce((a, w) => a + w.length + 1, 0);
    let t = s;
    for (const w of words) { const d = (e - s) * (w.length + 1) / total; out.push({ w, s: offset + t, e: offset + t + d }); t += d; }
  }
  return out;
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'load') {
      await load(m.model);
      post({ type: 'ready', device });
      return;
    }
    if (m.type === 'run') {
      const { audio, offset, language, id } = m;
      const blockLen = audio.length / 16000;
      const opts = { chunk_length_s: 30, stride_length_s: 5, task: 'transcribe' };
      if (language && language !== 'auto') opts.language = language;
      let words;
      if (wordMode) {
        try {
          const r = await asr(audio, { ...opts, return_timestamps: 'word' });
          words = wordsFromChunks(r.chunks, offset, blockLen);
        } catch (e) {
          console.warn('Word timestamps failed, using segment timestamps', e);
          wordMode = false;
        }
      }
      if (!wordMode) {
        const r = await asr(audio, { ...opts, return_timestamps: true });
        words = wordsFromSegments(r.chunks, offset, blockLen);
      }
      post({ type: 'result', id, words, wordMode });
    }
  } catch (err) {
    post({ type: 'error', id: m.id, message: String(err?.message || err) });
  }
};
