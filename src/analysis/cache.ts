import { ANALYSIS_VERSION, type AnalysisResult } from './types';

/** Kullanıcının elle yaptığı vuruş hizası düzeltmesi. */
export interface Alignment {
  offsetMs: number;
  /** 0.5 = yarım tempo, 1, 2 = çift tempo */
  tempoFactor: 0.5 | 1 | 2;
}

interface Row {
  key: string;
  version: number;
  result: AnalysisResult;
  alignment?: Alignment;
  bytes: number;
  usedAt: number;
}

const DB = 'yanki-analiz';
const STORE = 'sonuclar';
const MAX_ENTRIES = 40;

let dbp: Promise<IDBDatabase | null> | null = null;
function open(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return open().then((db) => new Promise((resolve) => {
    if (!db) return resolve(undefined);
    try {
      const r = fn(db.transaction(STORE, mode).objectStore(STORE));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  }));
}

/**
 * Parmak izi: boyut + ilk ve son 256 KB'nin SHA-256 özeti.
 * Dosyanın tamamı okunmaz; aynı dosya yeniden adlandırılsa da eşleşir.
 */
export async function fingerprint(file: Blob): Promise<string> {
  const CH = 256 * 1024;
  const head = await file.slice(0, CH).arrayBuffer();
  const tail = await file.slice(Math.max(0, file.size - CH)).arrayBuffer();
  const sizeBytes = new TextEncoder().encode(String(file.size));
  const all = new Uint8Array(sizeBytes.length + head.byteLength + tail.byteLength);
  all.set(sizeBytes, 0);
  all.set(new Uint8Array(head), sizeBytes.length);
  all.set(new Uint8Array(tail), sizeBytes.length + head.byteLength);
  if (crypto?.subtle) {
    const d = await crypto.subtle.digest('SHA-256', all);
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  // güvensiz bağlamda (http) yedek: FNV-1a
  let h = 0x811c9dc5;
  for (let i = 0; i < all.length; i++) { h ^= all[i]; h = Math.imul(h, 0x01000193); }
  return `fnv${(h >>> 0).toString(16)}-${file.size}`;
}

function sizeOf(r: AnalysisResult): number {
  let n = 0;
  const walk = (o: unknown) => {
    if (o instanceof Float32Array) n += o.byteLength;
    else if (o && typeof o === 'object') for (const v of Object.values(o)) walk(v);
  };
  walk(r);
  return n;
}

export const AnalysisCache = {
  async get(key: string): Promise<{ result: AnalysisResult; alignment?: Alignment } | null> {
    const row = (await tx<Row>('readonly', (s) => s.get(key))) as Row | undefined;
    if (!row || row.version !== ANALYSIS_VERSION || !row.result?.rhythm) return null;
    void tx('readwrite', (s) => s.put({ ...row, usedAt: Date.now() }));
    return { result: row.result, alignment: row.alignment };
  },

  async put(key: string, result: AnalysisResult, alignment?: Alignment): Promise<void> {
    await tx('readwrite', (s) => s.put({ key, version: ANALYSIS_VERSION, result, alignment, bytes: sizeOf(result), usedAt: Date.now() } satisfies Row));
    // en eski kayıtları ayıkla
    const all = ((await tx<Row[]>('readonly', (s) => s.getAll())) || []) as Row[];
    if (all.length > MAX_ENTRIES) {
      all.sort((a, b) => a.usedAt - b.usedAt);
      for (const r of all.slice(0, all.length - MAX_ENTRIES)) await tx('readwrite', (s) => s.delete(r.key));
    }
  },

  async setAlignment(key: string, alignment: Alignment): Promise<void> {
    const row = (await tx<Row>('readonly', (s) => s.get(key))) as Row | undefined;
    if (row) await tx('readwrite', (s) => s.put({ ...row, alignment, usedAt: Date.now() }));
  },

  async stats(): Promise<{ count: number; bytes: number }> {
    const all = ((await tx<Row[]>('readonly', (s) => s.getAll())) || []) as Row[];
    return { count: all.length, bytes: all.reduce((a, r) => a + (r.bytes || 0), 0) };
  },

  async clear(): Promise<void> {
    await tx('readwrite', (s) => s.clear());
  },
};
