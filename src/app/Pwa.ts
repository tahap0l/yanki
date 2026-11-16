/**
 * Yüklenebilir uygulama: service worker kaydı, güncelleme bildirimi ve
 * “Uygulamayı yükle” akışı (Chrome/Edge/Android istemi; iOS için Paylaş › Ana Ekrana Ekle).
 */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallState = 'installed' | 'prompt' | 'ios' | 'unsupported';

export class Pwa {
  private deferred: InstallPromptEvent | null = null;
  private waiting: ServiceWorker | null = null;
  onChange?: () => void;
  onUpdate?: () => void;
  onInstalled?: () => void;

  constructor() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferred = e as InstallPromptEvent;
      this.onChange?.();
    });
    window.addEventListener('appinstalled', () => {
      this.deferred = null;
      this.onChange?.();
      this.onInstalled?.();
    });
    matchMedia('(display-mode: standalone)').addEventListener?.('change', () => this.onChange?.());
  }

  /** Uygulama olarak (ana ekrandan) mı açıldı? */
  get standalone(): boolean {
    return matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches
      || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  }

  get isIos(): boolean {
    return /iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  get state(): InstallState {
    if (this.standalone) return 'installed';
    if (this.deferred) return 'prompt';
    if (this.isIos) return 'ios';
    return 'unsupported';
  }

  async install(): Promise<boolean> {
    const d = this.deferred;
    if (!d) return false;
    await d.prompt();
    const r = await d.userChoice;
    this.deferred = null;
    this.onChange?.();
    return r.outcome === 'accepted';
  }

  /** Yalnız üretim derlemesinde ve güvenli bağlamda. */
  async register(): Promise<void> {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator) || !isSecureContext) return;
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      const track = (w: ServiceWorker | null) => {
        if (!w) return;
        w.addEventListener('statechange', () => {
          // yeni sürüm hazır ve sayfa zaten bir SW tarafından yönetiliyorsa güncelleme var
          if (w.state === 'installed' && navigator.serviceWorker.controller) { this.waiting = w; this.onUpdate?.(); }
        });
      };
      if (reg.waiting && navigator.serviceWorker.controller) { this.waiting = reg.waiting; this.onUpdate?.(); }
      track(reg.installing);
      reg.addEventListener('updatefound', () => track(reg.installing));
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading) return;
        reloading = true;
        location.reload();
      });
      // uzun açık kalan uygulamada saatte bir güncelleme denetimi
      setInterval(() => { void reg.update().catch(() => undefined); }, 60 * 60 * 1000);
    } catch (e) {
      console.warn('Service worker kaydedilemedi', e);
    }
  }

  applyUpdate(): void {
    this.waiting?.postMessage('skipWaiting');
  }
}
