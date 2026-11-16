import type { Quality, SceneFrame, SceneRenderer } from '../types';
import { css, paletteAt } from '../palettes';
import { RippleField } from '../ripples';
import { FlowDirector } from '../flow';

function hash(n: number): number { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); }
function noise1(x: number): number {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return hash(i) * (1 - u) + hash(i + 1) * u;
}
function fbm1(x: number): number { return 0.5 * noise1(x) + 0.25 * noise1(x * 2.1 + 3.3) + 0.125 * noise1(x * 4.3 + 7.7); }

abstract class Base2D implements SceneRenderer {
  abstract readonly id: SceneRenderer['id'];
  protected w = 1; protected h = 1;
  protected stars: { x: number; y: number; r: number; p: number }[] = [];
  constructor(protected ctx: CanvasRenderingContext2D) {
    for (let i = 0; i < 160; i++) this.stars.push({ x: hash(i * 3.1), y: hash(i * 7.7), r: 0.4 + hash(i * 1.3) * 1.1, p: hash(i * 9.9) * 6.28 });
  }
  resize(w: number, h: number): void { this.w = w; this.h = h; }
  abstract render(f: SceneFrame, q: Quality): void;
  dispose(): void {}
  protected sky(f: SceneFrame, horizon: number): void {
    const pal = paletteAt(f.paletteFrom, f.paletteTo, f.paletteMix);
    const g = this.ctx.createLinearGradient(0, 0, 0, this.h * horizon);
    g.addColorStop(0, css(pal.skyTop));
    g.addColorStop(1, css(pal.skyLow));
    this.ctx.fillStyle = g;
    this.ctx.fillRect(0, 0, this.w, this.h);
    const c = this.ctx;
    for (const s of this.stars) {
      if (s.y > horizon * 0.95) continue;
      c.globalAlpha = (0.35 + 0.3 * Math.sin(f.time * 1.3 + s.p)) * (1 - 0.3 * f.hush);
      c.fillStyle = '#dfe8ff';
      c.fillRect(s.x * this.w, s.y * this.h, s.r, s.r);
    }
    c.globalAlpha = 1;
  }
}

