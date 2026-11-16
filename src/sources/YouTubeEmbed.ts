/**
 * Resmi YouTube IFrame Player API sarmalayıcısı.
 * Oynatıcı her zaman görünür kalır; kontroller ve reklamlar YouTube'a aittir.
 * Ses yakalanmaz, analiz edilmez; sahne bu kaynaktan bağımsız akar.
 * Uygulamanın düğmeleri yalnız resmi oynatıcı API'sini çağırır.
 */
import type { NowPlaying, PlaybackAdapter, Track } from '../services/types';

interface YTPlayer {
  destroy(): void;
  getPlayerState(): number;
  playVideo(): void;
  pauseVideo(): void;
  nextVideo(): void;
  previousVideo(): void;
  seekTo(s: number, allow: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlaylistIndex(): number;
  getVideoData?(): { video_id: string; title: string; author: string };
  loadPlaylist(list: string[] | { list: string; listType: string; index?: number }, index?: number, start?: number): void;
  loadVideoById(id: string, start?: number): void;
}
interface YTNamespace {
  Player: new (el: HTMLElement, opts: unknown) => YTPlayer;
  PlayerState: { PLAYING: number; PAUSED: number; ENDED: number; BUFFERING: number; CUED: number };
}
declare global {
  interface Window { YT?: YTNamespace; onYouTubeIframeAPIReady?: () => void }
}

let apiPromise: Promise<YTNamespace> | null = null;

function loadApi(timeoutMs = 12000): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<YTNamespace>((resolve, reject) => {
    const timer = setTimeout(() => { apiPromise = null; reject(new Error('timeout')); }, timeoutMs);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      clearTimeout(timer);
      if (window.YT?.Player) resolve(window.YT); else reject(new Error('api'));
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => { clearTimeout(timer); apiPromise = null; s.remove(); reject(new Error('load')); };
    document.head.appendChild(s);
  });
  return apiPromise;
}

export type YouTubeStatus =
  | { state: 'loading' }
  | { state: 'ready' }
  | { state: 'playing' }
  | { state: 'paused' }
  | { state: 'ended' }
  | { state: 'skipped'; reason: string }
  | { state: 'unavailable'; reason: string };

const ERRORS: Record<number, string> = {
  2: 'Video kimliği geçersiz.',
  5: 'Bu video tarayıcıda oynatılamıyor.',
  100: 'Video bulunamadı ya da gizli.',
  101: 'Video sahibi başka sitelerde oynatılmasına izin vermiyor.',
  150: 'Video sahibi başka sitelerde oynatılmasına izin vermiyor.',
  153: 'Video bu sayfada oynatılamıyor.',
};

export class YouTubeEmbed implements PlaybackAdapter {
  readonly provider = 'youtube' as const;
  private player: YTPlayer | null = null;
  private YT: YTNamespace | null = null;
  private disposed = false;
  private queue: Track[] = [];
  private status: YouTubeStatus = { state: 'loading' };
  private readyP: Promise<boolean> | null = null;
  onTrack?: () => void;

  constructor(private host: HTMLElement, private onStatus: (s: YouTubeStatus) => void) {}

  private emit(s: YouTubeStatus): void { this.status = s; this.onStatus(s); }

  /** Oynatıcıyı kurar (ilk video ile). */
  private create(videoId: string, start: number, playlist?: string[], index = 0): Promise<boolean> {
    this.emit({ state: 'loading' });
    this.readyP = (async () => {
      try { this.YT = await loadApi(); } catch {
        if (!this.disposed) this.emit({ state: 'unavailable', reason: 'YouTube oynatıcısı yüklenemedi (ağ veya tarayıcı engeli).' });
        return false;
      }
      if (this.disposed) return false;
      const YT = this.YT;
      const mount = document.createElement('div');
      this.host.replaceChildren(mount);
      const origin = /^https?:$/.test(location.protocol) ? location.origin : undefined;
      return new Promise<boolean>((resolve) => {
        this.player = new YT.Player(mount, {
          videoId,
          width: '100%',
          height: '100%',
          playerVars: { playsinline: 1, rel: 0, start: start || undefined, origin, autoplay: 1, ...(playlist ? { playlist: playlist.filter((_, i) => i !== index).slice(0, 199).join(',') } : {}) },
          events: {
            onReady: () => {
              this.emit({ state: 'ready' });
              if (playlist && playlist.length > 1) this.player?.loadPlaylist(playlist.slice(0, 200), Math.min(index, 199));
              resolve(true);
            },
            onError: (e: { data: number }) => {
              const reason = ERRORS[e.data] || 'Video gömülü olarak oynatılamıyor.';
              // sırada başka video varsa atla
              if (this.queue.length > 1 && (e.data === 101 || e.data === 150 || e.data === 100 || e.data === 153)) {
                this.emit({ state: 'skipped', reason });
                setTimeout(() => this.player?.nextVideo(), 400);
              } else this.emit({ state: 'unavailable', reason });
            },
            onStateChange: (e: { data: number }) => {
              if (e.data === YT.PlayerState.PLAYING) this.emit({ state: 'playing' });
              else if (e.data === YT.PlayerState.PAUSED) this.emit({ state: 'paused' });
              else if (e.data === YT.PlayerState.ENDED) this.emit({ state: 'ended' });
              this.onTrack?.();
            },
          },
        });
      });
    })();
    return this.readyP;
  }

