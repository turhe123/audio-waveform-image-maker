// app.js — Audio Waveform Image Maker. Decodes one local audio file with WebAudio, summarises its loudness,
// draws bars / mirrored lines / an outline to a canvas and exports the same shapes as PNG or SVG.
// Everything runs on this device; the only fetch() is in window.__demo, which loads a bundled fixture.
import { toast, downloadBlob, formatBytes, wireDropzone } from './site.js';
import { summarise, columns } from './peaks.js';

const $ = (id) => document.getElementById(id);
const zone = $('dropzone');
const input = $('file-input');
const results = $('results');
const form = $('options');
const canvas = $('preview');
const wrap = $('preview-wrap');
const infoLine = $('info-line');
const progress = $('progress');
const btnPng = $('download-png');
const btnSvg = $('download-svg');
const rangeHint = $('range-hint');

const MAX_SIDE = 4000;
const WORKER_SECONDS = 600; // files longer than ten minutes are summarised in a Web Worker
const HEAVY_CHANNEL_SECONDS = 2 * 3600; // about one hour of stereo audio
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const SAFE_PIXELS = IS_IOS ? 16_777_216 : 64_000_000; // mobile Safari refuses canvases above ~16.7 MP
const AUDIO_EXT = /\.(mp3|wav|wave|ogg|oga|opus|flac|m4a|aac|aif|aiff|caf|weba|webm|mp4|m4b)$/i;

// ---------- state ----------
let audio = null; // { name, size, duration, sampleRate, rateKnown, channels, summary }
let messages = []; // [{ kind: 'error' | 'warn' | 'info', text }]
let loadToken = 0;
let drawQueued = false;

// ---------- small helpers ----------
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r2 = (v) => Math.round(v * 100) / 100;

