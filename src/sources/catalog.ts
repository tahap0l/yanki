/**
 * Lisanslı katalog. Bir parça yalnızca oynatma, analiz ve görsel senkron
 * haklarının üçü de doğrulanmışsa uygulama içinde çalınır.
 */
export interface CatalogRights {
  playback: boolean;
  analysis: boolean;
  visualSync: boolean;
  verifiedBy: string;
  verifiedAt: string;
}

export interface CatalogTrack {
  id: string;
  title: string;
  artist: string;
  src: string;
  duration: number;
  bpmHint?: string;
  scene: 'moonlight' | 'aurora' | 'stardust';
  description: string;
  license: { name: string; holder: string; url?: string };
  rights: CatalogRights;
}

export interface CatalogEntry extends CatalogTrack {
  playable: boolean;
  blockedReason?: string;
}

export function verifyRights(t: CatalogTrack): CatalogEntry {
  const r = t.rights;
  const missing: string[] = [];
  if (!r?.playback) missing.push('oynatma');
  if (!r?.analysis) missing.push('analiz');
  if (!r?.visualSync) missing.push('görsel senkron');
  if (!r?.verifiedBy || !r?.verifiedAt || Number.isNaN(Date.parse(r.verifiedAt))) missing.push('doğrulama kaydı');
  return missing.length
    ? { ...t, playable: false, blockedReason: `Eksik hak: ${missing.join(', ')}` }
    : { ...t, playable: true };
}

export async function loadCatalog(url = './catalog/catalog.json'): Promise<CatalogEntry[]> {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Katalog yüklenemedi (${res.status})`);
  const data = (await res.json()) as { tracks: CatalogTrack[] };
  const base = new URL(url, location.href);
  return data.tracks.map((t) => verifyRights({ ...t, src: new URL(t.src, base).toString() }));
}