  /** Tek video (bağlantıdan). */
  async open(videoId: string, start: number): Promise<void> {
    this.queue = [];
    await this.create(videoId, start);
  }

  /** Parça dizisini çalar (kütüphaneden). */
  async playQueue(tracks: Track[], index: number): Promise<void> {
    this.queue = tracks.slice(0, 200);
    const ids = this.queue.map((t) => t.uri);
    const i = Math.max(0, Math.min(ids.length - 1, index));
    if (this.player && this.status.state !== 'unavailable') {
      if (ids.length > 1) this.player.loadPlaylist(ids, i);
      else this.player.loadVideoById(ids[i]);
      return;
    }
    await this.create(ids[i], 0, ids.length > 1 ? ids : undefined, i);
  }

  /** YouTube'daki bir listeyi doğrudan çalar (içerik yüklenmeden). */
  async playList(listId: string, index = 0): Promise<void> {
    this.queue = [];
    if (this.player && this.status.state !== 'unavailable') { this.player.loadPlaylist({ list: listId, listType: 'playlist', index }); return; }
    this.emit({ state: 'loading' });
    try { this.YT = await loadApi(); } catch { this.emit({ state: 'unavailable', reason: 'YouTube oynatıcısı yüklenemedi (ağ veya tarayıcı engeli).' }); return; }
    if (this.disposed) return;
    const YT = this.YT;
    const mount = document.createElement('div');
    this.host.replaceChildren(mount);
    const origin = /^https?:$/.test(location.protocol) ? location.origin : undefined;
    this.player = new YT.Player(mount, {
      width: '100%', height: '100%',
      playerVars: { playsinline: 1, rel: 0, origin, autoplay: 1, listType: 'playlist', list: listId, index },
      events: {
        onReady: () => this.emit({ state: 'ready' }),
        onError: (e: { data: number }) => { this.emit({ state: 'skipped', reason: ERRORS[e.data] || 'Video oynatılamıyor.' }); setTimeout(() => this.player?.nextVideo(), 400); },
        onStateChange: (e: { data: number }) => {
          if (e.data === YT.PlayerState.PLAYING) this.emit({ state: 'playing' });
          else if (e.data === YT.PlayerState.PAUSED) this.emit({ state: 'paused' });
          this.onTrack?.();
        },
      },
    });
  }

  get unavailable(): boolean { return this.status.state === 'unavailable'; }

  async toggle(): Promise<void> {
    const p = this.player;
    if (!p || !this.YT) return;
    if (p.getPlayerState() === this.YT.PlayerState.PLAYING) p.pauseVideo(); else p.playVideo();
  }
  async next(): Promise<void> { this.player?.nextVideo(); }
  async prev(): Promise<void> {
    const p = this.player;
    if (!p) return;
    if (p.getCurrentTime() > 4) p.seekTo(0, true); else p.previousVideo();
  }
  async seek(ms: number): Promise<void> { this.player?.seekTo(ms / 1000, true); }

  state(): NowPlaying | null {
    const p = this.player;
    if (!p || !this.YT || typeof p.getCurrentTime !== 'function') return null;
    let track: Track | null = null;
    const data = p.getVideoData?.();
    const vid = data?.video_id;
    if (vid) track = this.queue.find((t) => t.uri === vid) || {
      provider: 'youtube', id: vid, uri: vid, title: data.title || '', artists: (data.author || '').replace(/ - Topic$/, ''),
      image: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`, url: `https://www.youtube.com/watch?v=${vid}`,
    };
    const st = p.getPlayerState();
    return {
      provider: 'youtube', track, playing: st === this.YT.PlayerState.PLAYING || st === this.YT.PlayerState.BUFFERING,
      positionMs: (p.getCurrentTime() || 0) * 1000, durationMs: (p.getDuration() || 0) * 1000, at: performance.now(),
      canSeek: true, canSkip: this.queue.length > 1 || (p.getPlaylistIndex?.() ?? -1) >= 0,
    };
  }

  dispose(): void {
    this.disposed = true;
    try { this.player?.destroy(); } catch { /* yoksay */ }
    this.player = null;
    this.host.replaceChildren();
  }
}