function formatTime(sec) {
  if (!Number.isFinite(sec)) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec - h * 3600 - m * 60;
  const ss = s.toFixed(1).padStart(4, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function parseTime(text) {
  const t = text.trim();
  if (!t) return null;
  if (!/^\d+(?::\d{1,2})*(?:[.,]\d+)?$/.test(t)) return NaN;
  return t.replace(',', '.').split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
}

function baseName(name) {
  const stem = name.replace(/\.[^.]+$/, '') || 'audio';
  return stem.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim() || 'audio';
}

function isAudioFile(file) {
  if (file.type && file.type.startsWith('audio/')) return true;
  return AUDIO_EXT.test(file.name);
}

// ---------- options ----------
function readOptions() {
  let W, H;
  const size = $('size').value;
  if (size === 'custom') {
    W = clamp(Math.round(Number($('width').value) || 1920), 16, MAX_SIDE);
    H = clamp(Math.round(Number($('height').value) || 1080), 16, MAX_SIDE);
  } else {
    [W, H] = size.split('x').map(Number);
  }
  return {
    W, H,
    style: $('style').value,
    mode: $('mode').value,
    barW: Number($('bar-width').value),
    gap: Number($('bar-gap').value),
    color: $('color').value,
    color2: $('color2').value,
    gradient: $('gradient').checked,
    bg: $('bg').value,
    transparent: $('transparent').checked,
    rounded: $('rounded').checked,
  };
}

/** Block range [b0, b1) of the summary to draw, plus a validation message for the range fields. */
function readRange() {
  if (!audio) return { b0: 0, b1: 0, note: '' };
  const { summary, duration } = audio;
  const total = summary.max.length;
  let start = parseTime($('start').value);
  let end = parseTime($('end').value);
  let note = '';
  if (Number.isNaN(start) || Number.isNaN(end)) note = 'Use m:ss or seconds, for example 1:05 or 65.';
  else {
    start = start ?? 0;
    end = end ?? duration;
    if (start >= duration) note = `Start is past the end of the file (${formatTime(duration)}).`;
    else if (end <= start) note = 'End must be after start.';
  }
  if (note) return { b0: 0, b1: total, note, start: 0, end: duration };
  end = Math.min(end, duration);
  const perSec = total / duration;
  const b0 = clamp(Math.floor(start * perSec), 0, total - 1);
  const b1 = clamp(Math.ceil(end * perSec), b0 + 1, total);
  return { b0, b1, note: '', start, end };
}

// ---------- geometry (shared by canvas and SVG) ----------
function columnCount(o) {
  if (o.style === 'outline') return Math.max(2, Math.floor(o.W / Math.max(2, o.barW + o.gap)) + 1);
  return Math.max(1, Math.floor((o.W + o.gap) / (o.barW + o.gap)));
}

// Fictional sample shape for the empty state: three loud sections with quiet gaps.
function sampleValues(n) {
  const values = new Float32Array(n);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const bump = (a, b, g) => (t > a && t < b ? g * Math.sin(((t - a) / (b - a)) * Math.PI) ** 0.4 : 0);
    const env = Math.max(0.04, bump(0.03, 0.29, 1), bump(0.38, 0.57, 0.6), bump(0.66, 0.96, 0.85));
    values[i] = Math.min(1, env * (0.55 + 0.45 * rand()));
  }
  return { values, silent: false };
}

function computeShapes(o) {
  const n = columnCount(o);
  let data;
  if (audio) {
    const { b0, b1 } = readRange();
    data = columns(audio.summary, n, b0, b1, o.mode);
  } else data = sampleValues(n);
  const { values } = data;
  const { W, H } = o;
  const mid = H / 2;
  const maxH = H * 0.84;
  const step = o.barW + o.gap;
  const used = n * step - o.gap;
  const x0 = (W - used) / 2;
  const shapes = { kind: o.style, silent: data.silent, items: [], lineWidth: o.barW };
  if (o.style === 'bars') {
    const minH = Math.max(1, Math.min(o.barW, 2));
    for (let i = 0; i < n; i++) {
      const h = Math.max(minH, values[i] * maxH);
      shapes.items.push({ x: x0 + i * step, y: mid - h / 2, w: o.barW, h, r: o.rounded ? Math.min(o.barW, h) / 2 : 0 });
    }
  } else if (o.style === 'lines') {
    const cap = o.rounded ? o.barW / 2 : 0;
    for (let i = 0; i < n; i++) {
      const half = Math.max(0.5, (values[i] * maxH) / 2 - cap);
      shapes.items.push({ x: x0 + i * step + o.barW / 2, y1: mid - half, y2: mid + half });
    }
  } else {
    shapes.lineWidth = Math.max(1, Math.round(o.barW / 3));
    const inset = shapes.lineWidth;
    const dx = (W - 2 * inset) / (n - 1);
    for (let i = 0; i < n; i++) shapes.items.push({ x: inset + i * dx, a: Math.max(0.5, (values[i] * maxH) / 2) });
  }
  return shapes;
}

// ---------- canvas rendering ----------
function paint(ctx, o, shapes, scale) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  if (!o.transparent) {
    ctx.fillStyle = o.bg;
    ctx.fillRect(0, 0, o.W, o.H);
  }
  let paintStyle = o.color;
  if (o.gradient) {
    paintStyle = ctx.createLinearGradient(0, 0, o.W, 0);
    paintStyle.addColorStop(0, o.color);
    paintStyle.addColorStop(1, o.color2);
  }
  const mid = o.H / 2;
  if (shapes.kind === 'bars') {
    ctx.fillStyle = paintStyle;
    ctx.beginPath();
    for (const b of shapes.items) {
      if (b.r > 0 && ctx.roundRect) ctx.roundRect(b.x, b.y, b.w, b.h, b.r);
      else ctx.rect(b.x, b.y, b.w, b.h);
    }
    ctx.fill();
  } else if (shapes.kind === 'lines') {
    ctx.strokeStyle = paintStyle;
    ctx.lineWidth = shapes.lineWidth;
    ctx.lineCap = o.rounded ? 'round' : 'butt';
    ctx.beginPath();
    for (const l of shapes.items) { ctx.moveTo(l.x, l.y1); ctx.lineTo(l.x, l.y2); }
    ctx.stroke();
  } else {
    ctx.strokeStyle = paintStyle;
    ctx.lineWidth = shapes.lineWidth;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    shapes.items.forEach((p, i) => (i ? ctx.lineTo(p.x, mid - p.a) : ctx.moveTo(p.x, mid - p.a)));
    for (let i = shapes.items.length - 1; i >= 0; i--) ctx.lineTo(shapes.items[i].x, mid + shapes.items[i].a);
    ctx.closePath();
    ctx.stroke();
  }
}

