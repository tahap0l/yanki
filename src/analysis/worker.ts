/// <reference lib="webworker" />
import { analyze } from './analyze';
import type { AnalyzeRequest, WorkerMessage } from './types';

declare const self: DedicatedWorkerGlobalScope;

const post = (m: WorkerMessage, transfer: Transferable[] = []) => self.postMessage(m, transfer);

function buffersOf(o: object): Transferable[] {
  const out: Transferable[] = [];
  for (const v of Object.values(o)) if (v instanceof Float32Array) out.push(v.buffer);
  return out;
}

self.onmessage = (ev: MessageEvent<AnalyzeRequest>) => {
  const req = ev.data;
  if (req.type !== 'analyze') return;
  const { jobId } = req;
  const t0 = performance.now();
  let lastP = -1;
  try {
    analyze(req.samples, req.sampleRate, {
      progress: (stage, p) => {
        const q = Math.round(p * 20);
        if (q !== lastP) { lastP = q; post({ type: 'progress', jobId, stage, progress: p }); }
      },
      energy: (data) => post({ type: 'stage', jobId, stage: 'energy', data }, buffersOf(data)),
      rhythm: (data) => post({ type: 'stage', jobId, stage: 'rhythm', data }, buffersOf(data)),
      structure: (data) => post({ type: 'stage', jobId, stage: 'structure', data }),
    });
    post({ type: 'done', jobId, ms: performance.now() - t0 });
  } catch (e) {
    post({ type: 'error', jobId, message: e instanceof Error ? e.message : String(e) });
  }
};
