declare const process: { env?: Record<string, string | undefined> } | undefined;
import type { FrameFeatures } from './features';
import { movingAverage, normalizeOnset, percentile } from './features';
import type { RhythmStage } from './types';

const BPM_MIN = 50;
const BPM_MAX = 220;
const STATES_PER_OCTAVE = 48;
const WIN_SEC = 8;
const HOP_SEC = 1;
const PRIOR_CENTER = 115;
const PRIOR_OCTAVES = 0.85;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function stdDev(x: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < x.length; i++) m += x[i];
  m /= x.length || 1;
  let v = 0;
  for (let i = 0; i < x.length; i++) v += (x[i] - m) ** 2;
  return Math.sqrt(v / (x.length || 1));
}

export interface TempoTrack {
  /** pencere merkezleri için bpm */
  bpm: Float32Array;
  /** pencere başına periyodiklik gücü 0..1 */
  strength: Float32Array;
  /** pencere başına yarım/çift tempo belirsizliği 0..1 */
  ambiguity: Float32Array;
  /** pencere başına ölçü periyodu gücü 0..1 */
  barStrength: Float32Array;
  hopFrames: number;
  winFrames: number;
}

/** Yerel otokorelasyon tempogramı + Viterbi ile yumuşak (değişken) tempo yolu. */
export function trackTempo(o: Float32Array, fps: number): TempoTrack {
  const W = Math.round(WIN_SEC * fps), H = Math.round(HOP_SEC * fps);
  const n = o.length;
  const nStates = Math.floor(STATES_PER_OCTAVE * Math.log2(BPM_MAX / BPM_MIN)) + 1;
  const bpmOf = new Float64Array(nStates);
  for (let i = 0; i < nStates; i++) bpmOf[i] = BPM_MIN * Math.pow(2, i / STATES_PER_OCTAVE);
  // ölçü düzeyi periyodu aramak için ~5 sn'ye kadar gecikme
  const maxLag = Math.min(W - 2, Math.ceil(5 * fps));
  const barMin = Math.round(1.5 * fps), barMax = Math.min(maxLag - 1, Math.round(4.8 * fps));
  const nWin = Math.max(1, Math.ceil(n / H));
  const win = new Float64Array(W);
  for (let i = 0; i < W; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (W - 1));
  const seg = new Float64Array(W);
  const r = new Float64Array(maxLag + 1);
  const sal = new Float32Array(nWin * nStates);
  const raw = new Float32Array(nWin * nStates);
  const rAt = (L: number) => {
    if (L >= maxLag) return 0;
    const a = Math.floor(L), f = L - a;
    return r[a] * (1 - f) + r[a + 1] * f;
  };
  const prior = new Float64Array(nStates);
  for (let i = 0; i < nStates; i++) prior[i] = Math.exp(-0.5 * (Math.log2(bpmOf[i] / PRIOR_CENTER) / PRIOR_OCTAVES) ** 2);
  const strengthW = new Float32Array(nWin);
  const barStrW = new Float32Array(nWin);

  for (let w = 0; w < nWin; w++) {
    const c = w * H;
    const s0 = c - (W >> 1);
    let mean = 0;
    for (let i = 0; i < W; i++) { const j = s0 + i; seg[i] = j >= 0 && j < n ? o[j] : 0; mean += seg[i]; }
    mean /= W;
    for (let i = 0; i < W; i++) seg[i] = (seg[i] - mean) * win[i];
    for (let L = 0; L <= maxLag; L++) {
      let acc = 0;
      for (let i = L; i < W; i++) acc += seg[i] * seg[i - L];
      r[L] = acc / (W - L);
    }
    const r0 = r[0] || 1;
    for (let L = 0; L <= maxLag; L++) r[L] = Math.max(0, r[L] / r0);
    // ölçü periyodu: uzun gecikmelerde en güçlü tepe
    let barLag = 0, barStr = 0;
    for (let L = barMin; L <= barMax; L++) {
      if (r[L] > barStr && r[L] >= r[L - 1] && r[L] >= r[L + 1]) { barStr = r[L]; barLag = L; }
    }
    const barW = clamp01((barStr - 0.25) / 0.3);
    barStrW[w] = barStr;
    let best = 0;
    for (let s = 0; s < nStates; s++) {
      const L = (60 * fps) / bpmOf[s];
      // metrik tarak: vuruş + ölçü/yarım ölçü düzeyindeki tekrarlar
      let v = rAt(L) + 0.5 * rAt(2 * L) + 0.25 * rAt(4 * L) + 0.2 * rAt(L / 2);
      if (barW > 0) {
        // senkop tuzağı: ölçü periyodunu tam bölmeyen periyotları zayıflat
        const k = barLag / L;
        let dev = 1;
        for (const q of [2, 3, 4, 6, 8]) dev = Math.min(dev, Math.abs(k - q) / q);
        const consistency = Math.exp(-((dev / 0.03) ** 2));
        v *= 1 - 0.8 * barW * (1 - consistency);
      }
      raw[w * nStates + s] = v;
      sal[w * nStates + s] = v * prior[s];
      if (rAt(L) > best) best = rAt(L);
    }
    strengthW[w] = best;
  }

  // Viterbi: tempo yavaş değişebilir, ani sıçramaya ceza
  const sigma = 1.6; // durum/saniye
  const maxJump = 8;
  const emis = new Float32Array(nWin * nStates);
  for (let w = 0; w < nWin; w++) {
    let mx = 1e-9;
    for (let s = 0; s < nStates; s++) mx = Math.max(mx, sal[w * nStates + s]);
    for (let s = 0; s < nStates; s++) emis[w * nStates + s] = Math.log(sal[w * nStates + s] / mx + 0.02);
  }
  const score = new Float64Array(nStates), next = new Float64Array(nStates);
  const back = new Int16Array(nWin * nStates);
  for (let s = 0; s < nStates; s++) score[s] = emis[s];
  for (let w = 1; w < nWin; w++) {
    for (let s = 0; s < nStates; s++) {
      let bv = -Infinity, bi = s;
      const a = Math.max(0, s - maxJump), b = Math.min(nStates - 1, s + maxJump);
      for (let p = a; p <= b; p++) {
        const v = score[p] - 0.5 * ((s - p) / sigma) ** 2;
        if (v > bv) { bv = v; bi = p; }
      }
      next[s] = bv + emis[w * nStates + s];
      back[w * nStates + s] = bi;
    }
    score.set(next);
  }
  let st = 0;
  for (let s = 1; s < nStates; s++) if (score[s] > score[st]) st = s;
  const path = new Int16Array(nWin);
  for (let w = nWin - 1; w >= 0; w--) { path[w] = st; st = back[w * nStates + st]; }

  const bpm = new Float32Array(nWin), ambiguity = new Float32Array(nWin);
  for (let w = 0; w < nWin; w++) {
    const s = path[w];
    const base = w * nStates;
    // parabolik ara değer
    let off = 0;
    if (s > 0 && s < nStates - 1) {
      const a = sal[base + s - 1], b = sal[base + s], c = sal[base + s + 1];
      const den = a - 2 * b + c;
      if (den < 0) off = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
    }
    bpm[w] = BPM_MIN * Math.pow(2, (s + off) / STATES_PER_OCTAVE);
    const me = raw[base + s];
    let alt = 0;
    for (const d of [STATES_PER_OCTAVE, -STATES_PER_OCTAVE]) {
      for (let k = -1; k <= 1; k++) {
        const q = s + d + k;
        if (q >= 0 && q < nStates) alt = Math.max(alt, raw[base + q]);
      }
    }
    ambiguity[w] = me > 0 ? clamp01(alt / me) : 1;
  }
  return { bpm, strength: strengthW, ambiguity, barStrength: barStrW, hopFrames: H, winFrames: W };
}

