import type { NowPlaying, PlaybackAdapter, Track } from '../types';
import type { SpotifyApi } from './SpotifyApi';
import type { SpotifyAuth } from './SpotifyAuth';
import { toTrack } from './SpotifyApi';

/* eslint-disable @typescript-eslint/no-explicit-any */
interface SdkPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  addListener(ev: string, cb: (x: any) => void): boolean;
  togglePlay(): Promise<void>;
  nextTrack(): Promise<void>;
  previousTrack(): Promise<void>;
  seek(ms: number): Promise<void>;
  activateElement?(): Promise<void>;
}
declare global {
  interface Window {
    Spotify?: { Player: new (o: { name: string; getOAuthToken: (cb: (t: string) => void) => void; volume?: number }) => SdkPlayer };
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

let sdkPromise: Promise<void> | null = null;
function loadSdk(): Promise<void> {
  if (window.Spotify?.Player) return Promise.resolve();
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const t = setTimeout(() => { sdkPromise = null; reject(new Error('Spotify oynatıcısı yüklenemedi (zaman aşımı).')); }, 15000);
    window.onSpotifyWebPlaybackSDKReady = () => { clearTimeout(t); resolve(); };
    const s = document.createElement('script');
    s.src = 'https://sdk.scdn.co/spotify-player.js';
    s.async = true;
    s.onerror = () => { clearTimeout(t); sdkPromise = null; reject(new Error('Spotify oynatıcısı yüklenemedi.')); };
    document.head.appendChild(s);
  });
  return sdkPromise;
}

export type SpotifyMode = 'browser' | 'connect';

/**
 * Spotify oynatma: önce Web Playback SDK ile bu tarayıcıda (Premium gerekir);
 * olmazsa Spotify Connect ile kullanıcının açık Spotify uygulamasını yönetir.
 * Ses verisine ve görsel senkrona erişilmez; yalnızca durum (parça, çalıyor mu) okunur.
 */
export class SpotifyPlayback implements PlaybackAdapter {
  readonly provider = 'spotify' as const;
  private player: SdkPlayer | null = null;
  deviceId: string | null = null;
  mode: SpotifyMode = 'browser';
  private now: NowPlaying | null = null;
  private poll = 0;
  private readyPromise: Promise<void> | null = null;
  private disposed = false;
  connectDeviceName = '';
  onChange?: (np: NowPlaying | null) => void;
  onNotice?: (msg: string) => void;
  /** SDK başlatılamadığında neden */
  browserError = '';

  constructor(private api: SpotifyApi, private auth: SpotifyAuth) {}

  /** Tarayıcı oynatıcısını hazırlar (bir kez). */
  ready(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = (async () => {
      try {
        await loadSdk();
        if (this.disposed) return;
        const p = new window.Spotify!.Player({
          name: 'Yankı',
          volume: 0.8,
          getOAuthToken: (cb) => { this.auth.accessToken().then(cb, () => cb('')); },
        });
        this.player = p;
        const ok = await new Promise<boolean>((resolve) => {
          const fail = (why: string) => { this.browserError = why; resolve(false); };
          const t = setTimeout(() => fail('Spotify tarayıcı oynatıcısı yanıt vermedi.'), 12000);
          p.addListener('ready', ({ device_id }) => { clearTimeout(t); this.deviceId = device_id; resolve(true); });
          p.addListener('initialization_error', ({ message }) => { clearTimeout(t); fail(`Bu tarayıcı Spotify oynatmayı desteklemiyor (${message}).`); });
          p.addListener('authentication_error', () => { clearTimeout(t); fail('Spotify oturumu doğrulanamadı; yeniden bağlanın.'); });
          p.addListener('account_error', () => { clearTimeout(t); fail('Tarayıcıda çalmak için tam Spotify Premium gerekir.'); });
          p.addListener('playback_error', ({ message }) => this.onNotice?.(`Spotify çalma hatası: ${message}`));
          p.addListener('not_ready', () => { this.deviceId = null; });
          p.addListener('player_state_changed', (s) => this.fromSdk(s));
          p.connect().then((c) => { if (!c) { clearTimeout(t); fail('Spotify oynatıcısına bağlanılamadı.'); } });
        });
        if (!ok) { this.toConnectMode(); }
      } catch (e) {
        this.browserError = e instanceof Error ? e.message : 'Spotify oynatıcısı yüklenemedi.';
        this.toConnectMode();
      }
    })();
    return this.readyPromise;
  }

  private toConnectMode(): void {
    this.mode = 'connect';
    try { this.player?.disconnect(); } catch { /* yoksay */ }
    this.player = null;
    this.deviceId = null;
  }

