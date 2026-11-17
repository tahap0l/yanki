import { LiveBeatTracker, type LiveEvents } from './LiveBeatTracker';
import workletUrl from './live-worklet.ts?worker&url';

export type MicStatus = 'off' | 'starting' | 'on' | 'denied' | 'unavailable';
/** mic: ortam sesi; system: bilgisayarın kendi çaldığı ses (kulaklıkla da çalışır) */
export type ListenSource = 'mic' | 'system';

const isMobileDevice = () => /Android|iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

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
  private worklet: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private queue: { t: number; db: Float32Array; rms: number }[] = [];
  /** ses saati → performance saati farkı (en küçük gecikmeli gözlem) */
  private clockOffset: number | null = null;
  private static loaded = new WeakSet<BaseAudioContext>();
  onStatus?: (s: MicStatus, message?: string) => void;

  source: ListenSource = 'mic';
  get supported(): boolean { return !!navigator.mediaDevices?.getUserMedia; }
  /** Sistem sesi yalnız masaüstü Chromium tarayıcılarda (getDisplayMedia + ses) */
  get systemSupported(): boolean { return !!navigator.mediaDevices?.getDisplayMedia && !isMobileDevice(); }
  get on(): boolean { return this.status === 'on'; }

  /** Giriş gecikmesi (s): sahne vuruşları bu kadar öne alır. */
  inputLatency(): number {
    const c = this.ctx as (AudioContext & { baseLatency?: number }) | null;
    const base = c?.baseLatency || 0.01;
    // sistem sesi: hoparlöre giden sesin kopyası, akustik yol yok; çıkış gecikmesi kadar öndeyiz
    if (this.source === 'system') {
      const out = (c as (AudioContext & { outputLatency?: number }) | null)?.outputLatency || 0.02;
      return Math.max(0, Math.min(0.2, base + 0.01 - out * 0.5));
    }
    const track = this.stream?.getAudioTracks()[0];
    const s = track?.getSettings() as (MediaTrackSettings & { latency?: number }) | undefined;
    return Math.min(0.25, (s?.latency || 0.02) + base);
  }

  /** Kullanıcı hareketi içinde çağrılmalı. */
  async start(ctx: AudioContext, source: ListenSource = 'mic'): Promise<void> {
    if (this.status === 'on' || this.status === 'starting') return;
    this.source = source;
    if (source === 'system') return this.startSystem(ctx);
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
    await this.attach(ctx, 'Mikrofon başka bir uygulama tarafından kapatıldı.');
  }

  /**
   * Bilgisayarın çaldığı ses (Spotify, YouTube, herhangi bir uygulama).
   * Tarayıcı paylaşım penceresinde kullanıcı “Sistem sesini de paylaş”ı seçer.
   * Görüntü kullanılmaz; alınır alınmaz kapatılır.
   */
  private async startSystem(ctx: AudioContext): Promise<void> {
    if (!this.systemSupported || !isSecureContext) { this.set('unavailable', 'Sistem sesi yalnız bilgisayarda Chrome ya da Edge ile alınabilir. Telefonda tarayıcılar buna izin vermiyor.'); return; }
    this.set('starting');
    const tabTest = new URLSearchParams(location.search).get('capture') === 'tab'; // otomatik testler için
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } as MediaTrackConstraints,
        // Chrome'a özgü seçenekler: sistem sesini öner, ekranı varsayılan yap
        ...(tabTest ? { preferCurrentTab: true } : { systemAudio: 'include', selfBrowserSurface: 'exclude', monitorTypeSurfaces: 'include', surfaceSwitching: 'exclude' }),
      } as DisplayMediaStreamOptions);
    } catch (e) {
      const name = (e as DOMException)?.name;
      if (name === 'NotAllowedError') this.set('off', 'Paylaşım iptal edildi.');
      else this.set('off', 'Sistem sesi alınamadı. Paylaşım penceresinde “Tüm ekran” ve “Sistem sesini de paylaş”ı seçip yeniden deneyin.');
      return;
    }
    stream.getVideoTracks().forEach((t) => t.stop());
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((t) => t.stop());
      this.set('off', 'Ses gelmedi. Paylaşım penceresinde “Tüm ekran”ı seçip altta “Sistem sesini de paylaş” kutusunu işaretleyin.');
      return;
    }
    this.stream = stream;
    await this.attach(ctx, 'Sistem sesi paylaşımı durduruldu.');
  }

  private async attach(ctx: AudioContext, endedMsg: string): Promise<void> {
    if (!this.stream) return;
    this.ctx = ctx;
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
    this.src = ctx.createMediaStreamSource(this.stream);
    this.queue = [];
    this.clockOffset = null;
    // tercih: ses iş parçacığında sabit aralıklı analiz; yoksa çizim karesinde AnalyserNode
    if (ctx.audioWorklet) {
      try {
        if (!MicInput.loaded.has(ctx)) { await ctx.audioWorklet.addModule(workletUrl); MicInput.loaded.add(ctx); }
        this.worklet = new AudioWorkletNode(ctx, 'yanki-analyser', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        this.worklet.port.onmessage = (e: MessageEvent<{ t: number; db: Float32Array; rms: number }>) => {
          const now = performance.now() / 1000;
          const off = now - e.data.t;
          // mesaj gecikmesi hep pozitif: en küçük farkı tut, yavaşça bırak (saat kayması)
          this.clockOffset = this.clockOffset === null || off < this.clockOffset ? off : this.clockOffset + 0.0005;
          this.queue.push(e.data);
          if (this.queue.length > 200) this.queue.splice(0, this.queue.length - 200);
        };
        this.sink = ctx.createGain();
        this.sink.gain.value = 0; // işlem sürsün diye çıkışa sessiz bağlanır
        this.src.connect(this.worklet);
        this.worklet.connect(this.sink);
        this.sink.connect(ctx.destination);
      } catch (e) {
        console.warn('AudioWorklet kullanılamadı, AnalyserNode ile devam', e);
        this.worklet = null;
      }
    }
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    this.analyser.minDecibels = -110;
    this.analyser.maxDecibels = -10;
    this.src.connect(this.analyser);
    this.freq = new Float32Array(this.analyser.frequencyBinCount);
    this.time = new Float32Array(this.analyser.fftSize);
    this.stream.getAudioTracks()[0]?.addEventListener('ended', () => this.stop(endedMsg));
    this.set('on');
  }

  stop(message?: string): void {
    try { this.src?.disconnect(); } catch { /* yoksay */ }
    try { this.worklet?.disconnect(); this.sink?.disconnect(); } catch { /* yoksay */ }
    if (this.worklet) this.worklet.port.onmessage = null;
    this.worklet = null; this.sink = null; this.queue = [];
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null; this.src = null; this.analyser = null;
    if (this.status !== 'denied' && this.status !== 'unavailable') this.set('off', message);
  }

  /** Her karede: yeni spektrumu izleyiciye verir. t = performance.now()/1000 */
  sample(t: number): LiveEvents | null {
    if (this.status !== 'on' || !this.ctx) return null;
    if (this.worklet) {
      const out: LiveEvents = { beats: [], onsets: [] };
      const off = this.clockOffset ?? 0;
      for (const fr of this.queue) {
        const ev = this.tracker.push(fr.t + off, fr.db, this.ctx.sampleRate, fr.rms);
        out.beats.push(...ev.beats); out.onsets.push(...ev.onsets);
      }
      this.queue.length = 0;
      return out;
    }
    if (!this.analyser || !this.freq || !this.time) return null;
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
