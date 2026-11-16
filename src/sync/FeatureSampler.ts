import type { Alignment } from '../analysis/cache';
import type { AnalysisResult, RhythmStage } from '../analysis/types';
import type { LiveLevels } from '../audio/AudioEngine';
import type { SceneFrame, SyncMode } from '../scenes/types';
import { emptyFrame } from '../scenes/types';

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/** a ≤ t olan son indeks (yoksa -1). */
function lastAtOrBefore(arr: ArrayLike<number>, t: number): number {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

function curveAt(c: Float32Array, fps: number, t: number): number {
  if (!c.length) return 0;
  const x = t * fps, i = Math.floor(x), f = x - i;
  if (i < 0) return c[0];
  if (i >= c.length - 1) return c[c.length - 1];
  return c[i] * (1 - f) + c[i + 1] * f;
}

/** Yumuşak başlayıp sönen darbe: önceden bilinen olayda hafif öne alınmış atak. */
function pulse(since: number, attack: number, decay: number): number {
  if (since < 0) return 0;
  if (since < attack) return smoothstep(0, attack, since);
  return Math.exp(-(since - attack) / decay);
}

interface EffBeats { t: Float32Array; conf: Float32Array; str: Float32Array; bass: Float32Array; down: Uint8Array }

/** Kullanıcı tempo çarpanını uygulayan etkin vuruş dizisi. */
function effectiveBeats(r: RhythmStage, factor: number): EffBeats {
  const n = r.beats.length;
  const downSet = new Set<number>();
  for (const d of r.downbeats) downSet.add(Math.round(d * 1000));
  const isDown = (t: number) => downSet.has(Math.round(t * 1000));
  if (factor === 0.5 && n > 2) {
    // daha güçlü evreyi seç
    let s0 = 0, s1 = 0;
    for (let i = 0; i < n; i++) (i % 2 ? (s1 += r.beatStrength[i] + r.beatBass[i]) : (s0 += r.beatStrength[i] + r.beatBass[i]));
    const ph = s1 > s0 ? 1 : 0;
    const idx: number[] = [];
    for (let i = ph; i < n; i += 2) idx.push(i);
    return {
      t: Float32Array.from(idx, (i) => r.beats[i]), conf: Float32Array.from(idx, (i) => r.beatConfidence[i]),
      str: Float32Array.from(idx, (i) => r.beatStrength[i]), bass: Float32Array.from(idx, (i) => r.beatBass[i]),
      down: Uint8Array.from(idx, (i) => (isDown(r.beats[i]) ? 1 : 0)),
    };
  }
  if (factor === 2 && n > 1) {
    const m = 2 * n - 1;
    const e: EffBeats = { t: new Float32Array(m), conf: new Float32Array(m), str: new Float32Array(m), bass: new Float32Array(m), down: new Uint8Array(m) };
    for (let i = 0; i < n; i++) {
      e.t[2 * i] = r.beats[i]; e.conf[2 * i] = r.beatConfidence[i]; e.str[2 * i] = r.beatStrength[i]; e.bass[2 * i] = r.beatBass[i];
      e.down[2 * i] = isDown(r.beats[i]) ? 1 : 0;
      if (i < n - 1) {
        e.t[2 * i + 1] = (r.beats[i] + r.beats[i + 1]) / 2;
        e.conf[2 * i + 1] = Math.min(r.beatConfidence[i], r.beatConfidence[i + 1]);
        e.str[2 * i + 1] = r.beatStrength[i] * 0.6; e.bass[2 * i + 1] = r.beatBass[i] * 0.5;
      }
    }
    return e;
  }
  return { t: r.beats, conf: r.beatConfidence, str: r.beatStrength, bass: r.beatBass, down: Uint8Array.from(r.beats, (t) => (isDown(t) ? 1 : 0)) };
}

/**
 * Analiz sonucu + oynatma konumu + anlık seviyeler → SceneFrame.
 * Kaynak türünden (dosya / ortam) bağımsızdır.
 */
export class FeatureSampler {
  private result: AnalysisResult | null = null;
  private eff: EffBeats | null = null;
  private alignment: Alignment = { offsetMs: 0, tempoFactor: 1 };
  private prevT = -1;
  private sceneTime = 0;
  private sm = { bass: 0, mid: 0, treble: 0, energy: 0, melody: 0.4, sync: 0, hush: 0 };
  private palette = { from: 0, to: 0, start: -1e9 };
  private lastSection = -1;
  private liveRiseCooldown = 0;
  private liveBeatEnv = 0;
  private lastSectionTime = 0;
  private ambientNextBeat = 0;
  private ambientBar = 0;
  /** akış kaynaklarında parçaya göre tema (ses analizi değil, parça kimliğinden) */
  private theme: { palette: number; pace: number } | null = null;
  readonly frame: SceneFrame = emptyFrame();

  setResult(r: AnalysisResult | null): void {
    this.result = r;
    this.eff = r?.rhythm ? effectiveBeats(r.rhythm, this.alignment.tempoFactor) : null;
  }
  setAlignment(a: Alignment): void {
    this.alignment = a;
    if (this.result?.rhythm) this.eff = effectiveBeats(this.result.rhythm, a.tempoFactor);
  }
  getAlignment(): Alignment { return this.alignment; }

  /** Vurulan zamanlara göre ofset önerir (ms). */
  suggestOffset(tapTimes: number[]): number | null {
    if (!this.eff || tapTimes.length < 4) return null;
    const diffs: number[] = [];
    for (const tap of tapTimes) {
      const tb = tap - this.alignment.offsetMs / 1000;
      const i = lastAtOrBefore(this.eff.t, tb);
      const cands = [this.eff.t[i], this.eff.t[i + 1]].filter((v) => v !== undefined);
      let best = Infinity;
      for (const c of cands) if (Math.abs(tb - c) < Math.abs(best)) best = tb - c;
      if (Number.isFinite(best)) diffs.push(best);
    }
    diffs.sort((a, b) => a - b);
    const med = diffs[diffs.length >> 1];
    return Math.round(this.alignment.offsetMs + med * 1000);
  }

  get rhythm(): RhythmStage | undefined { return this.result?.rhythm; }

  /** Yerel vuruş güveni (görüntüleme için). */
  localConfidence(t: number): number {
    if (!this.eff || !this.eff.t.length) return 0;
    const i = Math.max(0, lastAtOrBefore(this.eff.t, t));
    return this.eff.conf[i] ?? 0;
  }

  update(opts: {
    wallDt: number;
    musicTime: number | null; // null = ortam modu (kaynaktan bağımsız)
    playing: boolean;
    jumped: boolean;
    live: LiveLevels | null;
    intensity: number;
    reducedMotion: boolean;
  }): SceneFrame {
    const f = this.frame;
    const dt = Math.min(0.1, Math.max(0, opts.wallDt));
    const motion = opts.reducedMotion ? 0.35 : 1;
    this.sceneTime += dt * motion * (opts.playing || opts.musicTime === null ? 1 : 0.35);
    f.time = this.sceneTime;
    f.dt = dt;
    f.intensity = opts.intensity;
    f.reducedMotion = opts.reducedMotion;
    f.beats = [];
    f.onsets = [];
    f.downbeat = false;
    f.playing = opts.playing;
    const k = (tau: number) => 1 - Math.exp(-dt / tau);

    if (opts.musicTime === null) return this.ambient(f, dt, k);

    const res = this.result;
    const t = opts.musicTime - this.alignment.offsetMs / 1000;
    const advancing = opts.playing && !opts.jumped && this.prevT >= 0 && t >= this.prevT && t - this.prevT < 0.5;
    const live = opts.live;

    // --- enerji: önceden hesaplanmış eğri + anlık analizör karışımı
    let bass = live?.bass ?? 0, mid = live?.mid ?? 0, treble = live?.treble ?? 0, rms = live?.rms ?? 0, melody = 0.4;
    if (res) {
      const e = res.energy, fps = e.fps;
      const tl = t + 0.02; // hafif öngörü
      const pb = curveAt(e.bass, fps, tl), pm = curveAt(e.mid, fps, tl), pt = curveAt(e.treble, fps, tl), pr = curveAt(e.rms, fps, tl);
      melody = curveAt(e.centroid, fps, tl);
      const w = live && opts.playing ? 0.35 : 0; // anlık analizör: gerçek çıkış
      bass = pb * (1 - w) + bass * w;
      mid = pm * (1 - w) + mid * w;
      treble = pt * (1 - w) + treble * w;
      rms = pr * (1 - w) + rms * w;
      if (!opts.playing) { bass = pb; mid = pm; treble = pt; rms = pr; }
    } else if (live) {
      melody = clamp01(0.3 + 0.6 * (live.treble - live.bass * 0.3));
    }
    const S = this.sm;
    if (opts.jumped) { S.bass = bass; S.mid = mid; S.treble = treble; S.energy = rms; }
    S.bass += (bass - S.bass) * k(0.08);
    S.mid += (mid - S.mid) * k(0.12);
    S.treble += (treble - S.treble) * k(0.06);
    S.energy += (rms - S.energy) * k(opts.playing ? 0.6 : 1.2);
    S.melody += (melody - S.melody) * k(0.35);
    f.bass = S.bass; f.mid = S.mid; f.treble = S.treble; f.energy = S.energy; f.melody = S.melody;

    // --- sessizlik
    let silent = false;
    if (res) {
      const sil = res.energy.silences;
      for (let i = 0; i < sil.length; i += 2) if (t >= sil[i] && t <= sil[i + 1]) { silent = true; break; }
    } else silent = opts.playing && rms < 0.02;
    S.hush += ((silent || !opts.playing ? 1 : 0) - S.hush) * k(silent ? 0.5 : 0.25);
    f.hush = S.hush;

    // --- ritim
    const eff = this.eff;
    let mode: SyncMode = 'energy';
    let targetSync = 0;
    if (eff && eff.t.length > 4) {
      const i = lastAtOrBefore(eff.t, t + 0.04);
      const c = eff.conf[Math.max(0, i)] ?? 0;
      targetSync = smoothstep(0.22, 0.5, c) * (this.result!.rhythm!.confidence >= 0.15 ? 1 : 0);
      if (i >= 0 && i < eff.t.length - 1) {
        const a = eff.t[i], b = eff.t[i + 1];
        f.beatPhase = clamp01((t - a) / (b - a));
        f.bpm = 60 / (b - a);
      }
      // vuruş darbesi (öngörülü, yumuşak)
      const lead = 0.035;
      const j = lastAtOrBefore(eff.t, t + lead);
      const since = j >= 0 ? t + lead - eff.t[j] : -1;
      const per = f.bpm > 0 ? 60 / f.bpm : 0.5;
      f.beatPulse = j >= 0 ? pulse(since, 0.06, Math.min(0.35, per * 0.55)) * (0.55 + 0.45 * eff.str[j]) : 0;
      // ölçü başı darbesi
      let d = j;
      while (d >= 0 && !eff.down[d] && j - d < 8) d--;
      f.barPulse = d >= 0 && eff.down[d] ? pulse(t + lead - eff.t[d], 0.12, 0.9) : 0;
      // geçilen olaylar
      if (advancing) {
        const from = lastAtOrBefore(eff.t, this.prevT + lead) + 1, to = j;
        for (let q = Math.max(0, from); q <= to && q < eff.t.length; q++) {
          const w = smoothstep(0.22, 0.5, eff.conf[q]);
          if (w > 0.05) f.beats.push({ strength: eff.str[q] * w, bass: eff.bass[q] * w });
          if (eff.down[q] && w > 0.3) f.downbeat = true;
        }
      }
      mode = targetSync > 0.5 ? 'beat' : 'energy';
    }
    // düşük güven / analiz yok: anlık bas yükselişinden yumuşak tepki
    if (targetSync < 0.5 && live && opts.playing) {
      this.liveRiseCooldown -= dt;
      if (live.bassRise > 0.45 && live.bass > 0.35 && this.liveRiseCooldown <= 0) {
        f.beats.push({ strength: 0.45 * live.bassRise, bass: 0.5 * live.bass * (1 - targetSync) });
        this.liveRiseCooldown = 0.28;
        this.liveBeatEnv = 1;
      }
      this.liveBeatEnv *= Math.exp(-dt / 0.3);
      f.beatPulse = f.beatPulse * targetSync + this.liveBeatEnv * 0.5 * (1 - targetSync);
    }
    S.sync += (targetSync - S.sync) * k(0.8);
    f.sync = S.sync;
    f.mode = mode;

    // --- ataklar
    if (res && advancing) {
      const on = res.energy.onsets, os = res.energy.onsetStrength;
      for (let q = lastAtOrBefore(on, this.prevT) + 1; q < on.length && on[q] <= t; q++) f.onsets.push(os[q]);
    }
    if (res) {
      const on = res.energy.onsets;
      const q = lastAtOrBefore(on, t);
      f.onsetPulse = q >= 0 ? pulse(t - on[q], 0.02, 0.18) * res.energy.onsetStrength[q] : 0;
    }

    // --- bölümler ve palet
    const secs = res?.structure?.sections;
    if (secs && secs.length) {
      let si = 0;
      while (si < secs.length - 1 && secs[si + 1].start <= t) si++;
      // yalnız güvenilir sınırlar paleti değiştirir
      let pi = si;
      while (pi > 0 && secs[pi].confidence < 0.25) pi--;
      const target = secs[pi].palette;
      if (opts.jumped || this.lastSection < 0) {
        this.palette = { from: target, to: target, start: -1e9 };
      } else if (target !== this.palette.to) {
        const mixNow = this.paletteMix(this.sceneTime);
        // geçiş sürerken yeni geçiş: mevcut hedeften başla
        this.palette = { from: mixNow > 0.5 ? this.palette.to : this.palette.from, to: target, start: this.sceneTime };
      }
      this.lastSection = pi;
      this.lastSectionTime = t;
      f.sectionEnergy += (secs[si].energy - f.sectionEnergy) * k(2);
    } else {
      f.sectionEnergy += (S.energy - f.sectionEnergy) * k(3);
    }
    f.paletteFrom = this.palette.from;
    f.paletteTo = this.palette.to;
    f.paletteMix = this.paletteMix(this.sceneTime);
    this.prevT = t;
    return f;
  }

  private paletteMix(now: number): number {
    const dur = this.frame.reducedMotion ? 12 : 7;
    return smoothstep(0, 1, (now - this.palette.start) / dur);
  }

  /** Ortam modu: şarkıdan bağımsız, kendi zamanında yavaş akış. */
  private ambient(f: SceneFrame, dt: number, k: (tau: number) => number): SceneFrame {
    const pace = this.theme?.pace ?? 1;
    const t = f.time * pace;
    const S = this.sm;
    const breathe = 0.5 + 0.5 * Math.sin(t * 0.21) * Math.sin(t * 0.077 + 1.3);
    S.bass += (0.25 + 0.3 * breathe - S.bass) * k(1.5);
    S.mid += (0.35 + 0.25 * Math.sin(t * 0.13 + 2) - S.mid) * k(1.5);
    S.treble += (0.3 + 0.2 * Math.sin(t * 0.37) - S.treble) * k(1.5);
    S.energy += (0.35 + 0.25 * breathe - S.energy) * k(2);
    S.melody += (0.45 + 0.25 * Math.sin(t * 0.09) - S.melody) * k(2);
    S.sync += (0 - S.sync) * k(0.8);
    S.hush += (0 - S.hush) * k(1);
    f.bass = S.bass; f.mid = S.mid; f.treble = S.treble; f.energy = S.energy; f.melody = S.melody;
    f.sync = S.sync; f.hush = S.hush; f.mode = 'ambient'; f.bpm = 0;
    // kendi saatinde seyrek, yumuşak olaylar (müziğe bağlı değil)
    this.ambientNextBeat -= dt;
    if (this.ambientNextBeat <= 0) {
      f.beats.push({ strength: 0.35, bass: 0.35 + 0.25 * breathe });
      this.ambientNextBeat = 2.2 + 1.6 * ((Math.sin(t * 12.9898) * 43758.5453) % 1 + 1) % 1;
      if (++this.ambientBar % 3 === 0) f.downbeat = true;
    }
    f.beatPulse = 0;
    f.barPulse = 0;
    f.onsetPulse = 0;
    f.beatPhase = 0;
    // palet: parça temasına ya da ~45 sn'de bir yavaş dönüşüme göre
    const target = this.theme ? this.theme.palette : Math.floor(f.time / 45) % 4;
    if (target !== this.palette.to) this.palette = { from: this.palette.to, to: target, start: f.time };
    f.paletteFrom = this.palette.from; f.paletteTo = this.palette.to; f.paletteMix = this.paletteMix(f.time);
    f.sectionEnergy += (0.45 - f.sectionEnergy) * k(3);
    this.prevT = -1;
    this.lastSection = -1;
    return f;
  }

  /**
   * Parçaya göre tema: parça kimliğinden deterministik palet ve akış temposu.
   * Sesle senkron değildir; yalnız parça değişince yavaşça dönüşür.
   */
  setTheme(seed: string | null): void {
    if (!seed) { this.theme = null; return; }
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
    h >>>= 0;
    this.theme = { palette: h % 6, pace: 0.75 + ((h >>> 8) % 100) / 200 };
  }

  reset(): void {
    this.prevT = -1;
    this.lastSection = -1;
    this.palette = { from: 0, to: 0, start: -1e9 };
    this.liveBeatEnv = 0;
  }
}
