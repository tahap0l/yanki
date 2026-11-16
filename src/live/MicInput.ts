import { LiveBeatTracker, type LiveEvents } from './LiveBeatTracker';

export type MicStatus = 'off' | 'starting' | 'on' | 'denied' | 'unavailable';

/**
 * Mikrofondan dinleme: cihazda o an çalan müziği (herhangi bir uygulama ya da
 * hoparlör) duyar ve LiveBeatTracker'a verir. Ses hiçbir yere gönderilmez,
 * kaydedilmez; yalnız anlık spektrum hesaplanır. Çıkışa bağlanmaz (yankı yok).
 */
export class MicInput {
  status: MicStatus = 'off';
  readonly tracker = new LiveBeatTracker();
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private freq: Float32Array<ArrayBuffer> | null = null;
  private time: Float32Array<ArrayBuffer> | null = null;
  onStatus?: (s: MicStatus, message?: string) => void;

  get supported(): boolean { return !!navigator.mediaDevices?.getUserMedia; }
  get on(): boolean { return this.status === 'on'; }

  /** Giriş gecikmesi (s): sahne vuruşları bu kadar öne alır. */
  inputLatency(): number {
    const c = this.ctx as (AudioContext & { baseLatency?: number }) | null;
    const base = c?.baseLatency || 0.01;
    const track = this.stream?.getAudioTracks()[0];
    const s = track?.getSettings() as (MediaTrackSettings & { latency?: number }) | undefined;
    return Math.min(0.25, (s?.latency || 0.02) + base);
  }

  /** Kullanıcı hareketi içinde çağrılmalı. */
  async start(ctx: AudioContext): Promise<void> {
    if (this.status === 'on' || this.status === 'starting') return;
    if (!this.supported || !isSecureContext) { this.set('unavailable', 'Bu tarayıcı mikrofona erişim vermiyor (HTTPS gerekir).'); return; }
    this.set('starting');
    try {
      // yankı giderme/gürültü bastırma kapalı: cihazın kendi çaldığı müziği silmesin
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
        video: false,
      });
    } catch (e) {
      const name = (e as DOMException)?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') this.set('denied', 'Mikrofon izni verilmedi. Tarayıcı ya da telefon ayarlarından Yankı’ya mikrofon izni verin.');
      else if (name === 'NotFoundError') this.set('unavailable', 'Bu cihazda mikrofon bulunamadı.');
      else this.set('unavailable', 'Mikrofon açılamadı.');
      return;
    }
    this.ctx = ctx;
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
    this.src = ctx.createMediaStreamSource(this.stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    this.analyser.minDecibels = -110;
    this.analyser.maxDecibels = -10;
    this.src.connect(this.analyser);
    this.freq = new Float32Array(this.analyser.frequencyBinCount);
    this.time = new Float32Array(this.analyser.fftSize);
    this.stream.getAudioTracks()[0]?.addEventListener('ended', () => this.stop('Mikrofon başka bir uygulama tarafından kapatıldı.'));
    this.set('on');
  }

  stop(message?: string): void {
    try { this.src?.disconnect(); } catch { /* yoksay */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null; this.src = null; this.analyser = null;
    if (this.status !== 'denied' && this.status !== 'unavailable') this.set('off', message);
  }

  /** Her karede: yeni spektrumu izleyiciye verir. t = performance.now()/1000 */
  sample(t: number): LiveEvents | null {
    if (this.status !== 'on' || !this.analyser || !this.freq || !this.time || !this.ctx) return null;
    this.analyser.getFloatFrequencyData(this.freq);
    this.analyser.getFloatTimeDomainData(this.time);
    let sq = 0;
    for (let i = 0; i < this.time.length; i++) sq += this.time[i] * this.time[i];
    return this.tracker.push(t, this.freq, this.ctx.sampleRate, 10 * Math.log10(sq / this.time.length + 1e-12));
  }

  private set(s: MicStatus, message?: string): void {
    this.status = s;
    this.onStatus?.(s, message);
  }
}
