// ClipKaro v2 — fast, batch, auto-subtitle reel clipper. Everything runs on the user's device.
// Video: decoded + encoded with WebCodecs (hardware accelerated) through Mediabunny — no real-time playback.
// Subtitles: Whisper with word-level timestamps, on the GPU (WebGPU) when available.
import {
  Input, Output, Conversion, ALL_FORMATS, BlobSource, BufferTarget, Mp4OutputFormat,
  AudioBufferSink, VideoSampleSink, QUALITY_HIGH,
} from 'https://cdn.jsdelivr.net/npm/mediabunny@1.60.0/+esm';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtT = (s) => { s = Math.max(0, s || 0); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = Math.floor(s % 60); return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(ss).padStart(2, '0'); };
const srtT = (s) => { const ms = Math.round(s * 1000); const h = Math.floor(ms / 3.6e6), m = Math.floor(ms % 3.6e6 / 6e4), ss = Math.floor(ms % 6e4 / 1000); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
$('yr').textContent = new Date().getFullYear();

/* ------------------------------------------------------------------ settings */
const opts = { len: 30, fmt: 'fit', style: 'highlight', pos: 'low', model: 'onnx-community/whisper-base_timestamped', lang: 'auto', review: false };
try { Object.assign(opts, JSON.parse(localStorage.getItem('ck_opts') || '{}')); } catch {}
const saveOpts = () => { try { localStorage.setItem('ck_opts', JSON.stringify(opts)); } catch {} };
document.querySelectorAll('.seg').forEach((g) => {
  const k = g.dataset.k;
  g.querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(opts[k]) === b.dataset.v));
  g.onclick = (e) => {
    const b = e.target.closest('button'); if (!b || busy()) return;
    g.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on');
    opts[k] = isNaN(+b.dataset.v) ? b.dataset.v : +b.dataset.v; saveOpts();
  };
});
$('lang').value = opts.lang; $('lang').onchange = () => { opts.lang = $('lang').value; saveOpts(); };
$('review').checked = !!opts.review; $('review').onchange = () => { opts.review = $('review').checked; saveOpts(); };

/* ------------------------------------------------------------------ capability check */
const caps = { webcodecs: 'VideoEncoder' in window && 'VideoDecoder' in window, gpu: !!navigator.gpu, fsa: 'showDirectoryPicker' in window };
if (!caps.webcodecs) { $('noSupport').classList.remove('hidden'); }
$('envInfo').textContent = [caps.gpu ? '⚡ GPU subtitles available' : 'CPU subtitles (slower — use Chrome/Edge for GPU)', caps.fsa ? 'Save straight to a folder' : 'Clips download one by one'].join(' · ');

/* ------------------------------------------------------------------ queue */
let Q = []; let seq = 0; let running = false; let stopReq = false; let outDir = null;
const busy = () => running;

$('drop').onclick = () => $('file').click();
$('drop').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') $('file').click(); };
['dragenter', 'dragover'].forEach((ev) => $('drop').addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => $('drop').addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.remove('over'); }));
$('drop').addEventListener('drop', (e) => addFiles([...e.dataTransfer.files]));
$('file').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };

async function addFiles(files) {
  files = files.filter((f) => f.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|m4v)$/i.test(f.name));
  if (!files.length) { alert('Please choose video files (MP4, MOV, WebM, MKV).'); return; }
  for (const f of files) {
    const it = { id: ++seq, file: f, name: f.name, base: f.name.replace(/\.[^.]+$/, '').replace(/[^\wऀ-ॿ-]+/g, '_').slice(0, 40) || 'video', status: 'queued', stage: 'Waiting', pct: 0, clips: [], captions: [], words: [] };
    Q.push(it);
    probe(it);
  }
  $('queueCard').classList.remove('hidden');
  renderQueue();
}

async function probe(it) {
  try {
    const input = new Input({ source: new BlobSource(it.file), formats: ALL_FORMATS });
    it.dur = await input.computeDuration();
    const vt = await input.getPrimaryVideoTrack();
    if (!vt) throw new Error('No video track found');
    it.vw = await vt.getDisplayWidth(); it.vh = await vt.getDisplayHeight();
    it.hasAudio = !!(await input.getPrimaryAudioTrack());
    it.canDecode = await vt.canDecode();
    if (!it.canDecode) { it.status = 'error'; it.stage = "This browser can't decode this video's codec. Try Chrome/Edge, or convert it to MP4 (H.264)."; }
    input.dispose?.();
  } catch (e) { it.status = 'error'; it.stage = 'Could not read this file: ' + (e.message || e); }
  renderQueue();
}