/** Ellis dinamik programlama vuruş izleyicisi, kare başına değişken periyotla. */
export function trackBeats(o: Float32Array, periodAt: (frame: number) => number, tightness = 100): Int32Array {
  const n = o.length;
  const sd = stdDev(o) || 1;
  const on = new Float64Array(n);
  for (let i = 0; i < n; i++) on[i] = o[i] / sd;
  const C = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    const P = periodAt(t);
    const a = Math.max(0, Math.round(t - 2 * P)), b = Math.round(t - P / 2);
    let bv = -Infinity, bi = -1;
    for (let tau = a; tau <= b && tau < t; tau++) {
      const lr = Math.log((t - tau) / P);
      const v = C[tau] - tightness * lr * lr;
      if (v > bv) { bv = v; bi = tau; }
    }
    if (bi >= 0 && bv > 0) { C[t] = on[t] + bv; back[t] = bi; } else C[t] = on[t];
  }
  // son vuruş: son iki periyottaki yerel en büyük
  const Pend = periodAt(n - 1);
  let end = n - 1, ev = -Infinity;
  for (let t = Math.max(1, Math.round(n - 2 * Pend)); t < n - 1; t++) {
    if (C[t] >= C[t - 1] && C[t] >= C[t + 1] && C[t] > ev) { ev = C[t]; end = t; }
  }
  const beats: number[] = [];
  for (let t = end; t >= 0; t = back[t]) { beats.push(t); if (back[t] < 0) break; }
  beats.reverse();
  return Int32Array.from(beats);
}

