// Canlı vuruş izleyici testi: AnalyserNode'u taklit eden düzensiz karelerle
//   npx tsx test/live.ts
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { RealFFT } from '../src/analysis/fft';
import { LiveBeatTracker } from '../src/live/LiveBeatTracker';

const SR = 48000, N = 2048;
function decode(path: string, extra: string[] = []): Float32Array {
  const b = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', path, ...extra, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4).slice();
}
const fft = new RealFFT(N);
const win = new Float64Array(N);
for (let i = 0; i < N; i++) win[i] = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / N) + 0.08 * Math.cos(4 * Math.PI * i / N); // Blackman (AnalyserNode)
const buf = new Float64Array(N), mag = new Float32Array(N / 2 + 1), db = new Float32Array(N / 2);

function run(x: Float32Array, seed = 1, gain = 1, noise = 0) {
  const tr = new LiveBeatTracker();
  let s = seed;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const beats: number[] = [], confs: number[] = [];
  let t = 0.05;
  const dur = x.length / SR;
  while (t < dur) {
    const end = Math.floor(t * SR);
    let sq = 0;
    for (let i = 0; i < N; i++) {
      const v = (x[end - N + i] || 0) * gain + (noise ? (rnd() - 0.5) * noise : 0);
      sq += v * v; buf[i] = v * win[i];
    }
    fft.magnitude(buf, mag);
    for (let k = 0; k < N / 2; k++) db[k] = 20 * Math.log10(mag[k] / N + 1e-12);
    const ev = tr.push(t, db, SR, 10 * Math.log10(sq / N + 1e-12));
    for (const b of ev.beats) { beats.push(b.t); confs.push(tr.state.confidence); }
    // rAF: ~60 Hz, titreşimli, ara sıra atlanan kare
    t += (1 / 60) * (rnd() < 0.03 ? 2 : 1) + (rnd() - 0.5) * 0.004;
  }
  return { beats, confs, tr };
}

function f(est: number[], ref: number[], tol = 0.07) {
  const used = new Uint8Array(ref.length); let hit = 0; const errs: number[] = [];
  for (const e of est) { let bj = -1, bd = tol; ref.forEach((r, j) => { const d = Math.abs(e - r); if (!used[j] && d <= bd) { bd = d; bj = j; } }); if (bj >= 0) { used[bj] = 1; hit++; errs.push(e - ref[bj]); } }
  const p = est.length ? hit / est.length : 0, r = ref.length ? hit / ref.length : 0;
  errs.sort((a, b) => a - b);
  return { f: p + r ? 2 * p * r / (p + r) : 0, med: errs.length ? Math.round(errs[errs.length >> 1] * 1000) : NaN };
}

const fails: string[] = [];
for (const id of ['gece-golu', 'kuzey-ruzgari', 'toz-bulutu']) {
  const truth = JSON.parse(readFileSync(`test/truth/${id}.json`, 'utf8'));
  const x = decode(`public/demo/${id}.mp3`);
  const { beats, confs, tr } = run(x);
  const from = (truth.noDrumsUntil || truth.beats[0]) + 8; // ısınma
  const to = truth.beats[truth.beats.length - 1];
  const sel = beats.map((b, i) => [b, confs[i]] as const).filter(([b, c]) => b >= from && b <= to && c >= 0.3).map(([b]) => b);
  const ref = truth.beats.filter((b: number) => b >= from && b <= to);
  const all = beats.filter((b) => b >= from && b <= to);
  const r = f(sel, ref), ra = f(all, ref);
  if (process.env.DBG) { const errs = all.map((b) => { let m = 9; for (const q of ref) if (Math.abs(b - q) < Math.abs(m)) m = b - q; return Math.round(m * 1000); }); console.log('say', all.length, ref.length, 'hatalar', errs.filter((_, i) => i % 3 == 0).join(' ')); }
  const confMid = confs[Math.floor(confs.length * 0.6)];
  console.log(id, { güvenliF: r.f.toFixed(3), tümF: ra.f.toFixed(3), ortancaMs: r.med, bpm: tr.state.bpm.toFixed(1), güven: confMid?.toFixed(2), bölümler: tr.state.sectionId });
  if (ra.f < 0.85) fails.push(`${id}: canlı vuruş F ${ra.f.toFixed(3)}`);
}
// ritimsiz: güven düşük kalmalı
{
  const n = SR * 30, x = new Float32Array(n); let s = 7;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  let t = 0.3;
  while (t < 29) { const st = Math.floor(t * SR), fr = 200 + rnd() * 800; for (let i = 0; i < SR * 0.4 && st + i < n; i++) x[st + i] += 0.4 * Math.sin(2 * Math.PI * fr * i / SR) * Math.exp(-i / SR * 8); t += -Math.log(1 - rnd()) * 0.7; }
  const { confs } = run(x);
  const tail = confs.slice(Math.floor(confs.length / 2));
  const mx = tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : 0;
  console.log('ritimsiz ortalama güven', mx.toFixed(2));
  if (mx > 0.3) fails.push('ritimsiz sinyalde güven yüksek');
}
// mikrofon koşulu: düşük seviye + gürültü
{
  const truth = JSON.parse(readFileSync('test/truth/kuzey-ruzgari.json', 'utf8'));
  const x = decode('public/demo/kuzey-ruzgari.mp3');
  const { beats } = run(x, 3, 0.15, 0.01);
  const ref = truth.beats.filter((b: number) => b > 10), est = beats.filter((b) => b > 10);
  const r = f(est, ref);
  console.log('düşük seviye + gürültü', { F: r.f.toFixed(3), ortancaMs: r.med });
  if (r.f < 0.8) fails.push('gürültülü mikrofonda F düşük');
}
if (fails.length) { console.error('BAŞARISIZ:', fails); process.exit(1); }
console.log('Canlı izleyici eşikleri geçti.');