function renderQueue() {
  const total = Q.reduce((a, x) => a + (x.dur || 0), 0);
  $('qSum').textContent = `${Q.length} video${Q.length === 1 ? '' : 's'} · ${fmtT(total)} total`;
  $('queue').innerHTML = Q.map((it) => `
    <div class="qi ${it.status}" id="q${it.id}">
      <div class="qh">
        <div class="qn"><b>${esc(it.name)}</b><span class="muted small">${it.dur ? fmtT(it.dur) : '…'}${it.vw ? ` · ${it.vw}×${it.vh}` : ''}${it.hasAudio === false ? ' · no audio' : ''}</span></div>
        <div class="qa">
          ${it.status === 'review' ? `<button class="btn sm" data-go="${it.id}">✓ Captions OK — export</button>` : ''}
          ${it.status === 'done' && it.clips.some((c) => c.dirty) ? `<button class="btn sm" data-redo="${it.id}">Re-export edited clips</button>` : ''}
          ${it.status === 'done' ? `<button class="btn ghost sm" data-dlall="${it.id}">⬇ All clips</button><button class="btn ghost sm" data-srt="${it.id}">.srt</button>` : ''}
          ${(it.status === 'queued' || it.status === 'error' || it.status === 'done') && !running ? `<button class="x" title="Remove" data-rm="${it.id}">✕</button>` : ''}
        </div>
      </div>
      <div class="bar"><i style="width:${it.pct}%"></i></div>
      <div class="status" id="qs${it.id}">${esc(it.stage)}</div>
      ${it.clips.length && (it.status === 'review' || it.status === 'done' || it.status === 'rendering') ? `<details class="clipsWrap" ${it.status === 'review' || it.open ? 'open' : ''} data-open="${it.id}"><summary>${it.clips.length} clips · ${it.status === 'review' ? 'review & fix captions' : 'preview, fix captions, download'}</summary><div class="clips" id="clips${it.id}"></div></details>` : ''}
    </div>`).join('');
  $('queue').querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => { Q = Q.filter((x) => x.id !== +b.dataset.rm); renderQueue(); if (!Q.length) $('queueCard').classList.add('hidden'); });
  $('queue').querySelectorAll('[data-go]').forEach((b) => b.onclick = () => { const it = Q.find((x) => x.id === +b.dataset.go); it.status = 'transcribed'; it.stage = 'Waiting to export…'; renderQueue(); kickRender(); });
  $('queue').querySelectorAll('[data-redo]').forEach((b) => b.onclick = () => redo(Q.find((x) => x.id === +b.dataset.redo)));
  $('queue').querySelectorAll('[data-dlall]').forEach((b) => b.onclick = () => downloadAll(Q.find((x) => x.id === +b.dataset.dlall)));
  $('queue').querySelectorAll('[data-srt]').forEach((b) => b.onclick = () => { const it = Q.find((x) => x.id === +b.dataset.srt); dl(new Blob([makeSrt(it)], { type: 'text/plain' }), it.base + '.srt'); });
  $('queue').querySelectorAll('details[data-open]').forEach((d) => d.ontoggle = () => { const it = Q.find((x) => x.id === +d.dataset.open); it.open = d.open; if (d.open) renderClips(it); });
  Q.forEach((it) => { const d = document.querySelector(`details[data-open="${it.id}"]`); if (d && d.open) renderClips(it); });
  $('start').disabled = running || !Q.some((x) => x.status === 'queued' || x.status === 'transcribed');
  $('stop').classList.toggle('hidden', !running);
}
// Lightweight progress update without re-rendering the whole list.
function setStage(it, stage, pct) {
  it.stage = stage; if (pct != null) it.pct = Math.max(0, Math.min(100, pct));
  const s = $('qs' + it.id); if (s) s.textContent = stage;
  const b = document.querySelector(`#q${it.id} .bar i`); if (b) b.style.width = it.pct + '%';
}

/* ------------------------------------------------------------------ output target */
$('pickDir').onclick = async () => {
  try { outDir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'clipkaro' }); $('dirName').textContent = '📁 ' + outDir.name; }
  catch (e) { if (e.name !== 'AbortError') alert(e.message); }
};
if (!caps.fsa) $('pickDirWrap').classList.add('hidden');

