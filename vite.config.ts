import { defineConfig } from 'vitest/config';
import { bundleLicenses } from './tools/bundle-licenses.ts';

// Licences et crédits des paquets distribués, contrôlés au build (ADR 0008).
const licenses = bundleLicenses();

// Configuration de Vite (serveur de développement et build) et de Vitest (tests). Le mode
// « bench » (npm run bench) ne lance que les bancs d'essai, tools/*.bench.ts.
export default defineConfig(({ mode }) => ({
  // Chemins relatifs : le même build sert en local et sur GitHub Pages, sous /PixelCiv/.
  base: './',
  // JSX de l'interface, compilé pour Preact.
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  plugins: [licenses.main],
  worker: {
    format: 'es',
    plugins: () => [licenses.worker()],
  },
  test: {
    // Composants compris : leurs tests s'écrivent en .test.tsx.
    include: mode === 'bench' ? ['tools/**/*.bench.ts'] : ['{src,tools}/**/*.test.{ts,tsx}'],
    // Les tests de la génération du monde produisent des cartes entières.
    testTimeout: 30_000,
  },
}));