// ---------- SVG ----------
function buildSvg(o, shapes) {
  const paintRef = o.gradient ? 'url(#wf-gradient)' : o.color;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${o.W}" height="${o.H}" viewBox="0 0 ${o.W} ${o.H}">`];
  if (o.gradient) {
    parts.push(`<defs><linearGradient id="wf-gradient" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${o.W}" y2="0">`
      + `<stop offset="0" stop-color="${o.color}"/><stop offset="1" stop-color="${o.color2}"/></linearGradient></defs>`);
  }
  if (!o.transparent) parts.push(`<rect width="${o.W}" height="${o.H}" fill="${o.bg}"/>`);
  const mid = o.H / 2;
  if (shapes.kind === 'bars') {
    parts.push(`<g fill="${paintRef}">`);
    for (const b of shapes.items) {
      const rx = b.r > 0 ? ` rx="${r2(b.r)}"` : '';
      parts.push(`<rect x="${r2(b.x)}" y="${r2(b.y)}" width="${r2(b.w)}" height="${r2(b.h)}"${rx}/>`);
    }
    parts.push('</g>');
  } else if (shapes.kind === 'lines') {
    const d = shapes.items.map((l) => `M${r2(l.x)} ${r2(l.y1)}V${r2(l.y2)}`).join('');
    parts.push(`<path d="${d}" fill="none" stroke="${paintRef}" stroke-width="${shapes.lineWidth}" stroke-linecap="${o.rounded ? 'round' : 'butt'}"/>`);
  } else {
    const top = shapes.items.map((p, i) => `${i ? 'L' : 'M'}${r2(p.x)} ${r2(mid - p.a)}`).join('');
    const bottom = shapes.items.slice().reverse().map((p) => `L${r2(p.x)} ${r2(mid + p.a)}`).join('');
    parts.push(`<path d="${top}${bottom}Z" fill="none" stroke="${paintRef}" stroke-width="${shapes.lineWidth}" stroke-linejoin="round"/>`);
  }
  parts.push('</svg>');
  return parts.join('\n');
}

// ---------- preview ----------
function draw() {
  drawQueued = false;
  const o = readOptions();
  const shapes = computeShapes(o);
  const availW = Math.max(40, wrap.clientWidth - 24);
  const maxH = window.innerWidth < 720 ? 300 : 420;
  const cssW = Math.min(availW, (maxH * o.W) / o.H);
  const cssH = (cssW * o.H) / o.W;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const pw = Math.max(1, Math.round(cssW * dpr));
  const ph = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  paint(canvas.getContext('2d'), o, shapes, pw / o.W);
  canvas.dataset.style = o.style;
  canvas.dataset.silent = String(shapes.silent);
  canvas.setAttribute('aria-label', audio
    ? `Waveform of ${audio.name}, ${o.style === 'bars' ? 'bars' : o.style === 'lines' ? 'mirrored lines' : 'outline'}, ${o.W} by ${o.H} pixels`
    : 'Sample waveform preview');
  wrap.classList.toggle('is-transparent', o.transparent);

  if (audio) {
    const range = readRange();
    rangeHint.textContent = range.note || (range.start > 0 || range.end < audio.duration
      ? `Drawing ${formatTime(range.start)} to ${formatTime(range.end)}.`
      : 'Leave empty to draw the whole file.');
    rangeHint.classList.toggle('stat--danger', Boolean(range.note));
    const silentNote = 'This audio is silent, so the waveform is a flat line.';
    const had = messages.some((m) => m.text === silentNote);
    if (shapes.silent !== had) {
      messages = shapes.silent ? [...messages, { kind: 'info', text: silentNote }] : messages.filter((m) => m.text !== silentNote);
      renderResults(false);
    }
  }
}

function schedule() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(draw);
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ---------- results area ----------
function renderResults(scroll) {
  results.replaceChildren();
  if (audio) {
    const card = document.createElement('div');
    card.className = 'result';
    card.innerHTML = '<div class="result__meta"><div class="result__name"></div><div class="result__info"></div></div>';
    card.querySelector('.result__name').textContent = audio.name;
    card.querySelector('.result__info').textContent = `${formatBytes(audio.size)} · ready to download as ${baseName(audio.name)}-waveform.png or .svg`;
    results.appendChild(card);
    if (scroll) card.scrollIntoView({ block: 'nearest' });
  }
  for (const m of messages) {
    const el = document.createElement('div');
    el.className = m.kind === 'error' ? 'alert alert--error' : m.kind === 'warn' ? 'alert alert--warn' : 'alert';
    if (m.kind === 'error') el.setAttribute('role', 'alert');
    el.textContent = m.text;
    results.appendChild(el);
  }
}

