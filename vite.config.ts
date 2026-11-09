import { defineConfig } from 'vitest/config';
import { bundleLicenses } from './tools/bundle-licenses';

// Configuration de Vite (serveur de développement et build) et de Vitest (tests).
export default defineConfig({
  // Chemins relatifs : le même build sert en local et sur GitHub Pages, sous /PixelCiv/.
  base: './',
  plugins: [bundleLicenses()],
  worker: {
    format: 'es',
    plugins: () => [bundleLicenses()],
  },
  test: {
    include: ['src/**/*.test.ts', 'tools/**/*.test.ts'],
  },
});
