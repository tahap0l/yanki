import { AnalysisCache, type Alignment } from './cache';
import type { AnalysisResult, EnergyStage, WorkerMessage } from './types';
import { ANALYSIS_VERSION } from './types';

export type AnalysisStatus =
  | { state: 'idle' }
  | { state: 'decoding' }
  | { state: 'analyzing'; stage: string; progress: number }
  | { state: 'ready'; fromCache: boolean; ms?: number }
  | { state: 'skipped'; reason: string }
  | { state: 'error'; message: string };

export interface AnalysisJob {
  key: string;
  blob: Blob;
  /** medya öğesinden bilinen süre (s) — bellek bütçesi için */
  duration: number;
}

const isLowMemory = () => {
  const dm = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const ios = /iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios || (dm !== undefined && dm <= 4);
};

/** Süreye göre analiz örnekleme hızı; null = tam analiz yapılmaz (bellek sınırı). */
export function analysisRate(duration: number): number | null {
  const maxMin = isLowMemory() ? 15 : 30;
  if (!(duration > 0)) return 22050;
  if (duration > maxMin * 60) return null;
  if (duration <= 12 * 60) return 22050;
  if (duration <= 20 * 60) return 16000;
  return 11025;
}

/**
 * Çözme → işçi analizi → aşamalı sonuç akışı. Her yeni iş öncekini iptal eder
 * (işçi sonlandırılır, eski iş kimlikli mesajlar yok sayılır).
 */
export class AnalysisController {
  private worker: Worker | null = null;
  private jobId = 0;
  private current: { id: number; key: string; result: AnalysisResult | null } | null = null;

  constructor(
    private onResult: (key: string, result: AnalysisResult, alignment?: Alignment) => void,
    private onStatus: (key: string, s: AnalysisStatus) => void,
  ) {}

  cancel(): void {
    this.jobId++;
    this.current = null;
    if (this.worker) { this.worker.terminate(); this.worker = null; }
  }

  private isCurrent(id: number): boolean { return this.current?.id === id && id === this.jobId; }

  async start(job: AnalysisJob): Promise<void> {
    this.cancel();
    const id = ++this.jobId;
    this.current = { id, key: job.key, result: null };
    const cached = await AnalysisCache.get(job.key);
    if (!this.isCurrent(id)) return;
    if (cached) {
      this.onResult(job.key, cached.result, cached.alignment);
      this.onStatus(job.key, { state: 'ready', fromCache: true });
      return;
    }
    const rate = analysisRate(job.duration);
    if (rate === null) {
      this.onStatus(job.key, { state: 'skipped', reason: 'Dosya çok uzun; bellek sınırı için yalnız anlık enerjiyle görselleştiriliyor.' });
      return;
    }
    this.onStatus(job.key, { state: 'decoding' });
    let mono: Float32Array;
    try {
      mono = await decodeMono(job.blob, rate);
    } catch (e) {
      if (this.isCurrent(id)) this.onStatus(job.key, { state: 'error', message: 'Ses çözülemedi: ' + (e instanceof Error ? e.message : String(e)) });
      return;
    }
    if (!this.isCurrent(id)) return;
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker = w;
    w.onmessage = (ev: MessageEvent<WorkerMessage>) => this.handle(ev.data, id);
    w.onerror = (ev) => { if (this.isCurrent(id)) this.onStatus(job.key, { state: 'error', message: ev.message || 'Analiz işçisi hatası' }); };
    // örnekler aktarılır (kopyalanmaz); ana iş parçacığı belleği hemen boşalır
    w.postMessage({ type: 'analyze', jobId: id, samples: mono, sampleRate: rate }, [mono.buffer]);
  }

  private handle(m: WorkerMessage, id: number): void {
    if (m.jobId !== id || !this.isCurrent(id) || !this.current) return;
    const key = this.current.key;
    switch (m.type) {
      case 'progress':
        this.onStatus(key, { state: 'analyzing', stage: m.stage, progress: m.progress });
        break;
      case 'stage': {
        if (m.stage === 'energy') this.current.result = { version: ANALYSIS_VERSION, energy: m.data as EnergyStage };
        else if (this.current.result) {
          if (m.stage === 'rhythm') this.current.result = { ...this.current.result, rhythm: m.data };
          else this.current.result = { ...this.current.result, structure: m.data };
        }
        if (this.current.result) this.onResult(key, this.current.result);
        break;
      }
      case 'done':
        if (this.current.result) void AnalysisCache.put(key, this.current.result);
        this.onStatus(key, { state: 'ready', fromCache: false, ms: m.ms });
        this.worker?.terminate();
        this.worker = null;
        break;
      case 'error':
        this.onStatus(key, { state: 'error', message: m.message });
        break;
    }
  }
}

/** Dosyayı hedef örnekleme hızında çözüp tek kanala indirger. */
async function decodeMono(blob: Blob, rate: number): Promise<Float32Array> {
  const data = await blob.arrayBuffer();
  const Off = window.OfflineAudioContext || (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const ctx = new Off(1, 1, rate);
  const buf: AudioBuffer = await new Promise((res, rej) => {
    const p = ctx.decodeAudioData(data, res, rej);
    if (p && typeof p.then === 'function') p.then(res, rej);
  });
  const n = buf.length, ch = buf.numberOfChannels;
  const out = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / ch;
  }
  return out;
}