/** Baştaki ve sondaki desteksiz vuruşları kırp. */
function trimBeats(beats: Int32Array, o: Float32Array): Int32Array {
  if (beats.length < 4) return beats;
  const sm = movingAverage(o, 3);
  let sq = 0;
  for (const b of beats) sq += sm[b] * sm[b];
  const thr = 0.5 * Math.sqrt(sq / beats.length);
  let a = 0, z = beats.length;
  while (a < z && sm[beats[a]] <= thr) a++;
  while (z > a && sm[beats[z - 1]] <= thr) z--;
  return beats.slice(a, z);
}

/**
 * Senkop düzeltmesi: 16 vuruşluk pencerelerde bas ataklarını ölçü içi sekizlik
 * konumlara katlar. En güçlü aksan vuruş arasına düşüyorsa (tek sekizlik),
 * ızgara yarım vuruş kaymıştır; pencere yarım vuruş kaydırılır.
 * Dönen accent: pencere başına aksan netliği 0..1 (vuruşlar için).
 */
function correctHalfBeatPhase(beats: Int32Array, oBass: Float32Array, oFull: Float32Array): { beats: Int32Array; accent: Float32Array } {
  const n = beats.length;
  const accent = new Float32Array(n);
  if (n < 16) return { beats, accent };
  const WIN = 16;
  const nWin = Math.ceil((n - 1) / WIN);
  const shift = new Int8Array(nWin), clar = new Float32Array(nWin);
  for (let w = 0; w < nWin; w++) {
    const bins = new Float64Array(8);
    for (let i = w * WIN; i < Math.min(n - 1, (w + 1) * WIN); i++) {
      const b0 = beats[i], b1 = beats[i + 1];
      const r = Math.max(1, Math.round((b1 - b0) * 0.08));
      const k = (i - w * WIN) % 4;
      const m = Math.round((b0 + b1) / 2);
      bins[2 * k] += localMax(oBass, b0, r) + 0.15 * localMax(oFull, b0, r);
      bins[2 * k + 1] += localMax(oBass, m, r) + 0.15 * localMax(oFull, m, r);
    }
    let even = 0, odd = 0;
    for (let k = 0; k < 8; k++) if (k % 2) odd = Math.max(odd, bins[k]); else even = Math.max(even, bins[k]);
    shift[w] = odd > even * 1.15 ? 1 : 0;
    clar[w] = clamp01((Math.abs(even - odd) / (even + odd + 1e-9)) * 2.5);
  }
  // tek pencerelik sapmaları çoğunlukla düzelt
  const sm = Int8Array.from(shift);
  for (let w = 1; w < nWin - 1; w++) if (shift[w - 1] === shift[w + 1]) sm[w] = shift[w - 1];
  // kısa son pencere kendi başına karar veremez
  if (nWin > 1 && n - 1 - (nWin - 1) * WIN < 12) sm[nWin - 1] = sm[nWin - 2];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const w = Math.min(nWin - 1, Math.floor(i / WIN));
    if (sm[w] && i < n - 1) {
      const mid = (beats[i] + beats[i + 1]) / 2;
      // pencere girişinde araya bir vuruş daha (kayma öncesi boşluğu kapat)
      out.push(Math.round(mid));
    } else if (!sm[w]) out.push(beats[i]);
    accent[i] = clar[w];
  }
  const outArr = Int32Array.from(out.filter((v, i, a) => i === 0 || v > a[i - 1]));
  const acc = new Float32Array(outArr.length);
  for (let i = 0; i < outArr.length; i++) acc[i] = clar[Math.min(nWin - 1, Math.floor(i / WIN))];
  return { beats: outArr, accent: acc };
}