async function saveClip(it, clip) {
  if (outDir) {
    try {
      const sub = await outDir.getDirectoryHandle(it.base, { create: true });
      const fh = await sub.getFileHandle(clip.name, { create: true });
      const w = await fh.createWritable(); await w.write(clip.blob); await w.close();
      clip.saved = true; return;
    } catch (e) { console.warn('Folder write failed, falling back to download', e); }
  }
  if ($('autoDl').checked) dl(clip.blob, clip.name);
}
async function saveSrt(it) {
  if (!outDir) return;
  try { const sub = await outDir.getDirectoryHandle(it.base, { create: true }); const fh = await sub.getFileHandle(it.base + '.srt', { create: true }); const w = await fh.createWritable(); await w.write(makeSrt(it)); await w.close(); } catch {}
}
function dl(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); }
async function downloadAll(it) { for (const c of it.clips) { if (c.blob) { dl(c.blob, c.name); await sleep(400); } } }

/* ------------------------------------------------------------------ pipeline */
$('start').onclick = async () => {
  if (!caps.webcodecs) { alert('Your browser does not support fast video encoding. Please use Chrome or Edge on a laptop/desktop.'); return; }
  if (running) return;
  running = true; stopReq = false; asrDone = false; $('globalStat').textContent = ''; renderQueue();
  try { await document.fonts.load('900 60px Poppins'); await document.fonts.load('800 60px "Noto Sans Devanagari"'); } catch {}
  const t0 = performance.now();
  await Promise.all([asrLoop(), renderLoop()]);
  running = false; renderQueue();
  const done = Q.filter((x) => x.status === 'done');
  if (done.length && !stopReq) $('globalStat').textContent = `✓ Finished ${done.length} video${done.length > 1 ? 's' : ''} in ${fmtT((performance.now() - t0) / 1000)}.`;
};
$('stop').onclick = async () => { stopReq = true; $('globalStat').textContent = 'Stopping after the current step…'; if (curConv) { try { await curConv.cancel(); } catch {} } };

// Stage 1: audio → words → captions → clips. Runs ahead of rendering so the GPU encoder never waits.
async function asrLoop() {
  while (!stopReq) {
    const it = Q.find((x) => x.status === 'queued' && x.dur);
    if (!it) { if (Q.some((x) => x.status === 'queued' && !x.dur && x.status !== 'error')) { await sleep(300); continue; } break; }
    it.status = 'transcribing'; renderQueue();
    try {
      it.words = [];
      if (opts.style !== 'none' && it.hasAudio) {
        it.words = await transcribe(it);
      }
      if (stopReq) { it.status = 'queued'; setStage(it, 'Stopped', 0); break; }
      it.captions = buildCaptions(it.words);
      it.clips = splitClips(it);
      it.snap = { ...opts };
      it.status = opts.review && opts.style !== 'none' ? 'review' : 'transcribed';
      setStage(it, it.status === 'review' ? `Subtitles ready (${it.words.length} words, ${it.clips.length} clips). Check them below, then export.` : 'Waiting to export…', 0);
      renderQueue(); kickRender();
    } catch (e) {
      console.error(e); it.status = 'error'; setStage(it, 'Subtitles failed: ' + (e.message || e), 0); renderQueue();
    }
  }
  asrDone = true; kickRender();
}
let asrDone = false; let renderWake = null;
function kickRender() { if (renderWake) { const r = renderWake; renderWake = null; r(); } }

// Stage 2: render every clip with WebCodecs.
async function renderLoop() {
  while (!stopReq) {
    const it = Q.find((x) => x.status === 'transcribed');
    if (!it) {
      if (asrDone && !Q.some((x) => x.status === 'review')) break;
      await new Promise((r) => { renderWake = r; setTimeout(r, 1000); });
      continue;
    }
    await renderItem(it, it.clips.map((_, i) => i));
  }
}

