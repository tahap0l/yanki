import { ServiceConfig } from '../config';
import { AuthError } from '../types';

/**
 * Spotify Authorization Code + PKCE (istemci sırrı yok, tarayıcıya uygun).
 * Belirteçler yalnız bu cihazda (localStorage) tutulur.
 */
export const SPOTIFY_SCOPES = [
  'user-read-private',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
  'user-read-recently-played',
  'streaming',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
];

const TOKEN_KEY = 'yanki.spotify.token';
const PKCE_KEY = 'yanki.spotify.pkce';
const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

interface Token { access: string; refresh: string; expiresAt: number; scope: string }

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomString(n: number): string {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return b64url(a);
}
async function challenge(verifier: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(d));
}

export class SpotifyAuth {
  private token: Token | null = null;
  private refreshing: Promise<string> | null = null;

  constructor() {
    try { this.token = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null'); } catch { this.token = null; }
  }

  get connected(): boolean { return !!this.token?.refresh || (!!this.token && this.token.expiresAt > Date.now()); }
  get configured(): boolean { return !!ServiceConfig.spotifyClientId; }

  /** Spotify giriş sayfasına yönlendirir. */
  async login(): Promise<void> {
    const clientId = ServiceConfig.spotifyClientId;
    if (!clientId) throw new AuthError('Spotify istemci kimliği girilmemiş.');
    if (!crypto?.subtle) throw new AuthError('Güvenli bağlantı (HTTPS) gerekli.');
    const verifier = randomString(64);
    const state = randomString(16);
    sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state, redirect: ServiceConfig.redirectUri }));
    const u = new URL(AUTH_URL);
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('redirect_uri', ServiceConfig.redirectUri);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('code_challenge', await challenge(verifier));
    u.searchParams.set('scope', SPOTIFY_SCOPES.join(' '));
    u.searchParams.set('state', state);
    location.assign(u.toString());
  }

  /**
   * Sayfa açılışında: Spotify'dan dönüşse kodu belirteçle değiştirir.
   * Döner: 'connected' | 'error:<mesaj>' | null (dönüş yok)
   */
  async handleRedirect(): Promise<string | null> {
    const q = new URLSearchParams(location.search);
    const state = q.get('state');
    let pk: { verifier: string; state: string; redirect: string } | null = null;
    try { pk = JSON.parse(sessionStorage.getItem(PKCE_KEY) || 'null'); } catch { pk = null; }
    if (!state || !pk || pk.state !== state) return null;
    sessionStorage.removeItem(PKCE_KEY);
    const clean = () => history.replaceState(null, '', location.pathname + location.hash);
    const err = q.get('error');
    if (err) { clean(); return err === 'access_denied' ? 'error:Spotify erişimine izin verilmedi.' : `error:Spotify girişi başarısız (${err}).`; }
    const code = q.get('code');
    clean();
    if (!code) return 'error:Spotify yanıtında kod yok.';
    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: pk.redirect,
        client_id: ServiceConfig.spotifyClientId, code_verifier: pk.verifier,
      });
      await this.tokenRequest(body);
      return 'connected';
    } catch (e) {
      return 'error:' + (e instanceof Error ? e.message : 'Belirteç alınamadı.');
    }
  }

  private async tokenRequest(body: URLSearchParams): Promise<string> {
    const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (j.error === 'invalid_grant') { this.logout(); throw new AuthError('Spotify oturumu sona erdi; yeniden bağlanın.'); }
      throw new AuthError(j.error_description || `Spotify belirteç hatası (${res.status})`);
    }
    this.token = {
      access: j.access_token,
      refresh: j.refresh_token || this.token?.refresh || '',
      expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000 - 60_000,
      scope: j.scope || '',
    };
    try { localStorage.setItem(TOKEN_KEY, JSON.stringify(this.token)); } catch { /* yoksay */ }
    return this.token.access;
  }

  /** Geçerli erişim belirteci; gerekirse yeniler. */
  async accessToken(): Promise<string> {
    if (!this.token) throw new AuthError('Spotify bağlı değil.');
    if (this.token.expiresAt > Date.now()) return this.token.access;
    if (!this.token.refresh) { this.logout(); throw new AuthError('Spotify oturumu sona erdi; yeniden bağlanın.'); }
    if (!this.refreshing) {
      this.refreshing = this.tokenRequest(new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: this.token.refresh, client_id: ServiceConfig.spotifyClientId,
      })).finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  /** Belirteci süresi dolmuş say (401 sonrası). */
  invalidate(): void { if (this.token) this.token.expiresAt = 0; }

  logout(): void {
    this.token = null;
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* yoksay */ }
  }
}