function infoText(a) {
  const ch = a.channels === 1 ? 'Mono' : a.channels === 2 ? 'Stereo' : `${a.channels} channels`;
  const rate = `${r2(a.sampleRate / 1000)} kHz${a.rateKnown ? '' : ' (decoded)'}`;
  const peak = a.summary.rawPeak > 0 ? `${(20 * Math.log10(a.summary.rawPeak)).toFixed(1).replace('-', '−')} dBFS` : 'silent';
  return `Duration ${formatTime(a.duration)} · ${rate} · ${ch} · Peak ${peak}`;
}

function setProgress(fraction, label) {
  if (fraction == null) { progress.hidden = true; return; }
  progress.hidden = false;
  const pct = Math.floor(fraction * 1000) / 10; // round down: 99.9% is not 100%
  progress.firstElementChild.style.width = `${pct}%`;
  progress.setAttribute('aria-valuenow', String(Math.floor(pct)));
  if (label) infoLine.textContent = label;
}

// ---------- decoding ----------
/** Reads the native sample rate from common container headers (decodeAudioData always resamples). */
function sniffSampleRate(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (o, n) => String.fromCharCode(...bytes.subarray(o, o + n));
  if (bytes.length < 12) return 0;
  if (str(0, 4) === 'RIFF' && str(8, 4) === 'WAVE') {
    for (let o = 12; o + 8 <= bytes.length;) {
      const size = dv.getUint32(o + 4, true);
      if (str(o, 4) === 'fmt ' && o + 16 <= bytes.length) return dv.getUint32(o + 12, true);
      o += 8 + size + (size & 1);
    }
    return 0;
  }
  if (str(0, 4) === 'fLaC' && bytes.length > 21) return (bytes[18] << 12) | (bytes[19] << 4) | (bytes[20] >> 4);
  if (str(0, 4) === 'OggS') {
    const head = str(0, Math.min(bytes.length, 200));
    if (head.includes('OpusHead')) return 48000;
    const v = head.indexOf('\x01vorbis');
    if (v >= 0 && v + 16 <= bytes.length) return dv.getUint32(v + 12, true);
    return 0;
  }
  // MP3: skip an ID3v2 tag, then read the first frame header
  let o = 0;
  if (str(0, 3) === 'ID3') o = 10 + ((bytes[6] & 0x7f) << 21 | (bytes[7] & 0x7f) << 14 | (bytes[8] & 0x7f) << 7 | (bytes[9] & 0x7f)) + (bytes[5] & 0x10 ? 10 : 0);
  for (const end = Math.min(bytes.length - 4, o + 65536); o < end; o++) {
    if (bytes[o] !== 0xff || (bytes[o + 1] & 0xe0) !== 0xe0) continue;
    const ver = (bytes[o + 1] >> 3) & 3, layer = (bytes[o + 1] >> 1) & 3, rateIdx = (bytes[o + 2] >> 2) & 3, br = bytes[o + 2] >> 4;
    if (ver === 1 || layer === 0 || rateIdx === 3 || br === 15) continue;
    const base = [44100, 48000, 32000][rateIdx];
    return ver === 3 ? base : ver === 2 ? base / 2 : base / 4;
  }
  return 0;
}

async function decode(arrayBuffer) {
  const sniffed = sniffSampleRate(new Uint8Array(arrayBuffer, 0, Math.min(arrayBuffer.byteLength, 1 << 20)));
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  let ctx;
  try { ctx = new Offline(1, 1, sniffed >= 8000 && sniffed <= 384000 ? sniffed : 48000); } catch { ctx = new Offline(1, 1, 48000); }
  const buffer = await new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
    if (p && p.catch) p.catch(reject);
  });
  return { buffer, sniffed };
}