async function renderItem(it, list) {
  it.status = 'rendering'; renderQueue();
  const t0 = performance.now(); let doneSec = 0; const totalSec = list.reduce((a, i) => a + it.clips[i].e - it.clips[i].s, 0);
  try {
    for (let k = 0; k < list.length && !stopReq; k++) {
      const i = list[k], c = it.clips[i];
      const blob = await renderClip(it, c, (p) => {
        const sp = (doneSec + p * (c.e - c.s)) / Math.max(0.1, (performance.now() - t0) / 1000);
        setStage(it, `Exporting clip ${i + 1} of ${it.clips.length} · ${sp.toFixed(1)}× real-time`, (doneSec + p * (c.e - c.s)) / totalSec * 100);
      });
      if (!blob) break;
      if (c.url) URL.revokeObjectURL(c.url);
      c.blob = blob; c.url = URL.createObjectURL(blob); c.dirty = false;
      c.name = `${it.base}_part${String(i + 1).padStart(2, '0')}.mp4`;
      await saveClip(it, c);
      doneSec += c.e - c.s;
      const card = $(`clip${it.id}_${i}`); if (card) updateClipCard(it, i);
    }
    if (stopReq) { it.status = 'transcribed'; setStage(it, 'Stopped. Press Start to continue.', it.pct); renderQueue(); return; }
    await saveSrt(it);
    const secs = (performance.now() - t0) / 1000;
    it.status = 'done';
    setStage(it, `✓ ${it.clips.length} clips exported in ${fmtT(secs)} (${(totalSec / secs).toFixed(1)}× real-time)${outDir ? ` · saved to ${outDir.name}/${it.base}` : ''}`, 100);
  } catch (e) {
    console.error(e);
    if (stopReq) { it.status = 'transcribed'; setStage(it, 'Stopped. Press Start to continue.', it.pct); }
    else { it.status = 'error'; setStage(it, 'Export failed: ' + (e.message || e), it.pct); }
  }
  renderQueue();
}

async function redo(it) {
  if (running) return;
  running = true; stopReq = false; renderQueue();
  await renderItem(it, it.clips.map((c, i) => (c.dirty || !c.blob ? i : -1)).filter((i) => i >= 0));
  running = false; renderQueue();
}

/* ------------------------------------------------------------------ audio extraction (streamed, 16 kHz mono) */
async function* audio16k(it, onProg) {
  const input = new Input({ source: new BlobSource(it.file), formats: ALL_FORMATS });
  try {
    const at = await input.getPrimaryAudioTrack();
    if (!at) return;
    const sink = new AudioBufferSink(at);
    const sr = await at.getSampleRate();
    const BLOCK = sr * 60; let acc = new Float32Array(BLOCK), n = 0, first = null;
    const flush = async () => {
      if (!n) return null;
      const len = Math.max(1, Math.round(n * 16000 / sr));
      const oc = new OfflineAudioContext(1, len, 16000);
      const ab = oc.createBuffer(1, n, sr); ab.copyToChannel(acc.subarray(0, n), 0);
      const src = oc.createBufferSource(); src.buffer = ab; src.connect(oc.destination); src.start();
      const out = (await oc.startRendering()).getChannelData(0).slice();
      n = 0; return out;
    };
    for await (const { buffer, timestamp } of sink.buffers()) {
      if (first == null) first = timestamp;
      const ch = buffer.numberOfChannels, len = buffer.length;
      const d0 = buffer.getChannelData(0), d1 = ch > 1 ? buffer.getChannelData(1) : null;
      for (let i = 0; i < len; i++) {
        acc[n++] = d1 ? (d0[i] + d1[i]) * 0.5 : d0[i];
        if (n === BLOCK) { yield { pcm: await flush(), lead: first > 0 ? first : 0 }; first = 0; }
      }
      onProg?.(timestamp);
      if (stopReq) return;
    }
    const last = await flush(); if (last) yield { pcm: last, lead: first > 0 ? first : 0 };
  } finally { input.dispose?.(); }
}

/* ------------------------------------------------------------------ speech-to-text */
let worker = null, workerModel = '', workerDevice = '', jobId = 0; const pending = new Map();
function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./asr-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'dl') onDl?.(m.p);
      else if (m.type === 'ready') { workerDevice = m.device; pending.get('load')?.resolve(m); pending.delete('load'); }
      else if (m.type === 'result') { pending.get(m.id)?.resolve(m); pending.delete(m.id); }
      else if (m.type === 'error') { const k = pending.has(m.id) ? m.id : 'load'; pending.get(k)?.reject(new Error(m.message)); pending.delete(k); }
    };
    worker.onerror = (e) => { for (const [, p] of pending) p.reject(new Error(e.message || 'Speech model crashed')); pending.clear(); worker = null; workerModel = ''; };
  }
  return worker;
}
let onDl = null;
function ask(msg, key, transfer) { return new Promise((resolve, reject) => { pending.set(key, { resolve, reject }); getWorker().postMessage(msg, transfer || []); }); }

