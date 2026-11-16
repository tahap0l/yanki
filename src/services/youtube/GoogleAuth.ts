import { ServiceConfig } from '../config';
import { AuthError } from '../types';

/**
 * Google Identity Services belirteç istemcisi (yalnız okuma: youtube.readonly).
 * Erişim belirteci yalnız bellekte ve bu oturumda tutulur; yenilemede sessiz istem kullanılır.
 */
interface TokenResponse { access_token?: string; expires_in?: number; error?: string; error_description?: string }
interface TokenClient { requestAccessToken(o?: { prompt?: string; hint?: string }): void; callback: (r: TokenResponse) => void }
declare global {
  interface Window {
    google?: { accounts: { oauth2: {
      initTokenClient(o: { client_id: string; scope: string; callback: (r: TokenResponse) => void; error_callback?: (e: { type: string; message?: string }) => void }): TokenClient;
      revoke(token: string, cb?: () => void): void;
    } } };
  }
}

const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const SESSION_KEY = 'yanki.google.token';
const HINT_KEY = 'yanki.google.connected';

let gisPromise: Promise<void> | null = null;
function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => (window.google?.accounts?.oauth2 ? resolve() : reject(new Error('Google girişi yüklenemedi.')));
    s.onerror = () => { gisPromise = null; reject(new Error('Google girişi yüklenemedi.')); };
    document.head.appendChild(s);
  });
  return gisPromise;
}

export class GoogleAuth {
  private token: { access: string; expiresAt: number } | null = null;
  private client: TokenClient | null = null;
  private pending: { resolve: (t: string) => void; reject: (e: Error) => void } | null = null;

  constructor() {
    try {
      const t = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
      if (t && t.expiresAt > Date.now()) this.token = t;
    } catch { /* yoksay */ }
  }

  get configured(): boolean { return !!ServiceConfig.googleClientId; }
  /** Daha önce bağlanmış mı (sessiz yenileme denenebilir) */
  get wasConnected(): boolean { try { return localStorage.getItem(HINT_KEY) === '1'; } catch { return false; } }
  get connected(): boolean { return !!this.token && this.token.expiresAt > Date.now(); }

  private async ensureClient(): Promise<TokenClient> {
    if (this.client) return this.client;
    if (!ServiceConfig.googleClientId) throw new AuthError('Google OAuth istemci kimliği girilmemiş.');
    await loadGis();
    this.client = window.google!.accounts.oauth2.initTokenClient({
      client_id: ServiceConfig.googleClientId,
      scope: SCOPE,
      callback: (r) => {
        const p = this.pending;
        this.pending = null;
        if (!p) return;
        if (r.error || !r.access_token) { p.reject(new AuthError(r.error === 'access_denied' ? 'YouTube erişimine izin verilmedi.' : `Google girişi başarısız (${r.error_description || r.error}).`)); return; }
        this.token = { access: r.access_token, expiresAt: Date.now() + (Number(r.expires_in) || 3600) * 1000 - 60_000 };
        try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(this.token)); localStorage.setItem(HINT_KEY, '1'); } catch { /* yoksay */ }
        p.resolve(r.access_token);
      },
      error_callback: (e) => {
        const p = this.pending;
        this.pending = null;
        p?.reject(new AuthError(e.type === 'popup_closed' ? 'Google giriş penceresi kapatıldı.' : e.type === 'popup_failed_to_open' ? 'Giriş penceresi açılamadı; açılır pencerelere izin verin.' : `Google girişi başarısız (${e.message || e.type}).`));
      },
    });
    return this.client;
  }

  /** Kullanıcı hareketiyle çağrılır: Google onay penceresi açılır. */
  async login(interactive = true): Promise<string> {
    const c = await this.ensureClient();
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      c.requestAccessToken({ prompt: interactive ? 'consent' : '' });
    });
  }

  async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.access;
    if (!this.wasConnected) throw new AuthError('YouTube bağlı değil.');
    // süre doldu: sessiz yenile (kullanıcı onayı hatırlanır)
    return this.login(false);
  }

  invalidate(): void { if (this.token) this.token.expiresAt = 0; }

  logout(): void {
    const t = this.token?.access;
    this.token = null;
    try { sessionStorage.removeItem(SESSION_KEY); localStorage.removeItem(HINT_KEY); } catch { /* yoksay */ }
    if (t && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(t);
  }
}
