// Analiz doğruluk testi: npx tsx test/eval.ts
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { analyze } from '../src/analysis/analyze';
import { RealFFT } from '../src/analysis/fft';
import type { EnergyStage, RhythmStage, StructureStage } from '../src/analysis/types';

const SR = 22050;

function decode(path: string, extra: string[] = []): Float32Array {
  const buf = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', path, ...extra, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice();
}

function fmeasure(est: ArrayLike<number>, ref: ArrayLike<number>, tol: number) {
  const used = new Uint8Array(ref.length);
  let hit = 0;
  const errs: number[] = [];
  for (let i = 0; i < est.length; i++) {
    let bj = -1, bd = tol;
    for (let j = 0; j < ref.length; j++) {
      const d = Math.abs(est[i] - ref[j]);
      if (!used[j] && d <= bd) { bd = d; bj = j; }
    }
    if (bj >= 0) { used[bj] = 1; hit++; errs.push(est[i] - ref[bj]); }
  }
  const p = est.length ? hit / est.length : 0, r = ref.length ? hit / ref.length : 0;
  errs.sort((a, b) => a - b);
  return { f: p + r ? (2 * p * r) / (p + r) : 0, p, r, medErrMs: errs.length ? errs[errs.length >> 1] * 1000 : NaN };
}

function run(samples: Float32Array) {
  let energy!: EnergyStage, rhythm!: RhythmStage, structure!: StructureStage;
  const t0 = performance.now();
  const times: Record<string, number> = {};
  analyze(samples, SR, {
    progress: () => {},
    energy: (e) => { energy = e; times.energy = performance.now() - t0; },
    rhythm: (r) => { rhythm = r; times.rhythm = performance.now() - t0; },
    structure: (s) => { structure = s; times.structure = performance.now() - t0; },
  });
  return { energy, rhythm, structure, times };
}

// --- FFT doğruluğu ---
{
  const n = 1024, fft = new RealFFT(n);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * 37 * i) / n) + 0.5 * Math.cos((2 * Math.PI * 100 * i) / n);
  const mag = new Float32Array(n / 2 + 1);
  fft.magnitude(x, mag);
  const ok = Math.abs(mag[37] - n / 2) < 1e-6 && Math.abs(mag[100] - n / 4) < 1e-6 && mag[50] < 1e-6;
  console.log('FFT', ok ? 'DOĞRU' : 'HATALI', mag[37].toFixed(3), mag[100].toFixed(3));
  if (!ok) process.exit(1);
}

const results: Record<string, unknown> = {};
const failures: string[] = [];
const expect = (ok: boolean, msg: string) => { if (!ok) failures.push(msg); };
for (const id of ['gece-golu', 'kuzey-ruzgari', 'toz-bulutu']) {
  const truth = JSON.parse(readFileSync(`test/truth/${id}.json`, 'utf8'));
  const x = decode(`public/demo/${id}.mp3`);
  const { energy, rhythm, structure, times } = run(x);
  const beatF = fmeasure(rhythm.beats, truth.beats, 0.07);
  // yalnız güvenilir vuruşlar
  const conf = Array.from(rhythm.beats).filter((_, i) => rhythm.beatConfidence[i] >= 0.5);
  const confF = fmeasure(conf, truth.beats, 0.07);
  const dbF = fmeasure(rhythm.downbeats, truth.downbeats, 0.07);
  const secTruth = truth.sections.map((s: { t: number }) => s.t).filter((t: number) => t > 1);
  const secEst = structure.sections.map((s) => s.start).filter((t) => t > 1);
  const secF = fmeasure(secEst, secTruth, 2.0);
  // giriş bölgesinde (davul yok) güven
  let introConf = NaN;
  if (truth.noDrumsUntil) {
    const ib = Array.from(rhythm.beats).map((t, i) => [t, rhythm.beatConfidence[i]]).filter(([t]) => t < truth.noDrumsUntil - 1);
    introConf = ib.length ? ib.reduce((a, b) => a + b[1], 0) / ib.length : 0;
  }
  const r = {
    bpm: rhythm.bpm.toFixed(1),
    tempoCurve: [rhythm.tempoCurve[5], rhythm.tempoCurve[Math.floor(rhythm.tempoCurve.length / 2)], rhythm.tempoCurve[rhythm.tempoCurve.length - 8]].map((v) => v.toFixed(1)).join('→'),
    beatF: beatF.f.toFixed(3), beatErrMs: beatF.medErrMs.toFixed(1),
    confidentBeatF_precision: confF.p.toFixed(3),
    conf: rhythm.confidence.toFixed(2), octaveAmb: rhythm.octaveAmbiguity.toFixed(2),
    downbeatF: dbF.f.toFixed(3), meter: rhythm.meter, dbConf: rhythm.downbeatConfidence.toFixed(2),
    sectionsEst: secEst.map((t) => t.toFixed(1)).join(','), sectionsTruth: secTruth.map((t: number) => t.toFixed(1)).join(','),
    sectionF: secF.f.toFixed(2), palettes: structure.sections.map((s) => s.palette).join(''),
    introConf: isNaN(introConf) ? '-' : introConf.toFixed(2),
    onsets: energy.onsets.length, silences: energy.silences.length / 2,
    ms: Object.entries(times).map(([k, v]) => `${k}:${v.toFixed(0)}`).join(' '),
  };
  results[id] = r;
  expect(beatF.f >= 0.9, `${id}: vuruş F ${beatF.f.toFixed(3)} < 0.90`);
  expect(confF.p >= 0.95, `${id}: güvenilir vuruş isabeti ${confF.p.toFixed(3)} < 0.95`);
  expect(dbF.f >= 0.9, `${id}: ölçü başı F ${dbF.f.toFixed(3)} < 0.90`);
  console.log(id, r);
}