async function ensureModel(it) {
  if (workerModel === opts.model) return;
  const files = {};
  onDl = (p) => {
    if (p.status === 'progress' && p.total) {
      files[p.file] = [p.loaded, p.total];
      const L = Object.values(files).reduce((a, b) => a + b[0], 0), T = Object.values(files).reduce((a, b) => a + b[1], 0);
      setStage(it, `Downloading subtitle AI (one time only) · ${(L / 1e6).toFixed(0)} / ${(T / 1e6).toFixed(0)} MB`, L / T * 100);
    }
  };
  setStage(it, 'Loading subtitle AI…', 0);
  await ask({ type: 'load', model: opts.model }, 'load');
  workerModel = opts.model;
}

// Find a quiet moment near the end of a block so we never cut a word in half.
function quietCut(pcm, from, to) {
  const W = 1600; let best = to, bestE = Infinity; // 100 ms windows
  for (let i = Math.max(0, from); i + W <= Math.min(pcm.length, to); i += W / 2) {
    let e = 0; for (let j = i; j < i + W; j += 4) e += pcm[j] * pcm[j];
    if (e < bestE) { bestE = e; best = i + W / 2; }
  }
  return best;
}

async function transcribe(it) {
  await ensureModel(it);
  const SR = 16000, TARGET = SR * 120, LOOK = SR * 8;
  let buf = new Float32Array(0), off = 0, words = [], lead = 0, started = false;
  const t0 = performance.now();
  const runBlock = async (pcm) => {
    const len = pcm.length; // read before the buffer is transferred to the worker
    const r = await ask({ type: 'run', id: ++jobId, audio: pcm, offset: off / SR + lead, language: opts.lang }, jobId, [pcm.buffer]);
    words.push(...r.words);
    off += len;
    const doneSec = off / SR, sp = doneSec / ((performance.now() - t0) / 1000);
    setStage(it, `Writing subtitles (${workerDevice === 'webgpu' ? 'GPU' : 'CPU'}) · ${fmtT(doneSec)} of ${fmtT(it.dur)} · ${sp.toFixed(1)}× real-time`, doneSec / it.dur * 100);
  };
  setStage(it, `Writing subtitles (${workerDevice === 'webgpu' ? 'GPU' : 'CPU'})…`, 0);
  for await (const chunk of audio16k(it)) {
    if (!started) { lead = chunk.lead || 0; started = true; }
    const nb = new Float32Array(buf.length + chunk.pcm.length); nb.set(buf); nb.set(chunk.pcm, buf.length); buf = nb;
    while (buf.length >= TARGET + LOOK) {
      const cut = quietCut(buf, TARGET - LOOK, TARGET + LOOK);
      const block = buf.slice(0, cut); buf = buf.slice(cut);
      await runBlock(block);
      if (stopReq) return words;
    }
  }
  if (buf.length > SR * 0.3 && !stopReq) await runBlock(buf.slice());
  return cleanWords(words);
}

// Drop obvious Whisper hallucinations (same phrase repeated many times, empty tokens).
function cleanWords(words) {
  const out = [];
  for (const w of words) {
    const t = w.w.trim(); if (!t || /^[\s.,!?♪-]+$/.test(t)) continue;
    const p = out[out.length - 1];
    if (p && p.s > w.s) w.s = p.e; // keep monotonic
    if (w.e <= w.s) w.e = w.s + 0.1;
    out.push({ ...w, w: t });
  }
  // collapse runs where the same word repeats > 4 times in a row
  return out.filter((w, i) => !(i >= 4 && [1, 2, 3, 4].every((k) => out[i - k].w.toLowerCase() === w.w.toLowerCase())));
}

