import { ApiError, AuthError, type Account, type Collection, type Track } from '../types';
import type { SpotifyAuth } from './SpotifyAuth';

const BASE = 'https://api.spotify.com/v1';

/* eslint-disable @typescript-eslint/no-explicit-any */
type J = any;

function pickImage(images: { url: string; width?: number | null }[] | undefined, target = 300): string | undefined {
  if (!images?.length) return undefined;
  const s = images.slice().sort((a, b) => Math.abs((a.width || target) - target) - Math.abs((b.width || target) - target));
  return s[0].url;
}

export function toTrack(t: J): Track | null {
  if (!t || t.type !== 'track' || !t.uri || t.is_local) return null;
  return {
    provider: 'spotify', id: t.id, uri: t.uri,
    title: t.name, artists: (t.artists || []).map((a: J) => a.name).join(', '),
    album: t.album?.name, image: pickImage(t.album?.images, 300), durationMs: t.duration_ms,
    url: t.external_urls?.spotify || `https://open.spotify.com/track/${t.id}`,
  };
}

export interface Page<T> { items: T[]; next: string | null; total?: number; notice?: string }

/**
 * Spotify Web API istemcisi (Şubat 2026 geliştirme modu kurallarına göre):
 * liste içeriği /playlists/{id}/items ile ve yalnız sahip olunan/ortak listelerde okunur;
 * arama en fazla 10 sonuç döndürür.
 */
export class SpotifyApi {
  private meId = '';
  constructor(private auth: SpotifyAuth) {}

