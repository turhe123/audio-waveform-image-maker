// peaks.js — shared by app.js and worker.js. Turns decoded channels into a compact loudness summary,
// then into one value per drawn column.

// About 256k summary blocks: fine enough for 4000 columns even on a short range, small enough for hours of audio.
export const SUMMARY_TARGET = 262144;

/**
 * Mixes channels to mono and summarises them in blocks of `block` samples.
 * Returns { max, ms, block, peak } where max is the largest absolute sample per block, ms the mean square,
 * peak the loudest absolute sample of the mix and rawPeak the loudest sample of any single channel.
 */
export function summarise(channels, length, onProgress) {
  const block = Math.max(1, Math.ceil(length / SUMMARY_TARGET));
  const count = Math.ceil(length / block);
  const max = new Float32Array(count);
  const ms = new Float32Array(count);
  const nCh = channels.length;
  const inv = 1 / nCh;
  let peak = 0, rawPeak = 0;
  const step = Math.max(1, Math.floor(count / 50));
  for (let b = 0; b < count; b++) {
    const from = b * block;
    const to = Math.min(length, from + block);
    let m = 0, sq = 0;
    for (let i = from; i < to; i++) {
      let v = 0;
      for (let c = 0; c < nCh; c++) {
        const x = channels[c][i];
        v += x;
        if (x > rawPeak) rawPeak = x; else if (-x > rawPeak) rawPeak = -x;
      }
      v *= inv;
      const a = v < 0 ? -v : v;
      if (a > m) m = a;
      sq += v * v;
    }
    max[b] = m;
    ms[b] = sq / (to - from);
    if (m > peak) peak = m;
    if (onProgress && b % step === 0) onProgress(b / count);
  }
  return { max, ms, block, peak, rawPeak };
}

/**
 * One value in 0..1 per column for the block range [b0, b1), normalised to the loudest column.
 * Returns { values, silent }.
 */
export function columns(summary, n, b0, b1, mode) {
  const values = new Float32Array(n);
  const span = Math.max(1, b1 - b0);
  let top = 0;
  for (let i = 0; i < n; i++) {
    const from = b0 + Math.floor((i * span) / n);
    const to = Math.max(from + 1, b0 + Math.floor(((i + 1) * span) / n));
    let v = 0;
    if (mode === 'rms') {
      let s = 0;
      for (let b = from; b < to; b++) s += summary.ms[b] || 0;
      v = Math.sqrt(s / (to - from));
    } else {
      for (let b = from; b < to; b++) if (summary.max[b] > v) v = summary.max[b];
    }
    values[i] = v;
    if (v > top) top = v;
  }
  const silent = top < 1e-4; // quieter than -80 dBFS: treat as silence
  if (!silent) for (let i = 0; i < n; i++) values[i] /= top;
  else values.fill(0);
  return { values, silent };
}