function localMax(o: Float32Array, f: number, r: number): number {
  let m = 0;
  for (let i = Math.max(0, f - r); i <= Math.min(o.length - 1, f + r); i++) m = Math.max(m, o[i]);
  return m;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
}

export function analyzeRhythm(f: FrameFeatures): RhythmStage {
  const fps = f.fps;
  const oFull = normalizeOnset(f.onset, fps);
  const oBass = normalizeOnset(f.onsetBass, fps);
  const oTempo = new Float32Array(oFull.length);
  for (let i = 0; i < oTempo.length; i++) oTempo[i] = oFull[i] + 0.8 * oBass[i];

  const tt = trackTempo(oTempo, fps);
  const nW = tt.bpm.length;
  const bpmAtFrame = (t: number) => {
    const w = t / tt.hopFrames;
    const a = Math.max(0, Math.min(nW - 1, Math.floor(w))), b = Math.min(nW - 1, a + 1);
    const fr = Math.max(0, Math.min(1, w - a));
    return tt.bpm[a] * (1 - fr) + tt.bpm[b] * fr;
  };
  let frames = trackBeats(oTempo, (t) => (60 * fps) / bpmAtFrame(t));
  frames = trimBeats(frames, oTempo);
  // aksan karşılaştırması için kırpılmamış ham akış
  const pc = correctHalfBeatPhase(frames, f.onsetBass, f.onset);
  frames = pc.beats;

  const nb = frames.length;
  const beats = new Float32Array(nb);
  const strength = new Float32Array(nb), bassStr = new Float32Array(nb), conf = new Float32Array(nb);
  const p95 = percentile(oFull, 0.95) || 1, p95b = percentile(oBass, 0.95) || 1;
  const contrast: number[] = [];
  for (let i = 0; i < nb; i++) {
    const b = frames[i];
    let off = 0;
    if (b > 0 && b < oTempo.length - 1) {
      const a = oTempo[b - 1], c = oTempo[b], d = oTempo[b + 1];
      const den = a - 2 * c + d;
      if (den < 0) off = Math.max(-0.5, Math.min(0.5, (0.5 * (a - d)) / den));
    }
    beats[i] = (b + off) / fps + f.timeOffset;
    strength[i] = clamp01(localMax(oFull, b, 2) / p95);
    bassStr[i] = clamp01(localMax(oBass, b, 2) / p95b);
    // vuruş/arası karşıtlığı
    const prev = i > 0 ? frames[i - 1] : b - Math.round((60 * fps) / bpmAtFrame(b));
    const nxt = i < nb - 1 ? frames[i + 1] : b + Math.round((60 * fps) / bpmAtFrame(b));
    const onV = localMax(oTempo, b, 2);
    let btw = 0, cnt = 0;
    for (const q of [0.25, 0.5, 0.75]) {
      const m1 = Math.round(b + (nxt - b) * q), m0 = Math.round(prev + (b - prev) * q);
      for (const m of [m0, m1]) if (m >= 0 && m < oTempo.length) { btw += localMax(oTempo, m, 1); cnt++; }
    }
    btw /= cnt || 1;
    contrast.push((onV - btw) / (onV + btw + 1e-6));
  }
  const activity = movingAverage(oTempo, Math.round(fps));
  // yerel güven: karşıtlık + periyodiklik + oktav belirsizliği, ±4 vuruşta medyan
  for (let i = 0; i < nb; i++) {
    const w = Math.max(0, Math.min(nW - 1, Math.round(frames[i] / tt.hopFrames)));
    const c = median(contrast.slice(Math.max(0, i - 4), i + 5));
    // periyodiklik: rastgele ataklar ~0.2, ritmik müzik 0.4+
    const per = clamp01((tt.strength[w] - 0.22) / 0.3);
    const amb = tt.ambiguity[w];
    const support = clamp01(activity[frames[i]] / 0.12);
    const base = (0.35 + 1.3 * c) * (0.1 + 0.9 * per) * (1 - 0.35 * Math.max(0, amb - 0.6) / 0.4);
    // senkoplu parçalarda: net ölçü periyodu + net aksan hizası da güven kanıtıdır
    const barEv = clamp01((tt.barStrength[w] - 0.3) / 0.3) * pc.accent[i];
    conf[i] = clamp01(Math.max(base, 0.85 * barEv) * (0.4 + 0.6 * support));
  }

  // tempo eğrisi (saniye başına)
  const secs = Math.max(1, Math.ceil(f.frames / fps));
  const tempoCurve = new Float32Array(secs);
  for (let s = 0; s < secs; s++) tempoCurve[s] = bpmAtFrame(s * fps);
  // genel tempo: vuruş aralıklarının medyanı
  const ibis: number[] = [];
  for (let i = 1; i < nb; i++) ibis.push(beats[i] - beats[i - 1]);
  const bpm = ibis.length ? 60 / median(ibis) : median(Array.from(tt.bpm));
  const confs = Array.from(conf);
  const confidence = clamp01(median(confs) * (nb >= 8 ? 1 : nb / 8));
  const tempoConfidence = clamp01((median(Array.from(tt.strength)) - 0.22) / 0.3);
  const octaveAmbiguity = median(Array.from(tt.ambiguity));

  const db = detectDownbeats(f, frames, oBass, oFull, conf);
  if (typeof process !== 'undefined' && process.env?.RHY_DEBUG) {
    const med = (a: ArrayLike<number>) => median(Array.from(a));
    console.log('[rhy]', JSON.stringify({ contrast: median(contrast).toFixed(2), per: med(tt.strength).toFixed(2), amb: med(tt.ambiguity).toFixed(2), bar: med(tt.barStrength).toFixed(2), accent: med(pc.accent).toFixed(2), act: med(Array.from(frames, (b) => activity[b])).toFixed(2), dbc: db.confidence.toFixed(2) }));
  }
  return {
    bpm, tempoCurve, tempoConfidence, octaveAmbiguity,
    beats, beatConfidence: conf, beatStrength: strength, beatBass: bassStr,
    downbeats: confidence >= 0.3 && db.confidence >= 0.35 ? Float32Array.from(db.downbeats, (i) => beats[i]) : new Float32Array(0),
    meter: db.meter, downbeatConfidence: confidence >= 0.3 ? db.confidence : 0,
    confidence,
  };
}

