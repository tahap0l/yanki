import { ApiError, AuthError, type Account, type Collection, type Track } from '../types';
import type { GoogleAuth } from './GoogleAuth';
import type { Page } from '../spotify/SpotifyApi';

const BASE = 'https://www.googleapis.com/youtube/v3';
/* eslint-disable @typescript-eslint/no-explicit-any */
type J = any;

function thumb(t: J): string | undefined {
  return t?.medium?.url || t?.high?.url || t?.default?.url;
}

function isoDurationMs(d: string | undefined): number | undefined {
  const m = d?.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return undefined;
  return ((+(m[1] || 0) * 24 + +(m[2] || 0)) * 3600 + +(m[3] || 0) * 60 + +(m[4] || 0)) * 1000;
}

/** "Sanatçı - Topic" kanal adlarını ve video başlıklarını sadeleştirir. */
function cleanArtist(ch: string | undefined): string {
  return (ch || '').replace(/ - Topic$/, '').replace(/VEVO$/i, '').trim();
}

/**
 * YouTube Data API v3 (salt okunur). Kota: liste/öğe çağrıları 1 birim,
 * arama 100 birim (günlük varsayılan 10 000).
 */
export class YouTubeApi {
  constructor(private auth: GoogleAuth) {}

  private async request(path: string, params: Record<string, string>, retry = 0): Promise<J> {
    const token = await this.auth.accessToken();
    const u = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401 && retry < 1) { this.auth.invalidate(); return this.request(path, params, retry + 1); }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = j?.error?.errors?.[0]?.reason || j?.error?.status;
      if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') throw new ApiError('YouTube günlük API kotası doldu; yarın tekrar deneyin.', res.status, reason);
      if (res.status === 401) throw new AuthError('YouTube oturumu sona erdi; yeniden bağlanın.');
      throw new ApiError(j?.error?.message || res.statusText, res.status, reason);
    }
    return j;
  }

  async me(): Promise<Account> {
    const j = await this.request('/channels', { part: 'snippet', mine: 'true' });
    const c = j.items?.[0];
    return { provider: 'youtube', name: c?.snippet?.title || 'YouTube hesabı', image: thumb(c?.snippet?.thumbnails) };
  }

  async playlists(pageToken?: string): Promise<Page<Collection>> {
    const j = await this.request('/playlists', { part: 'snippet,contentDetails', mine: 'true', maxResults: '50', ...(pageToken ? { pageToken } : {}) });
    const items: Collection[] = (j.items || []).map((p: J) => ({
      provider: 'youtube', kind: 'playlist', id: p.id, title: p.snippet?.title || 'Liste',
      subtitle: `${p.contentDetails?.itemCount ?? 0} video`, image: thumb(p.snippet?.thumbnails),
      contextUri: p.id, url: `https://www.youtube.com/playlist?list=${p.id}`, readable: true, count: p.contentDetails?.itemCount,
    }));
    return { items, next: j.nextPageToken || null, total: j.pageInfo?.totalResults };
  }

  likedCollection(): Collection {
    return { provider: 'youtube', kind: 'liked', id: 'LL', title: 'Beğenilen videolar', subtitle: 'YouTube', contextUri: 'LL', url: 'https://www.youtube.com/playlist?list=LL', readable: true };
  }

  async playlistTracks(id: string, pageToken?: string): Promise<Page<Track>> {
    if (id === 'LL') return this.liked(pageToken);
    const j = await this.request('/playlistItems', { part: 'snippet,contentDetails,status', playlistId: id, maxResults: '50', ...(pageToken ? { pageToken } : {}) });
    const items: Track[] = (j.items || [])
      .filter((x: J) => x.status?.privacyStatus !== 'private' && x.snippet?.title !== 'Deleted video' && x.snippet?.title !== 'Private video')
      .map((x: J) => {
        const vid = x.contentDetails?.videoId || x.snippet?.resourceId?.videoId;
        return {
          provider: 'youtube', id: vid, uri: vid, title: x.snippet?.title || '', artists: cleanArtist(x.snippet?.videoOwnerChannelTitle),
          image: thumb(x.snippet?.thumbnails), url: `https://www.youtube.com/watch?v=${vid}&list=${id}`,
        } satisfies Track;
      });
    return { items, next: j.nextPageToken || null, total: j.pageInfo?.totalResults };
  }

  /** Beğenilen videolar (videos.list myRating=like). */
  async liked(pageToken?: string): Promise<Page<Track>> {
    const j = await this.request('/videos', { part: 'snippet,contentDetails', myRating: 'like', maxResults: '50', ...(pageToken ? { pageToken } : {}) });
    return { items: (j.items || []).map((v: J) => this.videoToTrack(v)), next: j.nextPageToken || null, total: j.pageInfo?.totalResults };
  }

  private videoToTrack(v: J): Track {
    return {
      provider: 'youtube', id: v.id, uri: v.id, title: v.snippet?.title || '', artists: cleanArtist(v.snippet?.channelTitle),
      image: thumb(v.snippet?.thumbnails), durationMs: isoDurationMs(v.contentDetails?.duration), url: `https://www.youtube.com/watch?v=${v.id}`,
    };
  }

  /** Müzik araması (100 kota birimi) — yalnız gömülebilir videolar. */
  async search(q: string): Promise<{ tracks: Track[]; playlists: Collection[] }> {
    const j = await this.request('/search', { part: 'snippet', q, type: 'video', videoCategoryId: '10', videoEmbeddable: 'true', maxResults: '20', safeSearch: 'none' });
    const tracks: Track[] = (j.items || []).filter((x: J) => x.id?.videoId).map((x: J) => ({
      provider: 'youtube', id: x.id.videoId, uri: x.id.videoId, title: decodeEntities(x.snippet?.title || ''),
      artists: cleanArtist(x.snippet?.channelTitle), image: thumb(x.snippet?.thumbnails), url: `https://www.youtube.com/watch?v=${x.id.videoId}`,
    }));
    return { tracks, playlists: [] };
  }
}

function decodeEntities(s: string): string {
  const t = document.createElement('textarea');
  t.innerHTML = s;
  return t.value;
}
