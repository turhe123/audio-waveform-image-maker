// Writes tests/fixtures/sample-song.mp3: "Sample Song", a fictional 12 s generated tune with three loud
// sections and quiet gaps. No encoder is needed: each MPEG-1 Layer III frame (mono, 48 kHz, 32 kbps)
// carries a couple of non-zero spectral lines whose loudness is set through global_gain.
// Run: node tests/tools/make-sample-song.js
const fs = require('fs');
const path = require('path');

const RATE = 48000, GRANULE = 576, SECS = 12;
const FRAME_BYTES = 96; // 144 * 32000 / 48000, no padding
const frames = Math.ceil((RATE * SECS) / (GRANULE * 2));
const sections = [[0.4, 3.4, 1.0], [4.6, 6.8, 0.55], [8.0, 11.4, 0.8]];

function envelope(t) {
  let env = 0.02; // quiet gap
  for (const [a, b, g] of sections) {
    if (t < a || t >= b) continue;
    const x = (t - a) / (b - a);
    const beat = 0.6 + 0.4 * Math.abs(Math.sin(t * Math.PI * 2.5));
    env = Math.max(env, g * Math.min(1, x * 10, (1 - x) * 10) * beat);
  }
  return env;
}

class Bits {
  constructor(bytes) { this.buf = Buffer.alloc(bytes); this.pos = 0; }
  put(value, n) { for (let i = n - 1; i >= 0; i--) { if ((value >> i) & 1) this.buf[this.pos >> 3] |= 0x80 >> (this.pos & 7); this.pos++; } }
}

// Huffman table 1 (|x|,|y| in 0..1): code, length
const T1 = { '0,0': [0b1, 1], '0,1': [0b001, 3], '1,0': [0b01, 2], '1,1': [0b000, 3] };
// Spectral lines 0..7 (big_values = 4 pairs). Line 3 and 6 carry the tone.
function granuleBits(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i += 2) {
    const x = lines[i], y = lines[i + 1];
    const [code, len] = T1[`${Math.abs(x)},${Math.abs(y)}`];
    out.push([code, len]);
    if (x) out.push([x < 0 ? 1 : 0, 1]);
    if (y) out.push([y < 0 ? 1 : 0, 1]);
  }
  return out;
}

const chunks = [];
for (let f = 0; f < frames; f++) {
  const b = new Bits(FRAME_BYTES);
  b.put(0xFFFB, 16); b.put(0x14, 8); b.put(0xC0, 8); // MPEG-1 L3, 32 kbps, 48 kHz, mono
  const grans = [0, 1].map((g) => {
    const t = ((f * 2 + g) * GRANULE) / RATE;
    const env = envelope(t);
    const gain = Math.max(0, Math.min(255, Math.round(204 + 4 * Math.log2(env))));
    const sign = (f * 2 + g) % 2 ? -1 : 1;
    const bits = granuleBits([0, 0, 0, sign, 0, 0, 1, 0]);
    return { gain, bits, len: bits.reduce((s, [, l]) => s + l, 0) };
  });
  b.put(0, 9); b.put(0, 5); b.put(0, 4); // main_data_begin, private bits, scfsi
  for (const g of grans) {
    b.put(g.len, 12); b.put(4, 9); b.put(g.gain, 8); b.put(0, 4); b.put(0, 1);
    b.put(1, 5); b.put(1, 5); b.put(1, 5); // table_select
    b.put(0, 4); b.put(0, 3); b.put(0, 1); b.put(0, 1); b.put(0, 1);
  }
  for (const g of grans) for (const [code, len] of g.bits) b.put(code, len);
  chunks.push(b.buf);
}
const out = path.join(__dirname, '..', 'fixtures', 'sample-song.mp3');
fs.writeFileSync(out, Buffer.concat(chunks));
console.log('wrote', out, frames, 'frames');
