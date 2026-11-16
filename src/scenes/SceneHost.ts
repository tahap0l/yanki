import type { Quality, SceneFrame, SceneId, SceneRenderer } from './types';
import { MoonlightGL } from './webgl/MoonlightGL';
import { AuroraGL } from './webgl/AuroraGL';
import { StardustGL } from './webgl/StardustGL';
import { Aurora2D, Moonlight2D, Stardust2D } from './canvas2d/Scenes2D';

export type RendererPref = 'auto' | 'webgl2' | 'canvas2d';
export type ActiveBackend = 'webgl2' | 'canvas2d';

const LEVELS: Omit<Quality, 'level'>[] = [
  { scale: 1.0, particles: 1.0 },
  { scale: 0.85, particles: 0.75 },
  { scale: 0.7, particles: 0.55 },
  { scale: 0.58, particles: 0.4 },
  { scale: 0.47, particles: 0.28 },
  { scale: 0.38, particles: 0.18 },
  { scale: 0.3, particles: 0.12 },
];

export const isMobile = () => /Android|iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/**
 * Kare süresine göre çözünürlük ve parçacık sayısını uyarlar (histerezisli).
 */
export class QualityGovernor {
  level: number;
  private ema = 16.7;
  private slowFor = 0;
  private fastFor = 0;
  private cooldown = 0;
  readonly minLevel: number;
  /** ?quality=0..6 ile sabitlenmiş seviye (tanılama, ekran görüntüsü) */
  private pinned: number | null = null;
  constructor(mobile: boolean) {
    this.minLevel = 0;
    this.level = mobile ? 2 : 0;
    const q = new URLSearchParams(location.search).get('quality');
    if (q !== null && /^[0-6]$/.test(q)) { this.pinned = Number(q); this.level = this.pinned; }
  }
  get quality(): Quality { return { ...LEVELS[this.level], level: this.level }; }
  /** dt: ms. Döner: seviye değişti mi */
  sample(dtMs: number, budgetMs: number): boolean {
    if (dtMs <= 0 || dtMs > 250) return false; // sekme arka planı vb.
    if (this.pinned !== null) { this.ema += (dtMs - this.ema) * 0.08; return false; }
    this.ema += (dtMs - this.ema) * 0.08;
    this.cooldown -= dtMs;
    if (this.ema > budgetMs * 1.35) { this.slowFor += dtMs; this.fastFor = 0; }
    else if (this.ema < budgetMs * 1.08) { this.fastFor += dtMs; this.slowFor = 0; }
    else { this.slowFor = 0; this.fastFor = 0; }
    if (this.cooldown > 0) return false;
    if (this.slowFor > 900 && this.level < LEVELS.length - 1) { this.level++; this.reset(); return true; }
    if (this.fastFor > 6000 && this.level > this.minLevel) { this.level--; this.reset(); return true; }
    return false;
  }
  get frameMs(): number { return this.ema; }
  private reset(): void { this.slowFor = 0; this.fastFor = 0; this.cooldown = 2500; }
}

export class SceneHost {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private ctx2d: CanvasRenderingContext2D | null = null;
  private renderer: SceneRenderer | null = null;
  private sceneId: SceneId = 'moonlight';
  private pref: RendererPref = 'auto';
  backend: ActiveBackend = 'webgl2';
  readonly governor: QualityGovernor;
  private mobile = isMobile();
  private lost = false;
  private cssW = 1; private cssH = 1;
  private vsyncMs = 16.7;
  private intervals: number[] = [];
  onBackendChange?: (b: ActiveBackend, reason?: string) => void;

  constructor(private mount: HTMLElement) {
    this.governor = new QualityGovernor(this.mobile);
    this.canvas = this.makeCanvas();
    new ResizeObserver(() => this.measure()).observe(mount);
    this.measure();
  }

  private makeCanvas(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.className = 'scene-canvas';
    c.setAttribute('aria-hidden', 'true');
    this.mount.replaceChildren(c);
    return c;
  }

  private measure(): void {
    const r = this.mount.getBoundingClientRect();
    this.cssW = Math.max(1, r.width);
    this.cssH = Math.max(1, r.height);
    this.applySize();
  }

