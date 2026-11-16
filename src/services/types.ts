export type Provider = 'spotify' | 'youtube';

export interface Track {
  provider: Provider;
  id: string;
  title: string;
  artists: string;
  album?: string;
  image?: string;
  durationMs?: number;
  /** Spotify URI ya da YouTube video kimliği */
  uri: string;
  /** sağlayıcıda açma bağlantısı */
  url: string;
}

export interface Collection {
  provider: Provider;
  kind: 'playlist' | 'album' | 'liked' | 'recent';
  id: string;
  title: string;
  subtitle: string;
  image?: string;
  /** Spotify bağlam URI'si (liste/albüm/beğenilenler); YouTube'da liste kimliği */
  contextUri?: string;
  url?: string;
  /** içerik okunabilir mi (Spotify: yalnız sahip olunan/ortak listeler) */
  readable: boolean;
  count?: number;
}

export interface Account {
  provider: Provider;
  name: string;
  image?: string;
  /** Spotify: premium | free | open */
  product?: string;
}

export interface NowPlaying {
  provider: Provider;
  track: Track | null;
  playing: boolean;
  positionMs: number;
  durationMs: number;
  /** konumun okunduğu an (performance.now) — ara değer için */
  at: number;
  canSeek: boolean;
  canSkip: boolean;
}

/** Sağlayıcıdan bağımsız taşıma denetimi. */
export interface PlaybackAdapter {
  readonly provider: Provider;
  toggle(): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  seek(ms: number): Promise<void>;
  state(): NowPlaying | null;
  dispose(): void;
}

export class AuthError extends Error {}
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly reason?: string) { super(message); }
}
