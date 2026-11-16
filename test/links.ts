// npx tsx test/links.ts
import { parseLink } from '../src/sources/links';
import { verifyRights } from '../src/sources/catalog';
const cases: [string, string][] = [
  ['https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=x', 'spotify:track:4cOdK2wGLETKBW3PvgPWqT'],
  ['https://open.spotify.com/intl-tr/album/1DFixLWuPkv3KT3TnV35m3', 'spotify:album:1DFixLWuPkv3KT3TnV35m3'],
  ['spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M'],
  ['open.spotify.com/episode/512ojhOuo1ktJprKbVcKyQ', 'spotify:episode:512ojhOuo1ktJprKbVcKyQ'],
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x', 'youtube:dQw4w9WgXcQ:0'],
  ['https://youtu.be/dQw4w9WgXcQ?t=1m5s', 'youtube:dQw4w9WgXcQ:65'],
  ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube:dQw4w9WgXcQ:0'],
  ['https://m.youtube.com/shorts/dQw4w9WgXcQ', 'youtube:dQw4w9WgXcQ:0'],
  ['https://www.youtube.com/embed/dQw4w9WgXcQ?start=30', 'youtube:dQw4w9WgXcQ:30'],
  ['https://www.youtube.com/live/dQw4w9WgXcQ', 'youtube:dQw4w9WgXcQ:0'],
  ['https://www.youtube.com/watch?v=short', 'unknown'],
  ['https://example.com/song.mp3', 'unknown'],
  ['', 'unknown'],
  ['https://spotify.link/abc', 'unknown'],
];
let fail = 0;
for (const [inp, exp] of cases) {
  const p = parseLink(inp);
  const got = p.kind === 'spotify' ? `spotify:${p.type}:${p.id}` : p.kind === 'youtube' ? `youtube:${p.videoId}:${p.start}` : 'unknown';
  if (got !== exp) { fail++; console.log('HATA', inp, got, '≠', exp); }
}
const base = { id: 'x', title: 'x', artist: 'x', src: 'x', duration: 1, scene: 'aurora' as const, description: '', license: { name: 'x', holder: 'x' } };
const ok = verifyRights({ ...base, rights: { playback: true, analysis: true, visualSync: true, verifiedBy: 'a', verifiedAt: '2026-01-01' } });
const bad = verifyRights({ ...base, rights: { playback: true, analysis: false, visualSync: true, verifiedBy: 'a', verifiedAt: '2026-01-01' } });
if (!ok.playable || bad.playable) { fail++; console.log('HATA haklar', ok, bad); }
console.log(fail ? `${fail} hata` : `bağlantı ve hak testleri: ${cases.length + 1}/${cases.length + 1} geçti`);
process.exit(fail ? 1 : 0);