  private applySize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, this.mobile ? 2 : 2);
    const q = this.governor.quality;
    // Canvas 2D: daha düşük taban çözünürlük
    const base = this.backend === 'canvas2d' ? Math.min(dpr, 1.25) * 0.75 : dpr;
    const s = base * q.scale;
    const w = Math.max(1, Math.round(this.cssW * s)), h = Math.max(1, Math.round(this.cssH * s));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.renderer?.resize(w, h);
  }

  setPreference(p: RendererPref): void {
    if (p === this.pref && this.renderer) return;
    this.pref = p;
    this.rebuild();
  }

  setScene(id: SceneId): void {
    if (id === this.sceneId && this.renderer) return;
    this.sceneId = id;
    this.createRenderer();
  }

  get scene(): SceneId { return this.sceneId; }

  private rebuild(reason?: string): void {
    this.renderer?.dispose();
    this.renderer = null;
    this.gl = null;
    this.ctx2d = null;
    this.lost = false;
    this.canvas = this.makeCanvas();
    let backend: ActiveBackend = 'canvas2d';
    if (this.pref !== 'canvas2d') {
      const gl = this.canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: false, failIfMajorPerformanceCaveat: this.pref === 'auto' }) as WebGL2RenderingContext | null;
      if (gl) {
        this.gl = gl;
        backend = 'webgl2';
        this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; this.renderer = null; });
        this.canvas.addEventListener('webglcontextrestored', () => { this.lost = false; this.createRenderer(); });
      } else {
        reason = reason || 'WebGL 2 kullanılamıyor; Canvas 2D görünümüne geçildi.';
        // ayrı tuval: aynı tuvalde başka bağlam açılamaz
        this.canvas = this.makeCanvas();
      }
    }
    if (backend === 'canvas2d') this.ctx2d = this.canvas.getContext('2d', { alpha: false });
    this.backend = backend;
    this.applySize();
    this.createRenderer(reason);
  }

  private createRenderer(reason?: string): void {
    if (!this.gl && !this.ctx2d) return this.rebuild(reason);
    this.renderer?.dispose();
    this.renderer = null;
    try {
      if (this.gl) {
        const gl = this.gl;
        this.renderer = this.sceneId === 'moonlight' ? new MoonlightGL(gl) : this.sceneId === 'aurora' ? new AuroraGL(gl) : new StardustGL(gl, this.mobile);
      } else if (this.ctx2d) {
        const c = this.ctx2d;
        this.renderer = this.sceneId === 'moonlight' ? new Moonlight2D(c) : this.sceneId === 'aurora' ? new Aurora2D(c) : new Stardust2D(c);
      }
    } catch (e) {
      console.warn('Sahne oluşturulamadı, Canvas 2D’ye geçiliyor', e);
      if (this.backend === 'webgl2') {
        this.pref = 'canvas2d';
        return this.rebuild('GPU sahneyi çalıştıramadı; Canvas 2D görünümüne geçildi.');
      }
    }
    this.renderer?.resize(this.canvas.width, this.canvas.height);
    this.onBackendChange?.(this.backend, reason);
  }

  /** rAF aralıklarından ekran yenileme süresini tahmin eder (60/90/120 Hz). */
  private trackVsync(dtMs: number): void {
    this.intervals.push(dtMs);
    if (this.intervals.length > 90) this.intervals.shift();
    if (this.intervals.length >= 30) {
      const s = this.intervals.slice().sort((a, b) => a - b);
      const low = s[Math.floor(s.length * 0.1)];
      this.vsyncMs = Math.max(6.9, Math.min(16.7, low));
    }
  }

  render(f: SceneFrame, dtMs: number): void {
    if (!this.renderer && !this.lost) this.rebuild();
    if (!this.renderer) return;
    this.trackVsync(dtMs);
    // bütçe: 60 Hz'de 16.7 ms; yüksek yenilemeli ekranlarda en az 60 fps hedefle
    const budget = Math.max(this.vsyncMs, 16.7);
    if (this.governor.sample(dtMs, budget)) this.applySize();
    this.renderer.render(f, this.governor.quality);
  }

  get info(): { backend: ActiveBackend; level: number; frameMs: number; width: number; height: number } {
    return { backend: this.backend, level: this.governor.level, frameMs: this.governor.frameMs, width: this.canvas.width, height: this.canvas.height };
  }
}