/* ------------------------------------------------------------------ captions + clip splitting */
function buildCaptions(words) {
  const caps = []; let cur = [];
  const push = () => { if (cur.length) caps.push({ start: cur[0].s, end: cur[cur.length - 1].e, words: cur }); cur = []; };
  words.forEach((w, i) => {
    const nx = words[i + 1];
    cur.push({ w: w.w, s: w.s, e: w.e });
    const chars = cur.reduce((a, x) => a + x.w.length, 0);
    if (cur.length >= 4 || chars > 16 || /[.,!?।;:]$/.test(w.w) || !nx || nx.s - w.e > 0.6) push();
  });
  for (let i = 0; i < caps.length; i++) {
    const n = caps[i + 1];
    if (n && n.start - caps[i].end < 0.5) caps[i].end = n.start; // no flicker between captions
    else caps[i].end = Math.min(caps[i].end + 0.3, n ? n.start : Infinity);
  }
  return caps;
}

function splitClips(it) {
  const L = opts.len, D = it.dur, W = it.words;
  // candidate cut points: gaps between words (midpoint), scored by pause length + sentence end
  const cand = [];
  for (let i = 0; i < W.length - 1; i++) {
    const gap = W[i + 1].s - W[i].e;
    cand.push({ t: (W[i].e + W[i + 1].s) / 2, gap, sent: /[.!?।]$/.test(W[i].w) });
  }
  const clips = []; let st = 0;
  while (D - st > 0.5) {
    if (D - st <= L * 1.3) { clips.push({ s: st, e: D }); break; }
    const target = st + L;
    let cut = target, best = -Infinity;
    for (const c of cand) {
      if (c.t <= st + 0.7 * L || c.t >= st + 1.3 * L) continue;
      const score = (c.sent ? 2 : 0) + Math.min(c.gap, 1.2) * 2 - Math.abs(c.t - target) / L * 3;
      if (score > best) { best = score; cut = c.t; }
    }
    clips.push({ s: st, e: cut }); st = cut;
  }
  const last = clips[clips.length - 1];
  if (clips.length > 1 && last.e - last.s < 0.4 * L) { clips.pop(); clips[clips.length - 1].e = last.e; }
  return clips;
}
const capsIn = (it, c) => it.captions.filter((x) => x.end > c.s && x.start < c.e);

function makeSrt(it) {
  let n = 0;
  return it.captions.filter((x) => x.words.length).map((x) => `${++n}\n${srtT(x.start)} --> ${srtT(x.end)}\n${x.words.map((w) => w.w).join(' ')}\n`).join('\n');
}

/* ------------------------------------------------------------------ drawing */
function outSize(it, o) {
  if (o.fmt === 'orig') { const sc = Math.min(1, 1920 / Math.max(it.vw, it.vh)); return [Math.round(it.vw * sc / 2) * 2, Math.round(it.vh * sc / 2) * 2]; }
  return [1080, 1920];
}
const bgC = new OffscreenCanvas(27, 48), bgX = bgC.getContext('2d');
function drawVideo(ctx, sample, W, H, o) {
  const vw = sample.displayWidth, vh = sample.displayHeight;
  if (o.fmt === 'orig') { sample.draw(ctx, 0, 0, W, H); return; }
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (o.fmt === 'crop') { const k = Math.max(W / vw, H / vh); sample.draw(ctx, (W - vw * k) / 2, (H - vh * k) / 2, vw * k, vh * k); return; }
  // fit: blurred, darkened copy behind a full contained frame
  const kb = Math.max(27 / vw, 48 / vh); sample.draw(bgX, (27 - vw * kb) / 2, (48 - vh * kb) / 2, vw * kb, vh * kb);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(bgC, 0, 0, W, H);
  ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(0, 0, W, H);
  const k = Math.min(W / vw, H / vh); sample.draw(ctx, (W - vw * k) / 2, (H - vh * k) / 2, vw * k, vh * k);
}

function makeCaptionDrawer(it, o) {
  const caps = it.captions; let idx = 0;
  const layoutCache = new Map();
  return (ctx, t, W, H, forced) => {
    if (o.style === 'none') return;
    let cap = forced;
    if (!cap) {
      // captions are sorted; walk forward (frames arrive in order) but allow seeks backwards
      if (idx > 0 && caps[idx] && caps[idx].start > t) idx = 0;
      while (idx < caps.length && caps[idx].end <= t) idx++;
      cap = caps[idx] && caps[idx].start <= t ? caps[idx] : null;
    }
    if (!cap || !cap.words.length) return;
    drawCaption(ctx, cap, t, W, H, o, layoutCache);
  };
}