function summariseInWorker(buffer, token) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).slice().buffer);
    worker.onmessage = (e) => {
      const msg = e.data;
      if (token !== loadToken) { worker.terminate(); reject(new Error('stale')); return; }
      if (msg.type === 'progress') setProgress(msg.value, `Analysing ${Math.floor(msg.value * 100)}%…`);
      else if (msg.type === 'done') { worker.terminate(); resolve({ max: msg.max, ms: msg.ms, block: msg.block, peak: msg.peak, rawPeak: msg.rawPeak }); }
      else { worker.terminate(); reject(new Error(msg.message)); }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'Worker failed')); };
    worker.postMessage({ channels, length: buffer.length }, channels);
  });
}

async function loadFile(file) {
  const token = ++loadToken;
  btnPng.disabled = true;
  btnSvg.disabled = true;
  setProgress(0.02, `Decoding ${file.name}…`);
  try {
    const data = await file.arrayBuffer();
    if (token !== loadToken) return;
    let decoded;
    try {
      decoded = await decode(data);
    } catch {
      throw new Error(`Could not decode ${file.name}. The file may be damaged, empty or in a format this browser cannot play. Try MP3, WAV, OGG or FLAC.`);
    }
    if (token !== loadToken) return;
    const { buffer, sniffed } = decoded;
    if (!buffer.length) throw new Error(`${file.name} contains no audio samples.`);
    let summary;
    if (buffer.duration > WORKER_SECONDS && window.Worker) {
      setProgress(0.05, 'Analysing 0%…');
      summary = await summariseInWorker(buffer, token);
    } else {
      const chans = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
      summary = summarise(chans, buffer.length);
    }
    if (token !== loadToken) return;
    audio = {
      name: file.name,
      size: file.size,
      duration: buffer.duration,
      sampleRate: sniffed || buffer.sampleRate,
      rateKnown: Boolean(sniffed),
      channels: buffer.numberOfChannels,
      summary,
    };
    if (buffer.duration * buffer.numberOfChannels > HEAVY_CHANNEL_SECONDS) {
      messages.push({ kind: 'warn', text: `This is a long recording (${formatTime(buffer.duration)}). Decoded audio this size uses a lot of memory; if the page slows down, draw a shorter excerpt or close other tabs.` });
    }
    setProgress(null);
    infoLine.textContent = infoText(audio);
    $('start').value = '';
    $('end').value = '';
    btnPng.disabled = false;
    btnSvg.disabled = false;
    draw();
    renderResults(true);
    toast('Waveform ready. Nothing was uploaded.');
  } catch (err) {
    if (token !== loadToken || err.message === 'stale') return;
    setProgress(null);
    audio = null;
    infoLine.textContent = 'Sample preview. Load an audio file to draw its waveform.';
    messages.push({ kind: 'error', text: err.message || String(err) });
    renderResults(false);
    schedule();
  }
}

function handleFiles(files) {
  messages = [];
  const good = files.filter(isAudioFile);
  const bad = files.filter((f) => !isAudioFile(f));
  if (bad.length) {
    const names = bad.slice(0, 3).map((f) => f.name).join(', ') + (bad.length > 3 ? ` and ${bad.length - 3} more` : '');
    messages.push({ kind: 'error', text: `${names} ${bad.length === 1 ? 'is not an audio file' : 'are not audio files'} and ${bad.length === 1 ? 'was' : 'were'} skipped. Choose an MP3, WAV, OGG, FLAC or M4A file.` });
  }
  if (good.length > 1) messages.push({ kind: 'info', text: `One file at a time: drawing ${good[0].name}.` });
  renderResults(false);
  if (good.length) loadFile(good[0]);
}

// ---------- downloads ----------
function exportSize(o) {
  const px = o.W * o.H;
  if (px <= SAFE_PIXELS) return { W: o.W, H: o.H, clamped: false };
  const k = Math.sqrt(SAFE_PIXELS / px);
  return { W: Math.floor(o.W * k), H: Math.floor(o.H * k), clamped: true };
}

function renderPng(o) {
  return new Promise((resolve) => {
    const c = document.createElement('canvas');
    c.width = o.W;
    c.height = o.H;
    const ctx = c.getContext('2d');
    if (!ctx) { resolve(null); return; }
    paint(ctx, o, computeShapes(o), 1);
    c.toBlob(resolve, 'image/png');
  });
}

