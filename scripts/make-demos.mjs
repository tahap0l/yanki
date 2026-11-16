// Özgün demo parçalarını sentezler (bu proje için üretildi, CC0).
// Çıktı: public/demo/*.mp3 ve test/truth/*.json (gerçek vuruş/ölçü başı/bölüm zamanları)
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SR = 44100;
mkdirSync('public/demo', { recursive: true });
mkdirSync('test/truth', { recursive: true });
mkdirSync('/tmp/demo-wav', { recursive: true });

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

class Mix {
  constructor(seconds) {
    this.n = Math.ceil(seconds * SR);
    this.L = new Float32Array(this.n);
    this.R = new Float32Array(this.n);
    this.send = new Float32Array(this.n); // reverb send (mono)
  }
  add(i, v, pan = 0, rev = 0) {
    if (i < 0 || i >= this.n) return;
    const l = Math.cos((pan + 1) * Math.PI / 4), r = Math.sin((pan + 1) * Math.PI / 4);
    this.L[i] += v * l; this.R[i] += v * r; this.send[i] += v * rev;
  }
}

// --- enstrümanlar ---
function kick(m, t, g = 1) {
  const s = Math.floor(t * SR), len = Math.floor(0.45 * SR);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const tt = i / SR;
    const f = 42 + 110 * Math.exp(-tt * 28);
    ph += 2 * Math.PI * f / SR;
    const env = Math.exp(-tt * 7.5) * Math.min(1, i / 40);
    m.add(s + i, Math.sin(ph) * env * 0.9 * g, 0, 0.02);
  }
}
function snare(m, t, r, g = 1) {
  const s = Math.floor(t * SR), len = Math.floor(0.3 * SR);
  let lp = 0, ph = 0;
  for (let i = 0; i < len; i++) {
    const tt = i / SR;
    const n = r() * 2 - 1;
    lp += 0.55 * (n - lp);
    const hp = n - lp;
    ph += 2 * Math.PI * 190 / SR;
    const v = hp * Math.exp(-tt * 16) * 0.45 + Math.sin(ph) * Math.exp(-tt * 30) * 0.3;
    m.add(s + i, v * g, 0.05, 0.25);
  }
}
function hat(m, t, r, g = 1, open = false) {
  const s = Math.floor(t * SR), len = Math.floor((open ? 0.25 : 0.06) * SR);
  let p = 0;
  for (let i = 0; i < len; i++) {
    const tt = i / SR;
    const n = r() * 2 - 1;
    const hp = n - p; p = n;
    const v = hp * Math.exp(-tt * (open ? 14 : 70)) * 0.16;
    m.add(s + i, v * g, 0.35, 0.1);
  }
}
function swell(m, t, dur, r, g = 1) { // yumuşak gürültü yükselişi (zil yerine)
  const s = Math.floor(t * SR), len = Math.floor(dur * SR);
  let lp = 0;
  for (let i = 0; i < len; i++) {
    const tt = i / SR;
    lp += 0.3 * ((r() * 2 - 1) - lp);
    const env = Math.min(1, tt / 0.01) * Math.exp(-tt * 2.2);
    m.add(s + i, lp * env * 0.18 * g, -0.3 + 0.6 * r(), 0.5);
  }
}
function bass(m, t, dur, note, g = 1) {
  const s = Math.floor(t * SR), len = Math.floor(dur * SR);
  const f = mtof(note);
  let ph = 0, lp = 0;
  for (let i = 0; i < len; i++) {
    const tt = i / SR;
    ph = (ph + f / SR) % 1;
    const saw = 2 * ph - 1;
    const cut = 0.04 + 0.12 * Math.exp(-tt * 9);
    lp += cut * (saw - lp);
    const env = Math.min(1, i / 120) * Math.min(1, (len - i) / 300);
    m.add(s + i, (lp * 0.6 + Math.sin(2 * Math.PI * ph) * 0.4) * env * 0.42 * g, 0, 0.03);
  }
}
function pad(m, t, dur, notes, g = 1, bright = 0.03) {
  const s = Math.floor(t * SR), len = Math.floor(dur * SR);
  const voices = [];
  notes.forEach((n, k) => { for (const d of [-0.08, 0.07]) voices.push({ f: mtof(n + d), ph: (k * 0.31 + d) % 1, pan: (k % 2 ? 0.4 : -0.4) + d }); });
  const lps = voices.map(() => 0);
  const att = Math.min(1.2, dur * 0.3), rel = Math.min(1.5, dur * 0.4);
  for (let i = 0; i < len; i++) {
    const tt = i / SR;
    const env = Math.min(1, tt / att) * Math.min(1, (dur - tt) / rel);
    const cut = bright * (1 + 0.4 * Math.sin(tt * 0.7));
    for (let v = 0; v < voices.length; v++) {
      const vo = voices[v];
      vo.ph = (vo.ph + vo.f / SR) % 1;
      lps[v] += cut * ((2 * vo.ph - 1) - lps[v]);
      m.add(s + i, lps[v] * env * 0.06 * g, vo.pan, 0.45);
    }
  }
}
function lead(m, t, dur, note, g = 1, pan = 0.15) {
  const s = Math.floor(t * SR), len = Math.floor(dur * SR);
  const f = mtof(note);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const tt = i / SR;
    const vib = 1 + 0.004 * Math.sin(2 * Math.PI * 5.2 * tt) * Math.min(1, tt * 3);
    ph = (ph + f * vib / SR) % 1;
    const tri = 1 - 4 * Math.abs(ph - 0.5);
    const env = Math.min(1, i / 300) * Math.exp(-tt * 1.6) * Math.min(1, (len - i) / 400);
    m.add(s + i, (tri * 0.7 + Math.sin(4 * Math.PI * ph) * 0.15) * env * 0.17 * g, pan, 0.4);
  }
}
function pluck(m, t, note, g = 1, pan = 0) { // Karplus-Strong
  const s = Math.floor(t * SR), f = mtof(note);
  const N = Math.max(2, Math.round(SR / f));
  const r = rng(note * 977 + Math.floor(t * 100));
  const buf = new Float32Array(N).map(() => r() * 2 - 1);
  const len = Math.floor(1.6 * SR);
  let idx = 0;
  for (let i = 0; i < len; i++) {
    const a = buf[idx], b = buf[(idx + 1) % N];
    buf[idx] = 0.497 * (a + b);
    idx = (idx + 1) % N;
    m.add(s + i, a * 0.2 * g * Math.min(1, (len - i) / 2000), pan, 0.3);
  }
}

