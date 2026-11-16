import type { SceneFrame } from './types';

interface Ripple { x: number; z: number; t0: number; amp: number }

/** Bas vuruşlarından su yüzeyi halkaları üretir (WebGL ve Canvas 2D ortak). */
export class RippleField {
  readonly list: Ripple[] = [];
  private seed = 1;
  private cooldown = 0;
  constructor(private max: number) {}

  private rnd(): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  update(f: SceneFrame): void {
    this.cooldown -= f.dt;
    const minGap = f.reducedMotion ? 0.9 : 0.12;
    for (const b of f.beats) {
      if (b.bass < 0.12 || this.cooldown > 0) continue;
      const amp = (0.05 + 0.16 * Math.min(1, b.bass)) * f.intensity * (f.reducedMotion ? 0.45 : 1) * (1 - 0.6 * f.hush);
      if (amp < 0.01) continue;
      // ay yolunun çevresinde, görüş alanında
      const z = 3.2 + this.rnd() * 9;
      const x = (this.rnd() - 0.5) * z * 0.9 + z * 0.22;
      this.list.push({ x, z, t0: f.time, amp });
      this.cooldown = minGap;
      if (this.list.length > this.max) this.list.shift();
    }
    while (this.list.length && f.time - this.list[0].t0 > 7) this.list.shift();
  }

  pack(out: Float32Array): number {
    const n = Math.min(this.list.length, out.length / 4);
    for (let i = 0; i < n; i++) {
      const r = this.list[this.list.length - n + i];
      out[i * 4] = r.x; out[i * 4 + 1] = r.z; out[i * 4 + 2] = r.t0; out[i * 4 + 3] = r.amp;
    }
    return n;
  }
}