  async request<T = J>(path: string, init: RequestInit = {}, retry = 0): Promise<T> {
    const token = await this.auth.accessToken();
    const res = await fetch(path.startsWith('http') ? path : BASE + path, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) },
    });
    if (res.status === 401 && retry < 1) { this.auth.invalidate(); return this.request(path, init, retry + 1); }
    if (res.status === 429 && retry < 2) {
      const wait = Math.min(10, Number(res.headers.get('Retry-After')) || 2);
      await new Promise((r) => setTimeout(r, wait * 1000));
      return this.request(path, init, retry + 1);
    }
    if (res.status === 204 || res.status === 202) return undefined as T;
    const text = await res.text();
    let j: J = {};
    try { j = text ? JSON.parse(text) : {}; } catch { j = {}; }
    if (!res.ok) {
      const reason = j?.error?.reason;
      const msg = j?.error?.message || res.statusText;
      if (res.status === 403 && /not registered|user may not be registered|allowlist/i.test(msg)) {
        throw new AuthError('Bu Spotify hesabı uygulamanın izin listesinde değil. Geliştirici panelinde Users Management bölümünden ekleyin.');
      }
      throw new ApiError(msg, res.status, reason);
    }
    return j as T;
  }

  async me(): Promise<Account> {
    const j = await this.request('/me');
    this.meId = j.id;
    return { provider: 'spotify', name: j.display_name || j.id, image: pickImage(j.images, 64), product: j.product };
  }

  async playlists(url = '/me/playlists?limit=50'): Promise<Page<Collection>> {
    if (!this.meId) await this.me().catch(() => undefined);
    const j = await this.request(url);
    const items: Collection[] = (j.items || []).filter(Boolean).map((p: J) => {
      const owned = p.owner?.id === this.meId || !!p.collaborative;
      const count = p.items?.total ?? p.tracks?.total;
      return {
        provider: 'spotify', kind: 'playlist', id: p.id, title: p.name,
        subtitle: `${p.owner?.display_name || ''}${count != null ? ` · ${count} parça` : ''}`,
        image: pickImage(p.images, 300), contextUri: p.uri, url: p.external_urls?.spotify, readable: owned, count,
      } satisfies Collection;
    });
    return { items, next: j.next, total: j.total };
  }

  async savedAlbums(url = '/me/albums?limit=50'): Promise<Page<Collection>> {
    const j = await this.request(url);
    const items: Collection[] = (j.items || []).map((x: J) => x.album).filter(Boolean).map((a: J) => ({
      provider: 'spotify', kind: 'album', id: a.id, title: a.name,
      subtitle: (a.artists || []).map((r: J) => r.name).join(', '),
      image: pickImage(a.images, 300), contextUri: a.uri, url: a.external_urls?.spotify, readable: true, count: a.total_tracks,
    }));
    return { items, next: j.next, total: j.total };
  }

  /** Liste içeriği (yeni /items uç noktası; eski yanıt biçimine de dayanıklı). */
  async playlistTracks(id: string, url?: string): Promise<Page<Track>> {
    let j: J;
    try {
      j = await this.request(url || `/playlists/${encodeURIComponent(id)}/items?limit=100&additional_types=track`);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
        return { items: [], next: null, notice: 'Spotify yalnızca sizin oluşturduğunuz ya da ortak düzenlediğiniz listelerin içeriğini paylaşıyor. Bu listeyi bütün olarak çalabilirsiniz.' };
      }
      throw e;
    }
    const items = (j.items || []).map((x: J) => toTrack(x.item ?? x.track)).filter(Boolean) as Track[];
    return { items, next: j.next, total: j.total };
  }

  async albumTracks(id: string, album: Collection): Promise<Page<Track>> {
    const j = await this.request(`/albums/${encodeURIComponent(id)}/tracks?limit=50`);
    const items = (j.items || []).map((t: J) => toTrack({ ...t, type: 'track', album: { name: album.title, images: album.image ? [{ url: album.image }] : [] } })).filter(Boolean) as Track[];
    return { items, next: j.next, total: j.total };
  }

  /** Beğenilen şarkılar. Uç nokta kapatılmışsa boş + bilgi döner (bütün olarak çalınabilir). */
  async likedTracks(url = '/me/tracks?limit=50'): Promise<Page<Track>> {
    try {
      const j = await this.request(url);
      return { items: (j.items || []).map((x: J) => toTrack(x.track ?? x.item)).filter(Boolean) as Track[], next: j.next, total: j.total };
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404 || e.status === 410)) {
        return { items: [], next: null, notice: 'Beğenilen şarkıların listesi Spotify tarafından paylaşılmıyor; koleksiyonu bütün olarak çalabilirsiniz.' };
      }
      throw e;
    }
  }

  likedCollection(): Collection {
    return {
      provider: 'spotify', kind: 'liked', id: 'liked', title: 'Beğenilen Şarkılar', subtitle: 'Spotify',
      contextUri: this.meId ? `spotify:user:${this.meId}:collection` : undefined, readable: true,
      url: 'https://open.spotify.com/collection/tracks',
    };
  }

  async recentTracks(): Promise<Page<Track>> {
    const j = await this.request('/me/player/recently-played?limit=50');
    const seen = new Set<string>();
    const items: Track[] = [];
    for (const x of j.items || []) {
      const t = toTrack(x.track);
      if (t && !seen.has(t.uri)) { seen.add(t.uri); items.push(t); }
    }
    return { items, next: null };
  }

  /** Arama: geliştirme modunda sayfa başına en fazla 10 sonuç. */
  async search(q: string): Promise<{ tracks: Track[]; playlists: Collection[]; albums: Collection[] }> {
    const p = new URLSearchParams({ q, type: 'track,album,playlist', limit: '10' });
    const j = await this.request(`/search?${p}`);
    const tracks = (j.tracks?.items || []).map(toTrack).filter(Boolean) as Track[];
    const albums: Collection[] = (j.albums?.items || []).filter(Boolean).map((a: J) => ({
      provider: 'spotify', kind: 'album', id: a.id, title: a.name, subtitle: (a.artists || []).map((r: J) => r.name).join(', '),
      image: pickImage(a.images, 300), contextUri: a.uri, url: a.external_urls?.spotify, readable: true,
    }));
    const playlists: Collection[] = (j.playlists?.items || []).filter(Boolean).map((p: J) => ({
      provider: 'spotify', kind: 'playlist', id: p.id, title: p.name, subtitle: p.owner?.display_name || '',
      image: pickImage(p.images, 300), contextUri: p.uri, url: p.external_urls?.spotify, readable: p.owner?.id === this.meId,
    }));
    return { tracks, playlists, albums };
  }

  // ---------- oynatma (Connect) ----------
  async devices(): Promise<{ id: string; name: string; type: string; active: boolean }[]> {
    const j = await this.request('/me/player/devices');
    return (j.devices || []).filter((d: J) => d.id && !d.is_restricted).map((d: J) => ({ id: d.id, name: d.name, type: d.type, active: d.is_active }));
  }

  async play(deviceId: string | null, body: { context_uri?: string; uris?: string[]; offset?: { uri?: string; position?: number } }): Promise<void> {
    const q = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
    await this.request(`/me/player/play${q}`, { method: 'PUT', body: JSON.stringify(body) });
  }

  async transfer(deviceId: string, play: boolean): Promise<void> {
    await this.request('/me/player', { method: 'PUT', body: JSON.stringify({ device_ids: [deviceId], play }) });
  }

  async pause(deviceId?: string): Promise<void> { await this.request(`/me/player/pause${deviceId ? `?device_id=${deviceId}` : ''}`, { method: 'PUT' }); }
  async resume(deviceId?: string): Promise<void> { await this.request(`/me/player/play${deviceId ? `?device_id=${deviceId}` : ''}`, { method: 'PUT' }); }
  async next(): Promise<void> { await this.request('/me/player/next', { method: 'POST' }); }
  async previous(): Promise<void> { await this.request('/me/player/previous', { method: 'POST' }); }
  async seek(ms: number): Promise<void> { await this.request(`/me/player/seek?position_ms=${Math.max(0, Math.round(ms))}`, { method: 'PUT' }); }

  async playbackState(): Promise<J | null> {
    const j = await this.request('/me/player?additional_types=track');
    return j && j.item !== undefined ? j : null;
  }
}
