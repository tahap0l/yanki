import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Derleme sonunda dist/sw.js üretir: uygulama kabuğunu (HTML, JS, CSS,
 * yazı tipleri, simgeler) önbelleğe alma listesi ve içerik özetinden sürüm.
 * Demo sesleri listeye girmez; ilk çalındıklarında önbelleğe alınır.
 */
export function pwa(): Plugin {
  let outDir = 'dist';
  return {
    name: 'yanki-pwa',
    apply: 'build',
    configResolved(c) { outDir = c.build.outDir; },
    closeBundle() {
      const files: string[] = [];
      const walk = (d: string) => {
        for (const n of readdirSync(d)) {
          const p = join(d, n);
          if (statSync(p).isDirectory()) walk(p);
          else files.push(relative(outDir, p).split(sep).join('/'));
        }
      };
      walk(outDir);
      const precache = files
        .filter((f) => f !== 'sw.js' && !f.startsWith('demo/') && !f.startsWith('screens/') && !f.endsWith('.woff') && f !== '404.html')
        .sort();
      const h = createHash('sha256');
      h.update(readFileSync('scripts/sw-template.js'));
      for (const f of precache) h.update(f).update(readFileSync(join(outDir, f)));
      const version = h.digest('hex').slice(0, 12);
      const list = ['./', ...precache.map((f) => `./${f}`)];
      const tpl = readFileSync('scripts/sw-template.js', 'utf8');
      writeFileSync(join(outDir, 'sw.js'), tpl.replace('__VERSION__', version).replace('__PRECACHE__', JSON.stringify(list, null, 1)));
      // GitHub Pages: bilinmeyen yollar uygulamaya düşsün
      writeFileSync(join(outDir, '404.html'), readFileSync(join(outDir, 'index.html')));
      this.info?.(`sw.js: ${list.length} dosya, sürüm ${version}`);
    },
  };
}
