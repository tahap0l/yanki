import { defineConfig } from 'vite';
import { pwa } from './scripts/pwa-plugin';

export default defineConfig({
  base: './',
  plugins: [pwa()],
  build: { target: 'es2022', sourcemap: false, assetsInlineLimit: 0 },
  worker: { format: 'es' },
});
