/**
 * Web Audio oynatma motoru: HTMLAudioElement (akışlı, uzun dosyada bellek dostu)
 * → MediaElementSource → Analyser → çıkış. Anlık bas/orta/tiz enerjisi verir.
 */
export interface LiveLevels {
  bass: number;
  mid: number;
  treble: number;
  rms: number;
  /** ham bas yükselişi (atak) 0..1 */
  bassRise: number;
}

type AudioSessionNav = Navigator & { audioSession?: { type: string } };

export class AudioEngine {
  readonly el: HTMLAudioElement;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private freq: Float32Array<ArrayBuffer> | null = null;
  private time: Float32Array<ArrayBuffer> | null = null;
  private objectUrl: string | null = null;
  private prevBassDb = -100;
  private bandBins: { bass: [number, number]; mid: [number, number]; treble: [number, number] } | null = null;
  readonly levels: LiveLevels = { bass: 0, mid: 0, treble: 0, rms: 0, bassRise: 0 };

  constructor() {
    this.el = new Audio();
    this.el.preload = 'auto';
    this.el.crossOrigin = 'anonymous';
    this.el.setAttribute('playsinline', '');
    // iOS: sessiz anahtarında Web Audio'nun kısılmaması için
    const nav = navigator as AudioSessionNav;
    try { if (nav.audioSession) nav.audioSession.type = 'playback'; } catch { /* desteklenmiyor */ }
  }

  /** Kullanıcı hareketi içinde çağrılmalı (iOS/Chrome otomatik oynatma kuralları). */
  ensureContext(): AudioContext {
    if (!this.ctx) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      const src = this.ctx.createMediaElementSource(this.el);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0;
      this.analyser.minDecibels = -100;
      this.analyser.maxDecibels = -10;
      src.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this.freq = new Float32Array(this.analyser.frequencyBinCount);
      this.time = new Float32Array(this.analyser.fftSize);
      const hz = this.ctx.sampleRate / this.analyser.fftSize;
      const bin = (f: number) => Math.max(1, Math.round(f / hz));
      this.bandBins = { bass: [bin(30), bin(150)], mid: [bin(150), bin(2000)], treble: [bin(2000), bin(10000)] };
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  get context(): AudioContext | null { return this.ctx; }

  /** Çıkışa giden sesin hoparlöre ulaşma gecikmesi (s). */
  outputLatency(): number {
    const c = this.ctx as (AudioContext & { outputLatency?: number }) | null;
    if (!c) return 0;
    const v = (c.outputLatency || 0) + (c.baseLatency || 0);
    return Number.isFinite(v) ? Math.min(0.5, v) : 0;
  }

  load(src: File | string): void {
    this.unload();
    if (typeof src === 'string') this.el.src = src;
    else {
      this.objectUrl = URL.createObjectURL(src);
      this.el.src = this.objectUrl;
    }
    this.el.load();
  }

  unload(): void {
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.levels.bass = this.levels.mid = this.levels.treble = this.levels.rms = this.levels.bassRise = 0;
  }

  get hasSource(): boolean { return !!this.el.currentSrc; }

  async play(): Promise<void> {
    this.ensureContext();
    await this.el.play();
  }
  pause(): void { this.el.pause(); }

  /** Her karede çağrılır; anlık seviyeleri günceller (0..1). */
  sample(): LiveLevels {
    const L = this.levels;
    if (!this.analyser || !this.freq || !this.time || !this.bandBins || this.el.paused) {
      L.bass *= 0.9; L.mid *= 0.9; L.treble *= 0.9; L.rms *= 0.9; L.bassRise = 0;
      return L;
    }
    this.analyser.getFloatFrequencyData(this.freq);
    this.analyser.getFloatTimeDomainData(this.time);
    const band = ([a, b]: [number, number]) => {
      let p = 0;
      for (let i = a; i < b; i++) p += Math.pow(10, this.freq![i] / 10);
      return 10 * Math.log10(p / (b - a) + 1e-12);
    };
    const map = (db: number, lo: number, hi: number) => Math.max(0, Math.min(1, (db - lo) / (hi - lo)));
    const bDb = band(this.bandBins.bass);
    L.bass = map(bDb, -75, -22);
    L.mid = map(band(this.bandBins.mid), -85, -32);
    L.treble = map(band(this.bandBins.treble), -95, -45);
    let sq = 0;
    for (let i = 0; i < this.time.length; i++) sq += this.time[i] * this.time[i];
    L.rms = map(10 * Math.log10(sq / this.time.length + 1e-12), -55, -8);
    L.bassRise = Math.max(0, Math.min(1, (bDb - this.prevBassDb) / 9));
    this.prevBassDb = this.prevBassDb * 0.6 + bDb * 0.4;
    return L;
  }
}
