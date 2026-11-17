/// <reference lib="es2022" />
/**
 * Ses iş parçacığında çalışan analiz: her 768 örnekte (48 kHz'de ≈16 ms) Blackman
 * pencereli 2048 noktalı spektrum hesaplar ve ana iş parçacığına yollar.
 * Çizim kare hızından bağımsızdır; yavaş cihazda da ataklar kaçmaz.
 */
import { RealFFT } from '../analysis/fft';

declare const sampleRate: number;
declare const currentTime: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor { readonly port: MessagePort; constructor(); }

// 2048 pencere, 768 atlama (48 kHz'de ≈16 ms): ölçülmüş en iyi ayar, çizim hızından bağımsız
const N = 2048, HOP = 768;

class YankiAnalyser extends AudioWorkletProcessor {
  private ring = new Float32Array(N);
  private pos = 0;
  private sinceHop = 0;
  private fft = new RealFFT(N);
  private win = new Float64Array(N);
  private buf = new Float64Array(N);
  private mag = new Float32Array(N / 2 + 1);

  constructor() {
    super();
    for (let i = 0; i < N; i++) this.win[i] = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / N) + 0.08 * Math.cos((4 * Math.PI * i) / N);
  }

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0];
    if (!ch || !ch.length) return true;
    const n = ch[0].length;
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let c = 0; c < ch.length; c++) v += ch[c][i];
      this.ring[this.pos] = v / ch.length;
      this.pos = (this.pos + 1) % N;
      if (++this.sinceHop >= HOP) {
        this.sinceHop = 0;
        this.emit(currentTime + (i + 1) / sampleRate);
      }
    }
    return true;
  }

  private emit(t: number): void {
    let sq = 0;
    for (let i = 0; i < N; i++) {
      const v = this.ring[(this.pos + i) % N];
      sq += v * v;
      this.buf[i] = v * this.win[i];
    }
    this.fft.magnitude(this.buf, this.mag);
    const db = new Float32Array(N / 2);
    for (let k = 0; k < N / 2; k++) db[k] = 20 * Math.log10(this.mag[k] / N + 1e-12);
    this.port.postMessage({ t, db, rms: 10 * Math.log10(sq / N + 1e-12) }, [db.buffer]);
  }
}

registerProcessor('yanki-analyser', YankiAnalyser);
