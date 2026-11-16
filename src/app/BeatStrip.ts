import type { Alignment } from '../analysis/cache';
import type { AnalysisResult } from '../analysis/types';
import { PALETTES, css } from '../scenes/palettes';

/** Konum çubuğunun altında bölümleri, vuruşları ve güveni gösteren ince şerit. */
export class BeatStrip {
  private r: AnalysisResult | null = null;
  private dur = 0;
  private a: Alignment = { offsetMs: 0, tempoFactor: 1 };
  constructor(private canvas: HTMLCanvasElement) {}

  set(r: AnalysisResult | null, duration: number, a?: Alignment): void {
    this.r = r; this.dur = duration; if (a) this.a = a;
    this.redraw();
  }

  redraw(): void {
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, w, h);
    const r = this.r, d = this.dur;
    if (!r || !(d > 0)) return;
    const X = (t: number) => (t / d) * w;
    // bölümler
    for (const s of r.structure?.sections || []) {
      const p = PALETTES[s.palette % PALETTES.length];
      g.fillStyle = css(p.a, 0.10 + 0.14 * s.energy);
      g.fillRect(X(s.start), h * 0.3, Math.max(1, X(s.end) - X(s.start) - 1), h * 0.4);
    }
    // vuruşlar
    const rh = r.rhythm;
    if (rh) {
      const off = this.a.offsetMs / 1000;
      const down = new Set(Array.from(rh.downbeats, (t) => Math.round(t * 1000)));
      const step = rh.beats.length > w / (2 * dpr) ? Math.ceil(rh.beats.length / (w / (2 * dpr))) : 1;
      for (let i = 0; i < rh.beats.length; i += step) {
        const t = rh.beats[i] + off, conf = rh.beatConfidence[i];
        const isDown = down.has(Math.round(rh.beats[i] * 1000));
        g.fillStyle = conf >= 0.5 ? `rgba(200,255,225,${0.25 + 0.45 * conf})` : `rgba(255,213,154,${0.25 + 0.3 * conf})`;
        const bh = isDown ? h : h * 0.45;
        g.fillRect(X(t), (h - bh) / 2, Math.max(1, dpr * 0.8), bh);
      }
    } else {
      // yalnız enerji: dalga biçimi
      const e = r.energy.rms;
      g.fillStyle = 'rgba(255,255,255,0.22)';
      for (let x = 0; x < w; x += 2 * dpr) {
        const v = e[Math.floor((x / w) * e.length)] || 0;
        g.fillRect(x, h / 2 - (v * h) / 2, dpr, v * h);
      }
    }
  }
}