  private fromSdk(s: any): void {
    if (!s) { this.now = null; this.onChange?.(null); return; }
    const t = s.track_window?.current_track;
    const track: Track | null = t ? toTrack({ ...t, type: 'track', external_urls: { spotify: `https://open.spotify.com/track/${t.id}` } }) : null;
    this.now = {
      provider: 'spotify', track, playing: !s.paused, positionMs: s.position, durationMs: s.duration || track?.durationMs || 0,
      at: performance.now(), canSeek: !s.disallows?.seeking, canSkip: !s.disallows?.skipping_next,
    };
    this.onChange?.(this.now);
  }

  private async refreshConnect(): Promise<void> {
    try {
      const s = await this.api.playbackState();
      if (this.disposed) return;
      if (!s) { this.now = null; this.onChange?.(null); return; }
      this.connectDeviceName = s.device?.name || '';
      const track = toTrack(s.item);
      this.now = {
        provider: 'spotify', track, playing: !!s.is_playing, positionMs: s.progress_ms || 0, durationMs: s.item?.duration_ms || 0,
        at: performance.now(), canSeek: !s.actions?.disallows?.seeking, canSkip: !s.actions?.disallows?.skipping_next,
      };
      this.onChange?.(this.now);
    } catch { /* geçici */ }
  }

  private startPolling(): void {
    clearInterval(this.poll);
    this.poll = window.setInterval(() => { if (!document.hidden) void this.refreshConnect(); }, 2500);
    void this.refreshConnect();
  }

  /**
   * Bir bağlamı (liste/albüm/beğenilenler) ya da parça dizisini çalar.
   * Kullanıcı hareketi içinde çağrılmalı (mobil tarayıcı otomatik oynatma kuralı).
   */
  async play(opts: { contextUri?: string; uris?: string[]; offsetUri?: string }): Promise<void> {
    // mobil: kullanıcı hareketinin içinde ses öğesini etkinleştir
    try { await this.player?.activateElement?.(); } catch { /* yoksay */ }
    await this.ready();
    const body: { context_uri?: string; uris?: string[]; offset?: { uri: string } } = {};
    if (opts.contextUri) body.context_uri = opts.contextUri;
    if (opts.uris) body.uris = opts.uris.slice(0, 100);
    if (opts.offsetUri) body.offset = { uri: opts.offsetUri };
    if (this.mode === 'browser' && this.deviceId) {
      await this.api.play(this.deviceId, body);
      return;
    }
    // Connect: etkin cihaz ya da ilk uygun cihaz
    const devs = await this.api.devices();
    const dev = devs.find((d) => d.active) || devs[0];
    if (!dev) {
      throw new Error('Açık bir Spotify uygulaması bulunamadı. Telefonunuzda ya da bilgisayarınızda Spotify’ı açın, sonra tekrar deneyin.');
    }
    this.connectDeviceName = dev.name;
    await this.api.play(dev.id, body);
    this.startPolling();
  }

  async toggle(): Promise<void> {
    if (this.mode === 'browser' && this.player) { await this.player.togglePlay(); return; }
    if (this.now?.playing) await this.api.pause(); else await this.api.resume();
    setTimeout(() => void this.refreshConnect(), 400);
  }
  async next(): Promise<void> {
    if (this.mode === 'browser' && this.player) await this.player.nextTrack();
    else { await this.api.next(); setTimeout(() => void this.refreshConnect(), 600); }
  }
  async prev(): Promise<void> {
    if (this.mode === 'browser' && this.player) await this.player.previousTrack();
    else { await this.api.previous(); setTimeout(() => void this.refreshConnect(), 600); }
  }
  async seek(ms: number): Promise<void> {
    if (this.mode === 'browser' && this.player) await this.player.seek(ms);
    else { await this.api.seek(ms); setTimeout(() => void this.refreshConnect(), 400); }
  }

  /** Ara değerlenmiş anlık durum. */
  state(): NowPlaying | null {
    const n = this.now;
    if (!n) return null;
    if (!n.playing) return n;
    const pos = Math.min(n.durationMs || Infinity, n.positionMs + (performance.now() - n.at));
    return { ...n, positionMs: pos };
  }

  /** Çalmayı durdurur ama oturumu korur (kaynak değişince). */
  async stop(): Promise<void> {
    clearInterval(this.poll);
    try {
      if (this.now?.playing) {
        if (this.mode === 'browser' && this.player) await this.player.togglePlay();
        else await this.api.pause();
      }
    } catch { /* yoksay */ }
    this.now = null;
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.poll);
    try { this.player?.disconnect(); } catch { /* yoksay */ }
    this.player = null;
    this.readyPromise = null;
  }
}
