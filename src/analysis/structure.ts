import { SEG_SEC, type FrameFeatures } from './features';
import type { Section } from './types';

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Öz-benzerlik yeniliği (Foote dama tahtası çekirdeği) ile bölüm sınırları.
 * Tam benzerlik matrisi tutulmaz; çekirdek penceresi içinde anlık hesaplanır.
 */
export function analyzeSections(
  f: FrameFeatures,
  duration: number,
  beats: Float32Array | undefined,
  downbeats: Float32Array | undefined,
): Section[] {
  const N = f.segFrames, D = f.segDim;
  if (N < 24) return [{ start: 0, end: duration, energy: 0.5, confidence: 1, palette: 0 }];
  // öznitelikleri hazırla: kroma L2 normalize, tını z-skor
  const feat = new Float32Array(N * D);
  const mean = new Float64Array(D), sd = new Float64Array(D);
  for (let s = 0; s < N; s++) for (let d = 12; d < D; d++) mean[d] += f.seg[s * D + d] / N;
  for (let s = 0; s < N; s++) for (let d = 12; d < D; d++) sd[d] += (f.seg[s * D + d] - mean[d]) ** 2 / N;
  for (let d = 12; d < D; d++) sd[d] = Math.sqrt(sd[d]) || 1;
  for (let s = 0; s < N; s++) {
    let nrm = 0;
    for (let d = 0; d < 12; d++) nrm += f.seg[s * D + d] ** 2;
    nrm = Math.sqrt(nrm) || 1;
    for (let d = 0; d < 12; d++) feat[s * D + d] = f.seg[s * D + d] / nrm;
    for (let d = 12; d < D; d++) feat[s * D + d] = ((f.seg[s * D + d] - mean[d]) / sd[d]) / Math.sqrt(12);
  }
  // zamansal yumuşatma ±2 segment
  const sm = new Float32Array(N * D);
  for (let s = 0; s < N; s++) {
    let cnt = 0;
    for (let k = Math.max(0, s - 2); k <= Math.min(N - 1, s + 2); k++) {
      cnt++;
      for (let d = 0; d < D; d++) sm[s * D + d] += feat[k * D + d];
    }
    let nrm = 0;
    for (let d = 0; d < D; d++) { sm[s * D + d] /= cnt; nrm += sm[s * D + d] ** 2; }
    nrm = Math.sqrt(nrm) || 1;
    for (let d = 0; d < D; d++) sm[s * D + d] /= nrm;
  }
  const sim = (a: number, b: number) => {
    let v = 0;
    for (let d = 0; d < D; d++) v += sm[a * D + d] * sm[b * D + d];
    return v;
  };
  const K = Math.round(8 / SEG_SEC);
  const g = new Float64Array(2 * K);
  for (let i = 0; i < 2 * K; i++) { const x = (i - K + 0.5) / K; g[i] = Math.exp(-4 * x * x); }
  const nov = new Float64Array(N);
  for (let t = K; t < N - K; t++) {
    let acc = 0;
    for (let a = -K; a < K; a++) {
      for (let b = -K; b < K; b++) {
        const sign = (a < 0) === (b < 0) ? 1 : -1;
        acc += sign * g[a + K] * g[b + K] * sim(t + a, t + b);
      }
    }
    nov[t] = Math.max(0, acc);
  }
  let mx = 0, mu = 0;
  for (const v of nov) { mx = Math.max(mx, v); mu += v / N; }
  let sdv = 0;
  for (const v of nov) sdv += (v - mu) ** 2 / N;
  sdv = Math.sqrt(sdv);
  const thr = mu + 0.6 * sdv;
  const minGap = Math.round(8 / SEG_SEC);
  const cand: { s: number; v: number }[] = [];
  for (let t = K; t < N - K; t++) {
    if (nov[t] < thr) continue;
    let isMax = true;
    for (let k = Math.max(0, t - minGap); k <= Math.min(N - 1, t + minGap); k++) if (nov[k] > nov[t]) { isMax = false; break; }
    if (isMax) cand.push({ s: t, v: nov[t] });
  }
  // sınır zamanları ve ölçü başına hizalama
  const snap = (t: number) => {
    const grid = downbeats && downbeats.length ? downbeats : beats;
    const tol = downbeats && downbeats.length ? 2.0 : 0.6;
    if (!grid || !grid.length) return t;
    let lo = 0, hi = grid.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (grid[m] < t) lo = m + 1; else hi = m; }
    let best = grid[lo];
    if (lo > 0 && Math.abs(grid[lo - 1] - t) < Math.abs(best - t)) best = grid[lo - 1];
    return Math.abs(best - t) <= tol ? best : t;
  };
  const bounds = [0];
  const confs = [1];
  for (const c of cand) {
    const t = snap(c.s * SEG_SEC);
    if (t - bounds[bounds.length - 1] < 6 || duration - t < 4) continue;
    bounds.push(t);
    confs.push(clamp01((c.v - mu) / ((mx - mu) || 1)));
  }
  // bölüm enerjisi ve palet benzerliği
  const secs: Section[] = [];
  const means: Float64Array[] = [];
  const rmsLin = (a: number, b: number) => {
    const fa = Math.max(0, Math.floor(a * f.fps)), fb = Math.min(f.frames, Math.max(fa + 1, Math.floor(b * f.fps)));
    let acc = 0;
    for (let i = fa; i < fb; i++) acc += Math.pow(10, f.rmsDb[i] / 10);
    return Math.sqrt(acc / (fb - fa));
  };
  let maxE = 1e-9;
  for (let i = 0; i < bounds.length; i++) {
    const start = bounds[i], end = i + 1 < bounds.length ? bounds[i + 1] : duration;
    const e = rmsLin(start, end);
    maxE = Math.max(maxE, e);
    const m = new Float64Array(D);
    const sa = Math.floor(start / SEG_SEC), sb = Math.min(N, Math.max(sa + 1, Math.floor(end / SEG_SEC)));
    for (let s = sa; s < sb; s++) for (let d = 0; d < D; d++) m[d] += feat[s * D + d];
    let nrm = 0;
    for (let d = 0; d < D; d++) nrm += m[d] * m[d];
    nrm = Math.sqrt(nrm) || 1;
    for (let d = 0; d < D; d++) m[d] /= nrm;
    let palette = -1;
    for (let j = 0; j < means.length; j++) {
      let dot = 0;
      for (let d = 0; d < D; d++) dot += m[d] * means[j][d];
      if (dot > 0.93) { palette = secs[j].palette; break; }
    }
    if (palette < 0) palette = new Set(secs.map((s) => s.palette)).size;
    means.push(m);
    secs.push({ start, end, energy: e, confidence: confs[i], palette });
  }
  for (const s of secs) s.energy = clamp01(s.energy / maxE);
  return secs;
}
