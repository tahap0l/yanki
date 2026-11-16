import type { SceneFrame } from './types';

/**
 * Yıldız Tozu akış yönü: güvenilir ölçü başlarında yeni bir yön seçilir ve
 * yumuşakça ona dönülür. Ölçü başı yoksa güçlü vuruşlar ya da zaman yönlendirir.
 */
export class FlowDirector {
  dir: [number, number, number] = [0.6, 0.15, -0.3];
  strength = 0.3;
  private target: [number, number, number] = [0.6, 0.15, -0.3];
  private seed = 7;
  private beatsSince = 0;
  private idle = 0;
  private turn = 0;

  private rnd(): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  private pick(): void {
    // önceki yönden 50-130° dön; ekrana göre yatay ağırlıklı
    const cur = Math.atan2(this.target[1], this.target[0]);
    const sgn = this.rnd() < 0.5 ? -1 : 1;
    const a = cur + sgn * (0.9 + this.rnd() * 1.4);
    const z = (this.rnd() - 0.5) * 0.8;
    const v: [number, number, number] = [Math.cos(a), Math.sin(a) * 0.7, z];
    const l = Math.hypot(...v);
    this.target = [v[0] / l, v[1] / l, v[2] / l];
    this.turn = 1;
  }

  update(f: SceneFrame): void {
    this.idle += f.dt;
    let push = 0;
    if (f.downbeat) { this.pick(); push = 1; this.beatsSince = 0; this.idle = 0; }
    for (const b of f.beats) {
      this.beatsSince++;
      // ölçü başı bilgisi yoksa: her ~8 vuruşta bir yön değişimi
      if (f.sync < 0.5 && this.beatsSince >= 8) { this.pick(); push = 0.6; this.beatsSince = 0; this.idle = 0; }
      push = Math.max(push, b.strength * 0.35);
    }
    if (this.idle > (f.mode === 'ambient' ? 9 : 14)) { this.pick(); this.idle = 0; push = 0.4; }
    const rm = f.reducedMotion ? 0.4 : 1;
    const k = 1 - Math.exp(-f.dt / (f.reducedMotion ? 3 : 1.3));
    for (let i = 0; i < 3; i++) this.dir[i] += (this.target[i] - this.dir[i]) * k;
    const l = Math.hypot(...this.dir) || 1;
    for (let i = 0; i < 3; i++) this.dir[i] /= l;
    const base = (0.18 + 0.45 * f.energy) * rm;
    this.strength += (base + push * 0.5 * f.intensity * rm - this.strength) * (1 - Math.exp(-f.dt / (push ? 0.12 : 0.9)));
    this.turn *= Math.exp(-f.dt / 1.5);
  }
}