function zscore(x: Float64Array): Float64Array {
  let m = 0;
  for (const v of x) m += v;
  m /= x.length || 1;
  let s = 0;
  for (const v of x) s += (v - m) ** 2;
  s = Math.sqrt(s / (x.length || 1)) || 1;
  return x.map((v) => (v - m) / s);
}

/** Vuruş düzeyinde ölçü başı tahmini: bas atağı + akor değişimi + atak gücü, pencereli HMM. */
export function detectDownbeats(f: FrameFeatures, beatFrames: Int32Array, oBass: Float32Array, oFull: Float32Array, conf: Float32Array) {
  const nb = beatFrames.length;
  const empty = { downbeats: new Float32Array(0), meter: 4, confidence: 0 };
  if (nb < 12) return empty;
  const chDiv = f.fps / 10;
  // vuruş eşzamanlı kroma
  const chroma: Float64Array[] = [];
  for (let i = 0; i < nb; i++) {
    const a = Math.floor(beatFrames[i] / chDiv);
    const b = Math.max(a + 1, Math.floor((i < nb - 1 ? beatFrames[i + 1] : beatFrames[i] + (beatFrames[i] - beatFrames[i - 1])) / chDiv));
    const v = new Float64Array(12);
    for (let c = a; c < Math.min(b, f.chromaFrames); c++) for (let k = 0; k < 12; k++) v[k] += f.chroma[c * 12 + k];
    let nrm = 0;
    for (let k = 0; k < 12; k++) nrm += v[k] * v[k];
    nrm = Math.sqrt(nrm) || 1;
    for (let k = 0; k < 12; k++) v[k] /= nrm;
    chroma.push(v);
  }
  const change = new Float64Array(nb), bassF = new Float64Array(nb), onF = new Float64Array(nb);
  for (let i = 0; i < nb; i++) {
    let dot = 0;
    if (i > 0) for (let k = 0; k < 12; k++) dot += chroma[i][k] * chroma[i - 1][k];
    change[i] = i > 0 ? 1 - dot : 0;
    bassF[i] = localMax(oBass, beatFrames[i], 2);
    onF[i] = localMax(oFull, beatFrames[i], 2);
  }
  const zc = zscore(change), zb = zscore(bassF), zo = zscore(onF);
  const d = new Float64Array(nb);
  for (let i = 0; i < nb; i++) d[i] = 1.0 * zb[i] + 1.2 * zc[i] + 0.4 * zo[i];

  let best = { meter: 4, phases: new Int8Array(0), confidence: 0, contrast: -Infinity };
  for (const M of [4, 3]) {
    const WIN = M * 8;
    const nWin = Math.ceil(nb / WIN);
    const sc: Float64Array[] = [];
    for (let w = 0; w < nWin; w++) {
      const s = new Float64Array(M);
      for (let p = 0; p < M; p++) {
        let on = 0, onN = 0, ot = 0, otN = 0;
        for (let i = w * WIN; i < Math.min(nb, (w + 1) * WIN); i++) {
          if (((i - p) % M + M) % M === 0) { on += d[i]; onN++; } else { ot += d[i]; otN++; }
        }
        s[p] = (onN ? on / onN : 0) - (otN ? ot / otN : 0);
      }
      sc.push(s);
    }
    // faz HMM: değişim cezası
    const pen = 1.5;
    let score = Float64Array.from(sc[0]);
    const back: Int8Array[] = [];
    for (let w = 1; w < nWin; w++) {
      const ns = new Float64Array(M), bk = new Int8Array(M);
      for (let p = 0; p < M; p++) {
        let bv = -Infinity, bi = 0;
        for (let q = 0; q < M; q++) { const v = score[q] - (q === p ? 0 : pen); if (v > bv) { bv = v; bi = q; } }
        ns[p] = bv + sc[w][p]; bk[p] = bi;
      }
      score = ns; back.push(bk);
    }
    let p = 0;
    for (let q = 1; q < M; q++) if (score[q] > score[p]) p = q;
    const phases = new Int8Array(nWin);
    for (let w = nWin - 1; w >= 0; w--) { phases[w] = p; if (w > 0) p = back[w - 1][p]; }
    // karşıtlık ve marj
    let contrastSum = 0, marginSum = 0, wsum = 0;
    for (let w = 0; w < nWin; w++) {
      const s = sc[w], chosen = s[phases[w]];
      let second = -Infinity;
      for (let q = 0; q < M; q++) if (q !== phases[w]) second = Math.max(second, s[q]);
      let cw = 0;
      for (let i = w * WIN; i < Math.min(nb, (w + 1) * WIN); i++) cw += conf[i];
      cw /= Math.min(nb, (w + 1) * WIN) - w * WIN;
      contrastSum += chosen * cw; marginSum += (chosen - second) * cw; wsum += cw;
    }
    const contrast = contrastSum / (wsum || 1);
    const margin = marginSum / (wsum || 1);
    const adj = M === 4 ? contrast * 1.15 : contrast; // 4/4 öncelikli
    if (adj > best.contrast) best = { meter: M, phases, confidence: clamp01(margin / 1.2), contrast: adj };
  }
  const M = best.meter, WIN = M * 8;
  const out: number[] = [];
  for (let i = 0; i < nb; i++) {
    const ph = best.phases[Math.min(best.phases.length - 1, Math.floor(i / WIN))];
    if (((i - ph) % M + M) % M === 0) out.push(i);
  }
  return { downbeatIdx: out, downbeats: Float32Array.from(out), meter: M, confidence: best.confidence };
}
