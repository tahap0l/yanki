/** Analiz algoritması sürümü: değiştiğinde önbellekteki eski sonuçlar geçersizleşir. */
export const ANALYSIS_VERSION = 7;

/** Sahne eğrilerinin örnekleme hızı (kare/saniye). */
export const CURVE_FPS = 50;

export interface Section {
  start: number;
  end: number;
  /** 0..1, bölümün ortalama enerjisi (parça içinde göreli) */
  energy: number;
  /** 0..1, sınırın güvenilirliği (ilk bölüm için 1) */
  confidence: number;
  /** benzer bölümler aynı palet numarasını paylaşır */
  palette: number;
}

export interface EnergyStage {
  duration: number;
  fps: number;
  /** 0..1 normalize eğriler, CURVE_FPS hızında */
  bass: Float32Array;
  mid: Float32Array;
  treble: Float32Array;
  rms: Float32Array;
  centroid: Float32Array;
  onset: Float32Array;
  /** atak zamanları (s) ve güçleri (0..1) */
  onsets: Float32Array;
  onsetStrength: Float32Array;
  /** [başlangıç, bitiş] çiftleri, düz dizi */
  silences: Float32Array;
}

export interface RhythmStage {
  bpm: number;
  /** her saniye için yerel tempo */
  tempoCurve: Float32Array;
  /** 0..1 tempo netliği */
  tempoConfidence: number;
  /** 0..1, yarım/çift tempo karışıklığı (1 = tamamen belirsiz) */
  octaveAmbiguity: number;
  beats: Float32Array;
  /** her vuruş için yerel güven 0..1 */
  beatConfidence: Float32Array;
  /** her vuruşun atak gücü 0..1 */
  beatStrength: Float32Array;
  /** her vuruşun bas atak gücü 0..1 */
  beatBass: Float32Array;
  /** yalnız güvenilirse dolu, değilse boş dizi */
  downbeats: Float32Array;
  meter: number;
  downbeatConfidence: number;
  /** genel ritim güveni 0..1 */
  confidence: number;
}

export interface StructureStage {
  sections: Section[];
}

export interface AnalysisResult {
  version: number;
  energy: EnergyStage;
  rhythm?: RhythmStage;
  structure?: StructureStage;
}

export type AnalysisStage = 'energy' | 'rhythm' | 'structure';

export interface AnalyzeRequest {
  type: 'analyze';
  jobId: number;
  samples: Float32Array;
  sampleRate: number;
}

export type WorkerMessage =
  | { type: 'progress'; jobId: number; stage: string; progress: number }
  | { type: 'stage'; jobId: number; stage: 'energy'; data: EnergyStage }
  | { type: 'stage'; jobId: number; stage: 'rhythm'; data: RhythmStage }
  | { type: 'stage'; jobId: number; stage: 'structure'; data: StructureStage }
  | { type: 'done'; jobId: number; ms: number }
  | { type: 'error'; jobId: number; message: string };
