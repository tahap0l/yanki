export type SceneId = 'moonlight' | 'aurora' | 'stardust';

export const SCENES: { id: SceneId; name: string; hint: string }[] = [
  { id: 'moonlight', name: 'Ay Işığı', hint: 'Bas vuruşları suda dalga açar' },
  { id: 'aurora', name: 'Kutup Işıkları', hint: 'Melodi şeritleri kıvırır' },
  { id: 'stardust', name: 'Yıldız Tozu', hint: 'Ölçü başları akışı yönlendirir' },
];

export type SyncMode = 'beat' | 'energy' | 'ambient';

/** Sahnelerin her karede aldığı, kaynaktan bağımsız müzik durumu. */
export interface SceneFrame {
  /** sahnenin kendi animasyon zamanı (s), azaltılmış harekette yavaşlar */
  time: number;
  dt: number;
  mode: SyncMode;
  /** 0..1, vuruş senkronunun ağırlığı (düşük güvende yumuşak enerjiye geçiş) */
  sync: number;
  playing: boolean;
  /** yumuşatılmış enerjiler 0..1 */
  bass: number;
  mid: number;
  treble: number;
  energy: number;
  /** spektral parlaklık 0..1 (melodi yüksekliği yaklaşığı) */
  melody: number;
  /** vuruş evresi 0..1 ve yumuşak darbe zarfları 0..1 */
  beatPhase: number;
  beatPulse: number;
  barPulse: number;
  onsetPulse: number;
  bpm: number;
  /** bu karede geçilen olaylar (sarmada boş) */
  beats: { strength: number; bass: number }[];
  downbeat: boolean;
  onsets: number[];
  /** palet geçişi */
  paletteFrom: number;
  paletteTo: number;
  paletteMix: number;
  sectionEnergy: number;
  /** 0..1, sessizlikte 1'e yaklaşır */
  hush: number;
  /** kullanıcı ayarları */
  intensity: number;
  reducedMotion: boolean;
}

export interface Quality {
  /** çözünürlük çarpanı 0.35..1 */
  scale: number;
  /** parçacık çarpanı 0.15..1 */
  particles: number;
  level: number;
}

export interface SceneRenderer {
  readonly id: SceneId;
  resize(w: number, h: number): void;
  render(f: SceneFrame, q: Quality): void;
  dispose(): void;
}

export function emptyFrame(): SceneFrame {
  return {
    time: 0, dt: 0, mode: 'ambient', sync: 0, playing: false,
    bass: 0, mid: 0, treble: 0, energy: 0, melody: 0.4,
    beatPhase: 0, beatPulse: 0, barPulse: 0, onsetPulse: 0, bpm: 0,
    beats: [], downbeat: false, onsets: [],
    paletteFrom: 0, paletteTo: 0, paletteMix: 1, sectionEnergy: 0.5, hush: 0,
    intensity: 0.8, reducedMotion: false,
  };
}
