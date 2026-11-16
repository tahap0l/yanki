/**
 * Gerçek girişli FFT: N noktalı gerçek diziyi N/2 noktalı karmaşık FFT ile işler.
 * Tahsis yalnızca kurulumda yapılır; kare başına bellek ayrılmaz.
 */
export class RealFFT {
  readonly n: number;
  private readonly half: number;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Uint32Array;
  private readonly twR: Float64Array;
  private readonly twI: Float64Array;

  constructor(n: number) {
    if (n < 4 || (n & (n - 1)) !== 0) throw new Error('FFT boyutu 2’nin kuvveti olmalı');
    this.n = n;
    const h = (this.half = n >> 1);
    this.re = new Float64Array(h);
    this.im = new Float64Array(h);
    this.cos = new Float64Array(h >> 1);
    this.sin = new Float64Array(h >> 1);
    for (let i = 0; i < h >> 1; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / h);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / h);
    }
    this.rev = new Uint32Array(h);
    const bits = Math.log2(h);
    for (let i = 0; i < h; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.twR = new Float64Array(h);
    this.twI = new Float64Array(h);
    for (let k = 0; k < h; k++) {
      this.twR[k] = Math.cos((2 * Math.PI * k) / n);
      this.twI[k] = -Math.sin((2 * Math.PI * k) / n);
    }
  }

  /** input: n gerçek örnek. outMag: n/2+1 genlik. */
  magnitude(input: Float32Array | Float64Array, outMag: Float32Array): void {
    const h = this.half, re = this.re, im = this.im, rev = this.rev;
    for (let i = 0; i < h; i++) {
      const j = rev[i];
      re[j] = input[2 * i];
      im[j] = input[2 * i + 1];
    }
    for (let size = 2; size <= h; size <<= 1) {
      const halfSize = size >> 1, step = h / size;
      for (let start = 0; start < h; start += size) {
        for (let k = 0; k < halfSize; k++) {
          const wr = this.cos[k * step], wi = this.sin[k * step];
          const a = start + k, b = a + halfSize;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
    // N/2 karmaşık sonuçtan N gerçek spektrumu
    outMag[0] = Math.abs(re[0] + im[0]);
    outMag[h] = Math.abs(re[0] - im[0]);
    for (let k = 1; k < h; k++) {
      const ar = re[k], ai = im[k], br = re[h - k], bi = -im[h - k];
      const er = 0.5 * (ar + br), ei = 0.5 * (ai + bi);
      const or = 0.5 * (ai - bi), oi = -0.5 * (ar - br);
      const xr = er + this.twR[k] * or - this.twI[k] * oi;
      const xi = ei + this.twR[k] * oi + this.twI[k] * or;
      outMag[k] = Math.sqrt(xr * xr + xi * xi);
    }
  }
}
