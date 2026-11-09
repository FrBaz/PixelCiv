import { defineConfig } from 'vitest/config';
import { bundleLicenses } from './tools/bundle-licenses.ts';

// Licences et crédits des paquets distribués, contrôlés au build (ADR 0008).
const licenses = bundleLicenses();

// Configuration de Vite (serveur de développement et build) et de Vitest (tests).
export default defineConfig({
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
    include: ['{src,tools}/**/*.test.{ts,tsx}'],
  },
});