function drawCaption(ctx, cap, t, W, H, o, cache) {
  const vertical = H > W, fs = Math.round(vertical ? W * 0.085 : H * 0.075);
  const pop = Math.min(1, Math.max(0, (t - cap.start) / 0.12)), scale = 0.88 + 0.12 * pop;
  const font = `900 ${fs}px Poppins, "Noto Sans Devanagari", Arial, sans-serif`;
  ctx.save();
  const y0 = H * (o.pos === 'mid' ? 0.5 : o.pos === 'bottom' ? 0.86 : (vertical ? 0.72 : 0.8));
  ctx.translate(W / 2, y0); ctx.scale(scale, scale);
  ctx.font = font; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'; ctx.textAlign = 'left';
  const key = cap.words.map((w) => w.w).join(' ') + '|' + W;
  let L = cache && cache.get(key);
  if (!L || L.cap !== cap) {
    const latin = /^[\x00-\x7F’'"“”–—…]+$/.test(cap.words.map((w) => w.w).join(''));
    const words = cap.words.map((w) => ({ ...w, d: latin ? w.w.toUpperCase() : w.w }));
    const space = ctx.measureText(' ').width, maxW = W * 0.86, lines = [[]]; let lw = 0;
    words.forEach((w) => { w.m = ctx.measureText(w.d).width; if (lw + w.m > maxW && lines[lines.length - 1].length) { lines.push([]); lw = 0; } lines[lines.length - 1].push(w); lw += w.m + space; });
    L = { cap, lines, space };
    cache && cache.set(key, L);
  }
  const lh = fs * 1.22, top = -(L.lines.length - 1) * lh / 2;
  L.lines.forEach((ln, li) => {
    const total = ln.reduce((a, w) => a + w.m, 0) + L.space * (ln.length - 1); let x = -total / 2; const y = top + li * lh;
    if (o.style === 'box') { ctx.fillStyle = 'rgba(0,0,0,.72)'; const p = fs * 0.28; roundRect(ctx, x - p, y - lh / 2, total + 2 * p, lh, fs * 0.25); ctx.fill(); }
    ln.forEach((w) => {
      const active = t >= w.s && t < w.e;
      if (o.style !== 'box') { ctx.strokeStyle = '#000'; ctx.lineWidth = fs * 0.2; ctx.strokeText(w.d, x, y); }
      ctx.fillStyle = (o.style === 'highlight' && active) ? '#FFE11A' : '#fff';
      ctx.fillText(w.d, x, y); x += w.m + L.space;
    });
  });
  ctx.restore();
}
function roundRect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }

/* ------------------------------------------------------------------ rendering one clip (WebCodecs via Mediabunny) */
let curConv = null;
async function renderClip(it, c, onProg) {
  const o = it.snap || opts;
  const [W, H] = outSize(it, o);
  const input = new Input({ source: new BlobSource(it.file), formats: ALL_FORMATS });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const needsProcess = !(o.fmt === 'orig' && o.style === 'none');
  let video = { codec: 'avc', frameRate: 30, quality: QUALITY_HIGH, hardwareAcceleration: 'prefer-hardware' };
  if (needsProcess) {
    const cv = new OffscreenCanvas(W, H), ctx = cv.getContext('2d', { alpha: false });
    const drawCap = makeCaptionDrawer(it, o);
    let rel = null;
    video = {
      ...video, processedWidth: W, processedHeight: H, forceTranscode: true,
      process: (sample) => {
        // sample timestamps may be relative to the clip start or absolute; detect once
        if (rel === null) rel = c.s > 1 && sample.timestamp < c.s - 0.5;
        const t = rel ? c.s + sample.timestamp : sample.timestamp;
        drawVideo(ctx, sample, W, H, o);
        drawCap(ctx, t, W, H);
        return cv;
      },
    };
  } else {
    video = { forceTranscode: false };
  }
  const conv = await Conversion.init({
    input, output, trim: { start: c.s, end: c.e }, video,
    audio: { codec: 'aac', quality: QUALITY_HIGH },
    tags: {},
  });
  if (!conv.isValid) {
    // retry with the browser's preferred codecs
    input.dispose?.();
    throw new Error('Cannot encode this video here (' + conv.discardedTracks.map((d) => d.reason).join(', ') + '). Try Chrome or Edge.');
  }
  conv.onProgress = onProg;
  curConv = conv;
  try { await conv.execute(); }
  catch (e) { if (stopReq) return null; throw e; }
  finally { curConv = null; input.dispose?.(); }
  return new Blob([output.target.buffer], { type: 'video/mp4' });
}

