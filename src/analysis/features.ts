import { RealFFT } from './fft';

/**
 * Kare düzeyinde öznitelik çıkarımı. Bellek sınırlı tutulur: 40 bantlı spektrum
 * saklanmaz; akış (flux) halka arabellekle hesaplanır, kroma/tını bölüm
 * çözünürlüğüne (SEG_SEC) doğrudan toplanır.
 */
export const FRAME_FPS = 100;
export const SEG_SEC = 0.5;
const N_BANDS = 40;
const BASS_MAX_HZ = 150;
const MID_MAX_HZ = 2000;

export interface FrameFeatures {
  fps: number;
  frames: number;
  /** her karenin zamanı = i / fps + timeOffset */
  timeOffset: number;
  onset: Float32Array; // tüm bantlarda pozitif log-akış
  onsetBass: Float32Array; // bas bantlarında akış
  onsetHigh: Float32Array; // tiz bantlarda akış
  bass: Float32Array; // bant enerjileri (doğrusal güç)
  mid: Float32Array;
  treble: Float32Array;
  rmsDb: Float32Array;
  centroid: Float32Array; // Hz
  /** 10 kare/s hızında 12 boyutlu kroma (ölçü başı için akor değişimi) */
  chroma: Float32Array;
  chromaFrames: number;
  /** bölüm öznitelikleri: segFrames × 24 (12 kroma + 12 tını) */
  seg: Float32Array;
  segFrames: number;
  segDim: number;
}

export function extractFeatures(
  x: Float32Array,
  sr: number,
  onProgress?: (p: number) => void,
): FrameFeatures {
  const hop = Math.round(sr / FRAME_FPS);
  const fps = sr / hop;
  let nfft = 512;
  while (nfft < sr * 0.046) nfft <<= 1;
  const fft = new RealFFT(nfft);
  const nb = nfft / 2 + 1;
  const binHz = sr / nfft;
  const frames = Math.max(1, Math.floor((x.length - nfft) / hop) + 1);

  // pencere
  const win = new Float64Array(nfft);
  for (let i = 0; i < nfft; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nfft);
  const winSum = win.reduce((a, b) => a + b, 0);

  // logaritmik bantlar 30 Hz .. min(11 kHz, nyquist)
  const fLo = 30, fHi = Math.min(11000, sr / 2 - binHz);
  const edges: number[] = [];
  for (let b = 0; b <= N_BANDS; b++) edges.push(fLo * Math.pow(fHi / fLo, b / N_BANDS));
  const bandOf = new Int16Array(nb).fill(-1);
  for (let k = 1; k < nb; k++) {
    const f = k * binHz;
    for (let b = 0; b < N_BANDS; b++) if (f >= edges[b] && f < edges[b + 1]) { bandOf[k] = b; break; }
  }
  // düşük frekanslı bantlarda tek bin bile olmayabilir: en yakın bin'i ata
  const bandHasBin = new Uint8Array(N_BANDS);
  for (let k = 0; k < nb; k++) if (bandOf[k] >= 0) bandHasBin[bandOf[k]] = 1;
  const bandCenterBin = new Int32Array(N_BANDS);
  for (let b = 0; b < N_BANDS; b++) bandCenterBin[b] = Math.max(1, Math.min(nb - 1, Math.round(Math.sqrt(edges[b] * edges[b + 1]) / binHz)));
  const bandIsBass = new Uint8Array(N_BANDS), bandIsHigh = new Uint8Array(N_BANDS);
  for (let b = 0; b < N_BANDS; b++) {
    const c = Math.sqrt(edges[b] * edges[b + 1]);
    bandIsBass[b] = c < BASS_MAX_HZ ? 1 : 0;
    bandIsHigh[b] = c > 3000 ? 1 : 0;
  }
  // tını: 40 bandı 12 gruba
  const timbreOf = new Int8Array(N_BANDS);
  for (let b = 0; b < N_BANDS; b++) timbreOf[b] = Math.min(11, Math.floor((b * 12) / N_BANDS));
  // kroma: 55 Hz .. 5 kHz
  const chromaOf = new Int8Array(nb).fill(-1);
  for (let k = 1; k < nb; k++) {
    const f = k * binHz;
    if (f < 55 || f > 5000) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    chromaOf[k] = ((Math.round(midi) % 12) + 12) % 12;
  }

  const onset = new Float32Array(frames), onsetBass = new Float32Array(frames), onsetHigh = new Float32Array(frames);
  const bass = new Float32Array(frames), mid = new Float32Array(frames), treble = new Float32Array(frames);
  const rmsDb = new Float32Array(frames), centroid = new Float32Array(frames);
  const segLen = Math.max(1, Math.round(SEG_SEC * fps));
  const segFrames = Math.ceil(frames / segLen);
  const segDim = 24;
  const seg = new Float32Array(segFrames * segDim);

  const CH_DIV = Math.max(1, Math.round(fps / 10));
  const chromaFrames = Math.ceil(frames / CH_DIV);
  const chroma = new Float32Array(chromaFrames * 12);
  const buf = new Float64Array(nfft);
  const mag = new Float32Array(nb);
  const band = new Float64Array(N_BANDS);
  // önceki karenin log bantları
  const prev1 = new Float64Array(N_BANDS), cur = new Float64Array(N_BANDS);
  const norm = 2 / winSum;
  const reportEvery = Math.max(1, Math.floor(frames / 50));

  for (let t = 0; t < frames; t++) {
    const off = t * hop;
    let sq = 0;
    for (let i = 0; i < nfft; i++) {
      const v = x[off + i] || 0;
      sq += v * v;
      buf[i] = v * win[i];
    }
    fft.magnitude(buf, mag);
    band.fill(0);
    let eB = 0, eM = 0, eT = 0, cNum = 0, cDen = 0;
    const sBase = Math.floor(t / segLen) * segDim;
    const cBase = Math.floor(t / CH_DIV) * 12;
    for (let k = 1; k < nb; k++) {
      const a = mag[k] * norm;
      const p = a * a;
      const f = k * binHz;
      const b = bandOf[k];
      if (b >= 0) band[b] += p;
      if (f < BASS_MAX_HZ) eB += p; else if (f < MID_MAX_HZ) eM += p; else eT += p;
      cNum += f * a; cDen += a;
      const c = chromaOf[k];
      if (c >= 0) { seg[sBase + c] += a; chroma[cBase + c] += a; }
    }
    for (let b = 0; b < N_BANDS; b++) if (!bandHasBin[b]) { const a = mag[bandCenterBin[b]] * norm; band[b] = a * a; }
    let flux = 0, fluxB = 0, fluxH = 0;
    for (let b = 0; b < N_BANDS; b++) {
      const l = Math.log(1 + 1e4 * band[b]);
      // vibrato/ince perde kaymalarına karşı: önceki karenin komşu bantlarıyla en büyüğü (SuperFlux benzeri)
      const ref = Math.max(prev1[b], b > 0 ? prev1[b - 1] : 0, b < N_BANDS - 1 ? prev1[b + 1] : 0);
      const d = l - ref;
      if (d > 0) {
        flux += d;
        if (bandIsBass[b]) fluxB += d;
        if (bandIsHigh[b]) fluxH += d;
      }
      seg[sBase + 12 + timbreOf[b]] += l;
      cur[b] = l;
    }
    prev1.set(cur);
    if (t < 1) { flux = 0; fluxB = 0; fluxH = 0; }
    onset[t] = flux; onsetBass[t] = fluxB; onsetHigh[t] = fluxH;
    bass[t] = eB; mid[t] = eM; treble[t] = eT;
    rmsDb[t] = 10 * Math.log10(sq / nfft + 1e-12);
    centroid[t] = cDen > 0 ? cNum / cDen : 0;
    if (onProgress && t % reportEvery === 0) onProgress(t / frames);
  }
  // bölüm özniteliklerini ortala
  for (let s = 0; s < segFrames; s++) {
    const n = Math.min(segLen, frames - s * segLen);
    for (let d = 0; d < segDim; d++) seg[s * segDim + d] /= n;
  }
  // kare zamanı: pencerenin merkezi
  const timeOffset = nfft / 2 / sr;
  return { fps, frames, timeOffset, chroma, chromaFrames, onset, onsetBass, onsetHigh, bass, mid, treble, rmsDb, centroid, seg, segFrames, segDim };
}