// --- dayanıklılık: gürültü + ses seviyesi düşürme + başa sessizlik ---
{
  const truth = JSON.parse(readFileSync('test/truth/kuzey-ruzgari.json', 'utf8'));
  const x = decode('public/demo/kuzey-ruzgari.mp3', ['-af', 'adelay=3000|3000,volume=0.25']);
  let seed = 5;
  for (let i = 0; i < x.length; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; x[i] += ((seed / 4294967296) - 0.5) * 0.01; }
  const { rhythm, energy } = run(x);
  const f = fmeasure(rhythm.beats, truth.beats.map((t: number) => t + 3), 0.07);
  expect(f.f >= 0.9, `gürültü testi F ${f.f.toFixed(3)} < 0.90`);
  console.log('gürültü+3sn gecikme', { beatF: f.f.toFixed(3), bpm: rhythm.bpm.toFixed(1), silencesAtStart: energy.silences.slice(0, 2) });
}
// --- ritimsiz: yalnız pad (beklenen: düşük güven) ---
{
  const x = decode('public/demo/gece-golu.mp3', ['-t', '15']);
  const { rhythm } = run(x);
  console.log('ritimsiz giriş (0-15 sn)', { conf: rhythm.confidence.toFixed(2), downbeats: rhythm.downbeats.length });
}
// --- tempo değişimi: atempo ile hızlandırılmış parça ---
{
  const truth = JSON.parse(readFileSync('test/truth/gece-golu.json', 'utf8'));
  const x = decode('public/demo/gece-golu.mp3', ['-af', 'atempo=1.25']);
  const { rhythm } = run(x);
  const f = fmeasure(rhythm.beats, truth.beats.map((t: number) => t / 1.25), 0.07);
  expect(f.f >= 0.9 && Math.abs(rhythm.bpm - 110) < 2, `%125 hız testi başarısız`);
  console.log('%125 hız (88→110 BPM)', { bpm: rhythm.bpm.toFixed(1), beatF: f.f.toFixed(3) });
}
// --- uzun dosya: 30 dk sentetik (bellek/süre) ---
{
  const one = decode('public/demo/kuzey-ruzgari.mp3');
  const n = SR * 60 * 30;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i += one.length) x.set(one.subarray(0, Math.min(one.length, n - i)), i);
  const m0 = process.memoryUsage().heapUsed;
  const { times, rhythm } = run(x);
  console.log('30 dk dosya', { ms: times, beats: rhythm.beats.length, heapMB: ((process.memoryUsage().heapUsed - m0) / 1e6).toFixed(0) });
}
// --- gerçekten ritimsiz: rastgele zamanlı ataklar + uğultu (beklenen: düşük güven) ---
{
  const n = SR * 40;
  const x = new Float32Array(n);
  let seed = 99;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < n; i++) x[i] = 0.05 * Math.sin(2 * Math.PI * 110 * i / SR) * (0.6 + 0.4 * Math.sin(i / SR * 0.3));
  let t = 0.3;
  while (t < 39) {
    const s = Math.floor(t * SR), f = 200 + rnd() * 800;
    for (let i = 0; i < SR * 0.4 && s + i < n; i++) x[s + i] += 0.4 * Math.sin(2 * Math.PI * f * i / SR) * Math.exp(-i / SR * 8);
    t += -Math.log(1 - rnd()) * 0.7; // Poisson aralıkları
  }
  const { rhythm } = run(x);
  expect(rhythm.confidence < 0.25 && rhythm.downbeats.length === 0, `rastgele ataklarda güven ${rhythm.confidence.toFixed(2)} ≥ 0.25`);
  console.log('rastgele ataklar', { conf: rhythm.confidence.toFixed(2), downbeats: rhythm.downbeats.length, bpm: rhythm.bpm.toFixed(0) });
}

if (failures.length) { console.error('BAŞARISIZ:\n- ' + failures.join('\n- ')); process.exit(1); }
console.log('Tüm analiz eşikleri geçti.');