/* ------------------------------------------------------------------ results UI */
function renderClips(it) {
  const box = $('clips' + it.id); if (!box) return;
  const o = it.snap || opts;
  box.innerHTML = it.clips.map((c, i) => {
    const cs = capsIn(it, c);
    return `<div class="clip" id="clip${it.id}_${i}"><h4><span>Clip ${i + 1}</span><span class="muted">${fmtT(c.s)}–${fmtT(c.e)} · ${Math.round(c.e - c.s)}s</span></h4>
      <div class="media">${c.url ? `<video src="${c.url}" controls playsinline preload="metadata"></video>` : c.thumb ? `<img class="thumb" src="${c.thumb}" alt="">` : `<canvas class="thumb" id="th${it.id}_${i}"></canvas>`}</div>
      ${o.style !== 'none' && cs.length ? `<div class="caps">${cs.map((cp) => `<div><span class="t">${fmtT(cp.start)}</span><input data-ci="${it.captions.indexOf(cp)}" value="${esc(cp.words.map((w) => w.w).join(' '))}"></div>`).join('')}</div>` : `<div class="small muted">${o.style === 'none' ? 'Captions off' : 'No speech in this part'}</div>`}
      <div class="status cst">${c.url ? `<span class="ok">✓ Ready</span> · ${(c.blob.size / 1e6).toFixed(1)} MB · <a href="${c.url}" download="${c.name}">Download</a>${c.dirty ? ' · <b class="warnTxt">edited — re-export</b>' : ''}` : (it.status === 'rendering' ? 'Waiting…' : '')}</div></div>`;
  }).join('');
  box.querySelectorAll('.caps input').forEach((inp) => inp.onchange = () => editCaption(it, +inp.dataset.ci, inp.value));
  drawThumbs(it);
}
function updateClipCard(it, i) {
  const d = document.querySelector(`details[data-open="${it.id}"]`); if (d && d.open) renderClips(it);
}
function editCaption(it, ci, text) {
  const c = it.captions[ci], words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) c.words = [];
  else {
    const total = words.reduce((a, w) => a + w.length + 1, 0), s0 = c.words[0]?.s ?? c.start, e0 = c.words[c.words.length - 1]?.e ?? c.end, dur = e0 - s0; let t = s0;
    c.words = words.map((w) => { const d = dur * (w.length + 1) / total, o = { w, s: t, e: t + d }; t += d; return o; });
  }
  it.clips.forEach((cl) => { if (cl.blob && c.end > cl.s && c.start < cl.e) cl.dirty = true; });
  if (it.status === 'done') renderQueue();
}
async function drawThumbs(it) {
  const o = it.snap || opts; const [W0, H0] = outSize(it, o); const k = 300 / Math.max(W0, H0); const W = Math.round(W0 * k), H = Math.round(H0 * k);
  const todo = it.clips.map((c, i) => ({ c, i, cv: $(`th${it.id}_${i}`) })).filter((x) => x.cv && !x.cv.dataset.done);
  if (!todo.length) return;
  const input = new Input({ source: new BlobSource(it.file), formats: ALL_FORMATS });
  try {
    const sink = new VideoSampleSink(await input.getPrimaryVideoTrack());
    const ts = todo.map(({ c, i }) => { const cp = capsIn(it, c)[0]; return cp ? Math.max(c.s, cp.start + 0.05) : c.s + Math.min(1.5, (c.e - c.s) / 2); });
    let n = 0;
    for await (const sample of sink.samplesAtTimestamps(ts)) {
      const { c, i, cv } = todo[n]; const t = ts[n]; n++;
      if (!sample) continue;
      cv.width = W; cv.height = H; const ctx = cv.getContext('2d');
      drawVideo(ctx, sample, W, H, o);
      const cp = capsIn(it, c)[0]; if (cp && o.style !== 'none') drawCaption(ctx, cp, cp.start + 0.13, W, H, o, null);
      cv.dataset.done = 1; sample.close();
      try { c.thumb = cv.toDataURL('image/jpeg', 0.75); } catch {}
    }
  } catch (e) { console.warn('thumbs', e); } finally { input.dispose?.(); }
}

window.addEventListener('beforeunload', (e) => { if (running) { e.preventDefault(); e.returnValue = ''; } });