// ---------- küçük yardımcılar ----------
export function movingAverage(x: Float32Array, radius: number): Float32Array {
  const n = x.length, out = new Float32Array(n);
  let acc = 0;
  const cs = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) { acc += x[i]; cs[i + 1] = acc; }
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - radius), b = Math.min(n, i + radius + 1);
    out[i] = (cs[b] - cs[a]) / (b - a);
  }
  return out;
}

export function percentile(x: ArrayLike<number>, p: number): number {
  const n = x.length;
  if (!n) return 0;
  // büyük dizilerde örnekleyerek hızlı yaklaşım
  const step = Math.max(1, Math.floor(n / 20000));
  const s: number[] = [];
  for (let i = 0; i < n; i += step) s.push(x[i]);
  s.sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
}

/** Yerel ortalamayı çıkarıp yarı dalga doğrultma ve sağlam normalizasyon. */
export function normalizeOnset(x: Float32Array, fps: number): Float32Array {
  const m = movingAverage(x, Math.round(fps * 0.5));
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = Math.max(0, x[i] - m[i]);
  const p = percentile(out, 0.98) || 1;
  for (let i = 0; i < out.length; i++) out[i] = Math.min(2, out[i] / p);
  return out;
}

/** Kare hızındaki diziyi hedef hıza ortalama ile indirger. */
export function resampleCurve(x: Float32Array, srcFps: number, dstFps: number, srcOffset: number, duration: number): Float32Array {
  const n = Math.max(1, Math.ceil(duration * dstFps));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t0 = i / dstFps, t1 = (i + 1) / dstFps;
    let a = Math.floor((t0 - srcOffset) * srcFps), b = Math.ceil((t1 - srcOffset) * srcFps);
    a = Math.max(0, Math.min(x.length - 1, a));
    b = Math.max(a + 1, Math.min(x.length, b));
    let s = 0;
    for (let j = a; j < b; j++) s += x[j];
    out[i] = s / (b - a);
  }
  return out;
}
