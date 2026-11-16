/**
 * Geliştirici uygulama kimlikleri. Derleme zamanında .env ile verilebilir
 * (VITE_SPOTIFY_CLIENT_ID, VITE_GOOGLE_CLIENT_ID) ya da Ayarlar'dan girilir.
 * Kimlikler gizli değildir (PKCE / tarayıcı OAuth istemcisi); sır kullanılmaz.
 */
const KEY = 'yanki.services.v1';

interface Stored { spotifyClientId?: string; googleClientId?: string }

function read(): Stored {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') as Stored; } catch { return {}; }
}

export const ServiceConfig = {
  get spotifyClientId(): string {
    return (read().spotifyClientId || import.meta.env.VITE_SPOTIFY_CLIENT_ID || '').trim();
  },
  get googleClientId(): string {
    return (read().googleClientId || import.meta.env.VITE_GOOGLE_CLIENT_ID || '').trim();
  },
  set(values: Stored): void {
    try { localStorage.setItem(KEY, JSON.stringify({ ...read(), ...values })); } catch { /* yoksay */ }
  },
  /** OAuth yönlendirme adresi: uygulamanın kendi adresi (sorgu ve parça olmadan) */
  get redirectUri(): string {
    return location.origin + location.pathname;
  },
};