function reverbAndRender(m, name, revGain = 0.35) {
  const combs = [1557, 1617, 1491, 1422, 1277, 1356].map((d) => ({ d, buf: new Float32Array(d), i: 0, lp: 0 }));
  const aps = [225, 556, 441].map((d) => ({ d, buf: new Float32Array(d), i: 0 }));
  for (let n = 0; n < m.n; n++) {
    const x = m.send[n] * 0.12;
    let y = 0;
    for (const c of combs) {
      const o = c.buf[c.i];
      c.lp = o * 0.7 + c.lp * 0.3;
      c.buf[c.i] = x + c.lp * 0.83;
      c.i = (c.i + 1) % c.d;
      y += o;
    }
    for (const a of aps) {
      const o = a.buf[a.i];
      const v = y + o * 0.5;
      a.buf[a.i] = v;
      a.i = (a.i + 1) % a.d;
      y = o - v * 0.5;
    }
    m.L[n] += y * revGain; m.R[n] += y * revGain * 0.97;
  }
  // tepe normalize + yumuşak kırpma
  let peak = 0;
  for (let n = 0; n < m.n; n++) peak = Math.max(peak, Math.abs(m.L[n]), Math.abs(m.R[n]));
  const k = 0.89 / peak;
  const pcm = Buffer.alloc(m.n * 4);
  for (let n = 0; n < m.n; n++) {
    const fade = Math.min(1, n / (SR * 0.05), (m.n - n) / (SR * 2));
    pcm.writeInt16LE(Math.round(Math.tanh(m.L[n] * k * 1.1) * 32767 * fade * 0.95), n * 4);
    pcm.writeInt16LE(Math.round(Math.tanh(m.R[n] * k * 1.1) * 32767 * fade * 0.95), n * 4 + 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(2, 22);
  head.writeUInt32LE(SR, 24); head.writeUInt32LE(SR * 4, 28); head.writeUInt16LE(4, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
  const wav = `/tmp/demo-wav/${name}.wav`;
  writeFileSync(wav, Buffer.concat([head, pcm]));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-codec:a', 'libmp3lame', '-b:a', '160k', `public/demo/${name}.mp3`]);
}

// tempo haritası: vuruş zamanları
function beatGrid(startT, count, bpmAt) {
  const times = [];
  let t = startT;
  for (let b = 0; b < count; b++) { times.push(t); t += 60 / bpmAt(b); }
  times.push(t);
  return times;
}
const at = (grid, pos) => { // kesirli vuruş konumu -> saniye
  const b = Math.floor(pos), f = pos - b;
  return grid[b] + (grid[b + 1] - grid[b]) * f;
};

// ===================== 1) Gece Gölü =====================
function geceGolu() {
  const r = rng(11);
  const bpm = 88, intro = 16.0;
  const bars = 26;
  const grid = beatGrid(intro, bars * 4, () => bpm);
  const total = grid[grid.length - 1] + 6;
  const m = new Mix(total);
  const chords = [[50, 57, 62, 65], [46, 53, 58, 62], [43, 50, 55, 58], [45, 52, 57, 61]]; // Dm Bb Gm A
  // drum'sız giriş: yalnız pad + pluck
  pad(m, 0, intro + 0.5, chords[0], 1.1, 0.02);
  for (let k = 0; k < 10; k++) pluck(m, 1.5 + k * 1.37, [74, 77, 81, 79, 76][k % 5], 0.7, (k % 2 ? 0.4 : -0.4));
  const sections = [{ t: 0, label: 'giriş' }, { t: intro, label: 'ritim' }];
  for (let bar = 0; bar < bars; bar++) {
    const c = chords[bar % 4];
    const b0 = bar * 4;
    const T = (p) => at(grid, b0 + p);
    pad(m, T(0), T(4) - T(0) + 0.6, c, 1, bar >= 16 ? 0.045 : 0.025);
    bass(m, T(0), 60 / bpm * 1.4, c[0] - 12);
    bass(m, T(2.5), 60 / bpm * 0.9, c[0] - 12, 0.8);
    kick(m, T(0), 1); kick(m, T(2.5), 0.75); // senkoplu
    if (bar % 2 === 1) kick(m, T(3.75), 0.5);
    snare(m, T(1), r, 0.8); snare(m, T(3), r, 0.85);
    for (let h = 0; h < 8; h++) hat(m, T(h / 2), r, h % 2 ? 0.5 : 0.8);
    if (bar >= 8) for (let k = 0; k < 4; k++) pluck(m, T(k + 0.5), c[(k + bar) % 4] + 24, 0.5, k % 2 ? 0.5 : -0.5);
    if (bar >= 16) lead(m, T(0), 60 / bpm * 3.6, c[2] + 12, 0.9);
  }
  sections.push({ t: grid[16 * 4], label: 'melodi' });
  reverbAndRender(m, 'gece-golu', 0.45);
  return { id: 'gece-golu', grid: grid.slice(0, -1), beatsPerBar: 4, firstDownbeat: 0, sections, noDrumsUntil: intro, total };
}

// ===================== 2) Kuzey Rüzgârı =====================
function kuzeyRuzgari() {
  const r = rng(23);
  const bpm = 122;
  const plan = [['giriş', 8], ['tema', 16], ['ara', 8], ['zirve', 16], ['çıkış', 4]];
  const totalBars = plan.reduce((a, p) => a + p[1], 0);
  const grid = beatGrid(0.5, totalBars * 4, () => bpm);
  const total = grid[grid.length - 1] + 5;
  const m = new Mix(total);
  const progA = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // Am F C G
  const progB = [[59, 62, 66], [55, 59, 62], [50, 54, 57], [57, 61, 64]]; // Bm G D A (ton değişimi)
  let bar = 0;
  const sections = [];
  for (const [label, n] of plan) {
    sections.push({ t: at(grid, bar * 4), label });
    for (let k = 0; k < n; k++, bar++) {
      const T = (p) => at(grid, bar * 4 + p);
      const prog = label === 'zirve' || label === 'çıkış' ? progB : progA;
      const c = prog[bar % 4];
      const beatDur = 60 / bpm;
      if (label === 'giriş') {
        pad(m, T(0), beatDur * 4.3, c, 0.8, 0.02);
        for (let h = 0; h < 4; h++) hat(m, T(h + 0.5), r, 0.6);
        if (k >= 4) kick(m, T(0), 0.6);
      } else if (label === 'tema' || label === 'zirve') {
        const big = label === 'zirve';
        pad(m, T(0), beatDur * 4.3, c, big ? 1.1 : 0.8, big ? 0.05 : 0.03);
        for (let b = 0; b < 4; b++) kick(m, T(b), 1);
        snare(m, T(1), r); snare(m, T(3), r);
        for (let h = 0; h < 8; h++) hat(m, T(h / 2), r, h % 2 ? 0.9 : 0.5, h % 2 === 1 && big);
        for (let e = 0; e < 8; e++) bass(m, T(e / 2), beatDur * 0.42, c[0] - 24 + (e % 4 === 3 ? 7 : 0), 0.9);
        const arp = [0, 1, 2, 1, 2, 0, 2, 1];
        for (let e = 0; e < 8; e++) lead(m, T(e / 2), beatDur * 0.45, c[arp[e]] + (big ? 24 : 12), big ? 0.8 : 0.6, e % 2 ? 0.4 : -0.2);
        if (k === 0) swell(m, T(0), 2.5, r, 1.2);
      } else if (label === 'ara') {
        pad(m, T(0), beatDur * 4.3, c, 1.2, 0.015);
        lead(m, T(0), beatDur * 3.8, c[2] + 12, 0.9);
        if (k >= 6) for (let s = 0; s < 8; s++) snare(m, T(s / 2), r, 0.2 + 0.1 * s);
      } else {
        pad(m, T(0), beatDur * 6, c, 0.9, 0.02);
        kick(m, T(0), 0.7);
      }
    }
  }
  reverbAndRender(m, 'kuzey-ruzgari', 0.35);
  return { id: 'kuzey-ruzgari', grid: grid.slice(0, -1), beatsPerBar: 4, firstDownbeat: 0, sections, total };
}

// ===================== 3) Toz Bulutu =====================
function tozBulutu() {
  const r = rng(37);
  const bars = 40;
  const startBpm = 96, endBpm = 116;
  const nBeats = bars * 4;
  const grid = beatGrid(0.4, nBeats, (b) => startBpm + (endBpm - startBpm) * Math.min(1, b / (nBeats * 0.85)));
  const total = grid[grid.length - 1] + 5;
  const m = new Mix(total);
  const chords = [[52, 55, 59, 62], [48, 52, 55, 59], [55, 59, 62, 66], [50, 54, 57, 60]]; // Em7 Cmaj7 G D7
  const sections = [{ t: grid[0], label: 'başlangıç' }, { t: grid[16 * 4], label: 'yükseliş' }, { t: grid[28 * 4], label: 'akış' }];
  for (let bar = 0; bar < bars; bar++) {
    const T = (p) => at(grid, bar * 4 + p);
    const c = chords[bar % 4];
    const len = T(4) - T(0);
    pad(m, T(0), len + 0.5, c, 0.7, bar >= 28 ? 0.04 : 0.025);
    // ölçü başı vurgusu: kick + swell
    kick(m, T(0), 1.05);
    swell(m, T(0), 1.2, r, bar % 4 === 0 ? 1 : 0.5);
    // senkoplu (off-beat) kick deseni
    kick(m, T(1.5), 0.55); kick(m, T(2.75), 0.5);
    if (bar >= 16) snare(m, T(2), r, 0.75);
    for (let s = 0; s < 4; s++) hat(m, T(s + 0.5), r, 0.75);
    if (bar >= 8) for (let s = 0; s < 16; s++) if ((s * 7) % 5 < 2) hat(m, T(s / 4), r, 0.3);
    bass(m, T(0), len * 0.3, c[0] - 12);
    bass(m, T(1.5), len * 0.15, c[0] - 12, 0.7);
    bass(m, T(3), len * 0.2, c[1] - 12, 0.8);
    if (bar >= 16) for (let k = 0; k < 6; k++) pluck(m, T(k * 0.75), c[k % 4] + 24, 0.45, k % 2 ? 0.6 : -0.6);
    if (bar >= 28) lead(m, T(0.5), len * 0.6, c[3] + 12, 0.8, -0.2);
  }
  reverbAndRender(m, 'toz-bulutu', 0.4);
  return { id: 'toz-bulutu', grid: grid.slice(0, -1), beatsPerBar: 4, firstDownbeat: 0, sections, total, bpm: [startBpm, endBpm] };
}

for (const make of [geceGolu, kuzeyRuzgari, tozBulutu]) {
  const info = make();
  const beats = info.grid.map((t) => +t.toFixed(4));
  const downbeats = beats.filter((_, i) => i % info.beatsPerBar === 0);
  writeFileSync(`test/truth/${info.id}.json`, JSON.stringify({ ...info, grid: undefined, beats, downbeats }, null, 1));
  console.log(info.id, 'süre', info.total.toFixed(1), 'vuruş', beats.length);
}
