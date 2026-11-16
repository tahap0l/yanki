export type ParsedLink =
  | { kind: 'spotify'; type: 'track' | 'album' | 'playlist' | 'episode' | 'show' | 'artist'; id: string; url: string }
  | { kind: 'youtube'; videoId: string; start: number; url: string; watchUrl: string }
  | { kind: 'unknown'; reason: string };

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const SPOTIFY_TYPES = ['track', 'album', 'playlist', 'episode', 'show', 'artist'] as const;

function parseStart(v: string | null): number {
  if (!v) return 0;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  const m = v.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m) return 0;
  return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
}

/** Spotify / YouTube / YouTube Music bağlantısını çözümler. Ağ isteği yapmaz. */
export function parseLink(input: string): ParsedLink {
  const raw = input.trim();
  if (!raw) return { kind: 'unknown', reason: 'Bağlantı boş.' };
  // spotify:track:ID
  const uri = raw.match(/^spotify:(track|album|playlist|episode|show|artist):([A-Za-z0-9]{22})$/);
  if (uri) {
    const type = uri[1] as (typeof SPOTIFY_TYPES)[number];
    return { kind: 'spotify', type, id: uri[2], url: `https://open.spotify.com/${type}/${uri[2]}` };
  }
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { kind: 'unknown', reason: 'Bu bir bağlantıya benzemiyor.' };
  }
  const host = u.hostname.replace(/^www\.|^m\./, '').toLowerCase();
  if (host === 'open.spotify.com' || host === 'play.spotify.com') {
    const parts = u.pathname.split('/').filter(Boolean).filter((p) => !/^intl-[a-z]{2}/i.test(p));
    const ti = parts.findIndex((p) => (SPOTIFY_TYPES as readonly string[]).includes(p));
    if (ti >= 0 && SPOTIFY_ID.test(parts[ti + 1] || '')) {
      const type = parts[ti] as (typeof SPOTIFY_TYPES)[number];
      return { kind: 'spotify', type, id: parts[ti + 1], url: `https://open.spotify.com/${type}/${parts[ti + 1]}` };
    }
    return { kind: 'unknown', reason: 'Spotify bağlantısında şarkı, albüm veya liste kimliği bulunamadı.' };
  }
  if (host === 'spotify.link') return { kind: 'unknown', reason: 'Kısa Spotify bağlantıları çözülemiyor; uygulamadaki “Bağlantıyı kopyala” ile tam bağlantıyı yapıştırın.' };
  let id = '';
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
    else {
      const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/);
      if (m) id = m[1];
    }
  }
  if (host.endsWith('youtube.com') || host === 'youtu.be' || host === 'youtube-nocookie.com') {
    if (!YT_ID.test(id)) return { kind: 'unknown', reason: 'YouTube bağlantısında video kimliği bulunamadı.' };
    const start = parseStart(u.searchParams.get('t') || u.searchParams.get('start'));
    const watch = new URL(host === 'music.youtube.com' ? 'https://music.youtube.com/watch' : 'https://www.youtube.com/watch');
    watch.searchParams.set('v', id);
    if (start) watch.searchParams.set('t', `${start}s`);
    return { kind: 'youtube', videoId: id, start, url: raw, watchUrl: watch.toString() };
  }
  return { kind: 'unknown', reason: 'Yalnızca Spotify ve YouTube bağlantıları destekleniyor. Kendi ses dosyanızı “Dosya aç” ile açabilirsiniz.' };
}

export const SPOTIFY_TYPE_LABEL: Record<string, string> = {
  track: 'Şarkı', album: 'Albüm', playlist: 'Çalma listesi', episode: 'Bölüm', show: 'Podcast', artist: 'Sanatçı',
};