async function downloadPng() {
  if (!audio) { toast('Load an audio file first.'); return; }
  const o = readOptions();
  const safe = exportSize(o);
  let opts = { ...o, W: safe.W, H: safe.H };
  let blob = await renderPng(opts);
  let clamped = safe.clamped;
  while (!blob && opts.W > 256) { // the browser refused this canvas size: halve until it fits
    opts = { ...opts, W: Math.floor(opts.W / 2), H: Math.floor(opts.H / 2) };
    clamped = true;
    blob = await renderPng(opts);
  }
  if (!blob) {
    messages.push({ kind: 'error', text: 'This browser could not create the PNG. Try a smaller image size or the SVG download.' });
    renderResults(false);
    return;
  }
  if (clamped) {
    messages.push({ kind: 'warn', text: `This browser limits canvas size, so the PNG was saved at ${opts.W} × ${opts.H} instead of ${o.W} × ${o.H}. The SVG has no such limit.` });
    renderResults(false);
  }
  downloadBlob(blob, `${baseName(audio.name)}-waveform.png`);
  toast(`Saved PNG, ${opts.W} × ${opts.H}, ${formatBytes(blob.size)}`);
}

function downloadSvg() {
  if (!audio) { toast('Load an audio file first.'); return; }
  const o = readOptions();
  const svg = buildSvg(o, computeShapes(o));
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  downloadBlob(blob, `${baseName(audio.name)}-waveform.svg`);
  toast(`Saved SVG, ${o.W} × ${o.H}, ${formatBytes(blob.size)}`);
}

// ---------- wiring ----------
wireDropzone(zone, input, handleFiles);
btnPng.addEventListener('click', downloadPng);
btnSvg.addEventListener('click', downloadSvg);
form.addEventListener('submit', (e) => { e.preventDefault(); downloadPng(); });
form.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;
  const t = e.target;
  if (t.tagName === 'BUTTON' || (t.tagName === 'INPUT' && ['text', 'number'].includes(t.type))) return; // those submit the form
  e.preventDefault();
  downloadPng();
});

const outputs = { 'bar-width': 'bar-width-out', 'bar-gap': 'bar-gap-out' };
const debouncedDraw = debounce(schedule, 40);
for (const [id, out] of Object.entries(outputs)) {
  $(id).addEventListener('input', () => { $(out).textContent = `${$(id).value} px`; debouncedDraw(); });
}
for (const id of ['style', 'mode', 'gradient', 'transparent', 'rounded', 'color', 'color2', 'bg']) {
  $(id).addEventListener('input', schedule);
  $(id).addEventListener('change', schedule);
}
$('size').addEventListener('change', () => {
  const custom = $('size').value === 'custom';
  $('custom-size').hidden = !custom;
  if (!custom) {
    const [w, h] = $('size').value.split('x');
    $('width').value = w;
    $('height').value = h;
  }
  schedule();
});
const debouncedText = debounce(schedule, 250);
for (const id of ['width', 'height', 'start', 'end']) $(id).addEventListener('input', debouncedText);
for (const id of ['width', 'height']) {
  $(id).addEventListener('change', () => {
    const el = $(id);
    const v = clamp(Math.round(Number(el.value) || 0), 16, MAX_SIDE);
    if (String(v) !== el.value) { el.value = v; toast(`Size kept between 16 and ${MAX_SIDE} pixels.`); }
    schedule();
  });
}
$('gradient').addEventListener('change', () => { $('color2').disabled = !$('gradient').checked; });
$('transparent').addEventListener('change', () => { $('bg').disabled = $('transparent').checked; });

if ('ResizeObserver' in window) new ResizeObserver(schedule).observe(wrap);
else window.addEventListener('resize', schedule);
schedule();

// Called by the factory's screenshot script to show the tool in a realistic, fictional state.
window.__demo = async () => {
  const res = await fetch('./tests/fixtures/sample-song.mp3');
  const blob = await res.blob();
  handleFiles([new File([blob], 'Sample Song.mp3', { type: 'audio/mpeg' })]);
  const until = Date.now() + 10_000;
  await new Promise((resolve) => {
    const check = () => (audio || Date.now() > until ? resolve() : setTimeout(check, 50));
    check();
  });
};

export { handleFiles, buildSvg, sniffSampleRate };
