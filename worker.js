// worker.js — computes the loudness summary of long files off the main thread (module worker).
import { summarise } from './peaks.js';

self.onmessage = (e) => {
  const { channels, length } = e.data;
  try {
    let last = -1;
    const s = summarise(channels.map((b) => new Float32Array(b)), length, (p) => {
      const pct = Math.floor(p * 100);
      if (pct !== last) { last = pct; self.postMessage({ type: 'progress', value: p }); }
    });
    self.postMessage({ type: 'done', max: s.max, ms: s.ms, block: s.block, peak: s.peak, rawPeak: s.rawPeak }, [s.max.buffer, s.ms.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
