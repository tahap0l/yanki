import { CURVE_FPS, type EnergyStage, type RhythmStage, type StructureStage } from './types';
import { extractFeatures, movingAverage, normalizeOnset, percentile, resampleCurve, type FrameFeatures } from './features';
import { analyzeRhythm } from './rhythm';
import { analyzeSections } from './structure';

export interface AnalyzeCallbacks {
  progress(stage: string, p: number): void;
  energy(e: EnergyStage): void;
  rhythm(r: RhythmStage): void;
  structure(s: StructureStage): void;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function dbCurve(lin: Float32Array): Float32Array {
  const out = new Float32Array(lin.length);
  for (let i = 0; i < lin.length; i++) out[i] = 10 * Math.log10(lin[i] + 1e-12);
  return out;
}

/** Parça içi yüzdeliklere göre 0..1 eşleme (dB alanında). */
function normDb(db: Float32Array, lo = 0.08, hi = 0.995): Float32Array {
  const a = percentile(db, lo), b = percentile(db, hi);
  const out = new Float32Array(db.length);
  const span = Math.max(6, b - a);
  for (let i = 0; i < db.length; i++) out[i] = clamp01((db[i] - a) / span);
  return out;
}

export function energyStage(f: FrameFeatures, duration: number): EnergyStage {
  const fps = f.fps, off = f.timeOffset;
  const r = (x: Float32Array) => resampleCurve(x, fps, CURVE_FPS, off, duration);
  const oN = normalizeOnset(f.onset, fps);
  // ataklar: tepe seçimi
  const avg = movingAverage(oN, Math.round(fps * 0.1));
  const ts: number[] = [], ss: number[] = [];
  let last = -1e9;
  for (let t = 3; t < oN.length - 3; t++) {
    const v = oN[t];
    if (v < 0.2 || v < avg[t] + 0.12) continue;
    let isMax = true;
    for (let k = t - 3; k <= t + 3; k++) if (oN[k] > v) { isMax = false; break; }
    if (!isMax || t - last < Math.round(fps * 0.05)) continue;
    ts.push(t / fps + off); ss.push(clamp01(v));
    last = t;
  }
  // sessizlikler
  let med = percentile(f.rmsDb, 0.5);
  const thr = Math.min(-50, Math.max(-62, med - 28));
  const sil: number[] = [];
  let s0 = -1;
  const minLen = Math.round(0.4 * fps);
  for (let t = 0; t <= f.frames; t++) {
    const quiet = t < f.frames && f.rmsDb[t] < thr;
    if (quiet && s0 < 0) s0 = t;
    if (!quiet && s0 >= 0) {
      if (t - s0 >= minLen) sil.push(s0 / fps + off, t / fps + off);
      s0 = -1;
    }
  }
  const cent = new Float32Array(f.frames);
  for (let i = 0; i < f.frames; i++) cent[i] = f.centroid[i] > 0 ? clamp01(Math.log2(f.centroid[i] / 200) / Math.log2(8000 / 200)) : 0;
  med = 0;
  return {
    duration,
    fps: CURVE_FPS,
    bass: r(normDb(dbCurve(f.bass))),
    mid: r(normDb(dbCurve(f.mid))),
    treble: r(normDb(dbCurve(f.treble))),
    rms: r(normDb(f.rmsDb)),
    centroid: r(cent),
    onset: r(Float32Array.from(oN, (v) => Math.min(1, v))),
    onsets: Float32Array.from(ts),
    onsetStrength: Float32Array.from(ss),
    silences: Float32Array.from(sil),
  };
}

/** Tam analiz: her aşama hazır olduğunda geri çağrılır. */
export function analyze(samples: Float32Array, sampleRate: number, cb: AnalyzeCallbacks): void {
  const duration = samples.length / sampleRate;
  const f = extractFeatures(samples, sampleRate, (p) => cb.progress('spektrum', p));
  cb.energy(energyStage(f, duration));
  cb.progress('ritim', 0);
  const rhythm = analyzeRhythm(f);
  cb.rhythm(rhythm);
  cb.progress('bölümler', 0);
  const sections = analyzeSections(f, duration, rhythm.beats, rhythm.downbeats);
  cb.structure({ sections });
}
