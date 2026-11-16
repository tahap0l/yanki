import type { RendererPref } from '../scenes/SceneHost';
import type { SceneId } from '../scenes/types';

export interface Prefs {
  intensity: number; // 0.2..1
  reducedMotion: boolean;
  renderer: RendererPref;
  scene: SceneId;
}

const KEY = 'yanki.prefs.v1';

export function loadPrefs(): Prefs {
  const sysReduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const d: Prefs = { intensity: 0.8, reducedMotion: sysReduced, renderer: 'auto', scene: 'moonlight' };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) Object.assign(d, JSON.parse(raw));
  } catch { /* depolama yok */ }
  const q = new URLSearchParams(location.search);
  const r = q.get('renderer');
  if (r === 'webgl2' || r === 'canvas2d' || r === 'auto') d.renderer = r;
  const s = q.get('scene');
  if (s === 'moonlight' || s === 'aurora' || s === 'stardust') d.scene = s;
  d.intensity = Math.min(1, Math.max(0.2, Number(d.intensity) || 0.8));
  return d;
}

export function savePrefs(p: Prefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* yoksay */ }
}