export class Moonlight2D extends Base2D {
  readonly id = 'moonlight' as const;
  private ripples = new RippleField(12);
  render(f: SceneFrame): void {
    const c = this.ctx, W = this.w, H = this.h;
    const hz = 0.42;
    this.ripples.update(f);
    this.sky(f, hz);
    const pal = paletteAt(f.paletteFrom, f.paletteTo, f.paletteMix);
    const mx = W * 0.62, my = H * 0.17, mr = Math.min(W, H) * 0.045;
    const glow = 1 + 0.5 * f.beatPulse * f.sync * f.intensity + 0.3 * f.energy;
    const hr = mr * 7 * Math.min(1.4, glow);
    const halo = c.createRadialGradient(mx, my, mr * 0.8, mx, my, hr);
    halo.addColorStop(0, 'rgba(255,245,225,0.22)');
    halo.addColorStop(0.35, 'rgba(255,245,225,0.07)');
    halo.addColorStop(1, 'rgba(255,245,225,0)');
    c.save();
    c.beginPath(); c.rect(0, 0, W, H * hz); c.clip();
    c.fillStyle = halo;
    c.beginPath(); c.arc(mx, my, hr, 0, Math.PI * 2); c.fill();
    c.restore();
    c.fillStyle = '#f4eee0';
    c.beginPath(); c.arc(mx, my, mr, 0, Math.PI * 2); c.fill();
    // su
    const wg = c.createLinearGradient(0, H * hz, 0, H);
    wg.addColorStop(0, css(pal.skyLow, 1, 0.9));
    wg.addColorStop(1, css(pal.skyTop, 1, 0.6));
    c.fillStyle = wg;
    c.fillRect(0, H * hz, W, H * (1 - hz));
    // ay yolu: titreyen yatay parıltılar
    c.globalCompositeOperation = 'lighter';
    const rows = 70;
    for (let i = 0; i < rows; i++) {
      const v = i / rows;
      const y = H * hz + Math.pow(v, 1.6) * H * (1 - hz);
      const persp = 0.15 + v * 1.2;
      let disp = 0;
      for (const r of this.ripples.list) {
        const age = f.time - r.t0;
        const rz = 1 - (r.z - 3) / 9.5;
        disp += r.amp * 14 * Math.exp(-age * 0.5) * Math.sin((v - rz) * 40 - age * 6) * Math.exp(-((v - rz) ** 2) * 30);
      }
      const jitter = (noise1(i * 1.7 + f.time * (1.5 + 3 * f.treble)) - 0.5) * 30 * persp * (0.4 + f.treble * f.intensity);
      const len = (20 + 90 * persp) * (0.6 + 0.4 * noise1(i * 3.1 + f.time));
      c.globalAlpha = 0.18 * (1 - v * 0.5) * (0.7 + 0.3 * glow);
      c.fillStyle = '#fff2d8';
      c.fillRect(mx + jitter + disp * persp - len / 2, y, len, 1 + persp * 1.5);
    }
    // halkalar: perspektif elipsler
    for (const r of this.ripples.list) {
      const age = f.time - r.t0;
      if (age < 0) continue;
      const v = 1 - (r.z - 3) / 9.5;
      const cy = H * hz + Math.pow(Math.max(0.02, v), 1.6) * H * (1 - hz);
      const cx = W * 0.5 + (r.x / r.z) * W * 0.55;
      const rad = age * 1.05 * (W * 0.12) / r.z * 3;
      c.globalAlpha = Math.min(1, r.amp * 6) * Math.exp(-age * 0.55) * Math.min(1, age * 3) * 0.6;
      c.strokeStyle = css(pal.b, 1, 1.6);
      c.lineWidth = 1.2;
      c.beginPath();
      c.ellipse(cx, cy, rad, rad * (0.12 + v * 0.18), 0, 0, Math.PI * 2);
      c.stroke();
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    if (f.hush > 0.01) { c.fillStyle = `rgba(0,0,0,${0.25 * f.hush})`; c.fillRect(0, 0, W, H); }
  }
}

export class Aurora2D extends Base2D {
  readonly id = 'aurora' as const;
  private flow = 0; private curl = 0.4;
  render(f: SceneFrame, q: Quality): void {
    const c = this.ctx, W = this.w, H = this.h;
    this.sky(f, 1);
    const pal = paletteAt(f.paletteFrom, f.paletteTo, f.paletteMix);
    const rm = f.reducedMotion ? 0.35 : 1;
    this.flow += f.dt * rm * (0.5 + 1.2 * f.energy + 0.6 * f.treble);
    const target = Math.min(1.2, 0.15 + 0.7 * f.mid + 0.6 * Math.max(0, f.melody - 0.25)) * f.intensity;
    this.curl += (target - this.curl) * (1 - Math.exp(-f.dt / 0.9));
    const gain = (0.5 + 0.55 * f.energy + 0.18 * f.beatPulse * f.sync) * (0.5 + 0.5 * f.intensity) * (1 - 0.3 * f.hush);
    c.globalCompositeOperation = 'lighter';
    const step = Math.max(3, Math.round(6 / q.scale));
    const layers = q.level >= 3 ? 2 : 3;
    for (let L = 0; L < layers; L++) {
      const height = H * (0.16 + 0.12 * f.sectionEnergy) * (0.85 + 0.25 * L);
      for (let x = 0; x < W; x += step) {
        const u = (x / H) * (0.85 + 0.18 * L) + L * 2.3;
        const bend = fbm1(u * 0.55 + this.flow * 0.05 + L * 4.1) - 0.5;
        const fold = Math.sin(u * (2.2 + 1.4 * this.curl) + this.flow * 0.18 + fbm1(u * 1.3 + this.flow * 0.07) * 3);
        const base = 0.52 + 0.09 * L + bend * (0.22 + 0.28 * this.curl) + fold * 0.035 * (0.5 + this.curl);
        const y = H * (1 - base);
        const ray = 0.45 + 0.55 * noise1(u * 26 + this.flow * 0.35 * (1 + f.treble));
        const g = c.createLinearGradient(0, y, 0, y - height);
        g.addColorStop(0, css(pal.a, 0.5 * ray * gain));
        g.addColorStop(0.5, css(pal.b, 0.18 * ray * gain));
        g.addColorStop(1, css(pal.c, 0));
        c.fillStyle = g;
        c.fillRect(x, y - height, step + 0.5, height + 4);
      }
    }
    c.globalCompositeOperation = 'source-over';
    // dağlar
    c.fillStyle = css(pal.skyLow, 1, 0.12);
    c.beginPath();
    c.moveTo(0, H);
    for (let x = 0; x <= W; x += 8) c.lineTo(x, H * (1 - (0.16 + 0.1 * fbm1((x / H) * 1.6) + 0.05 * fbm1((x / H) * 5)))) ;
    c.lineTo(W, H);
    c.fill();
  }
}

export class Stardust2D extends Base2D {
  readonly id = 'stardust' as const;
  private flow = new FlowDirector();
  private n = 1800;
  private p = new Float32Array(this.n * 3);
  private v = new Float32Array(this.n * 3);
  private seed = new Float32Array(this.n);
  private depth = 5;
  constructor(ctx: CanvasRenderingContext2D) {
    super(ctx);
    for (let i = 0; i < this.n; i++) {
      this.p[i * 3] = (hash(i * 1.1) * 2 - 1) * 1.15; this.p[i * 3 + 1] = (hash(i * 2.3) * 2 - 1) * 1.15; this.p[i * 3 + 2] = -hash(i * 3.7) * 8;
      this.seed[i] = hash(i * 5.9);
    }
  }
  render(f: SceneFrame, q: Quality): void {
    const c = this.ctx, W = this.w, H = this.h;
    const pal = paletteAt(f.paletteFrom, f.paletteTo, f.paletteMix);
    this.flow.update(f);
    this.depth += (3 + 8 * f.energy - this.depth) * (1 - Math.exp(-f.dt / 1.8));
    // iz: yarı saydam boyama
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = css(pal.skyTop, f.reducedMotion ? 0.5 : 0.28);
    c.fillRect(0, 0, W, H);
    c.globalCompositeOperation = 'lighter';
    const count = Math.floor(this.n * q.particles * (0.35 + 0.65 * Math.min(1, f.energy + 0.2)));
    const dt = Math.min(0.05, f.dt), fd = this.flow.dir, fs = this.flow.strength;
    const turb = (0.12 + 0.25 * f.mid) * (f.reducedMotion ? 0.4 : 1);
    const focal = 1.0 + 0.06 * f.energy;
    const pulse = (f.beatPulse * 0.6 + f.barPulse * 0.4) * f.sync * f.intensity;
    const cols = [css(pal.a, 0.7), css(pal.b, 0.7), css(pal.c, 0.7)];
    const t = f.time;
    for (let i = 0; i < count; i++) {
      const j = i * 3, s = this.seed[i];
      let x = this.p[j], y = this.p[j + 1], z = this.p[j + 2];
      const tx = fd[0] * fs * (0.55 + 0.9 * s) + (Math.sin(y * 1.36 + t * 0.31) + Math.sin(z * 0.88 - t * 0.17)) * 0.5 * turb;
      const ty = fd[1] * fs * (0.55 + 0.9 * s) + (Math.sin(z * 1.2 - t * 0.23) + Math.sin(x * 1.04 + t * 0.13)) * 0.5 * turb;
      const tz = fd[2] * fs * (0.55 + 0.9 * s) + (Math.sin(x * 1.52 + t * 0.27) + Math.sin(y * 0.72 - t * 0.21)) * 0.5 * turb;
      const kk = Math.min(1, dt * (1 + 1.5 * s));
      this.v[j] += (tx - this.v[j]) * kk; this.v[j + 1] += (ty - this.v[j + 1]) * kk; this.v[j + 2] += (tz - this.v[j + 2]) * kk;
      const d = Math.max(0.3, 1.6 - z);
      x += (this.v[j] + x * this.v[j + 2]) / d * dt; y += (this.v[j + 1] + y * this.v[j + 2]) / d * dt; z += this.v[j + 2] * dt;
      if (x > 1.15) x -= 2.3; else if (x < -1.15) x += 2.3;
      if (y > 1.15) y -= 2.3; else if (y < -1.15) y += 2.3;
      if (z > 0.9) z -= this.depth + 0.9; else if (z < -this.depth) z += this.depth + 0.9;
      this.p[j] = x; this.p[j + 1] = y; this.p[j + 2] = z;
      const sx = (x * focal * 0.5 + 0.5) * W, sy = (0.5 - y * focal * 0.5) * H;
      const big = Math.pow(s, 8);
      const size = Math.min(7, (1.0 + 1.6 * s + 5 * big) * (1 + 0.35 * pulse) / d * (H / 600));
      c.globalAlpha = Math.min(1, (0.35 / d + 0.08) * (1 + 2 * big));
      c.fillStyle = cols[i % 3];
      c.fillRect(sx, sy, size, size);
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
  }
}
