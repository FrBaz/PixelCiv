import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { bundleLicenses } from './tools/bundle-licenses.ts';
import { decorAtlas } from './tools/decor-atlas.ts';
import { faunaAtlas } from './tools/fauna-atlas.ts';
import { humanAtlas, loadHumans } from './tools/human-atlas.ts';
import { pixelAtlas } from './tools/pixel-atlas.ts';

// Licences et crédits des paquets distribués, contrôlés au build (ADR 0008).
const root = fileURLToPath(new URL('.', import.meta.url));
const licenses = bundleLicenses({ assets: [loadHumans(root).credit] });

// Configuration de Vite (serveur de développement et build) et de Vitest (tests). Le mode
// « bench » (npm run bench) ne lance que les bancs d'essai, tools/*.bench.ts ; le mode
// « wave-control » (npx vitest run --mode wave-control), que le contrôle des pixels de la mer
// animée, tools/wave-control/*.control.ts, sur des captures de Chromium (ADR 0015) ; le mode
// « human-control », celui des pixels des humains, tools/human-control/*.control.ts (ADR 0016).
export default defineConfig(({ mode }) => ({
  // Chemins relatifs : le même build sert en local et sur GitHub Pages, sous /PixelCiv/.
  base: './',
  // JSX de l'interface, compilé pour Preact.
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  // Atlas des sources pixel art (assets/pixel/), rangé au build (AST-04).
  // Atlas des humains des planches de sprites/humans/skin/, habillés à l'exécution (ADR 0016).
  // Atlas du décor, des grilles d'assets/decor/ (ADR 0017), et du gibier, d'assets/fauna/ (ADR 0018).
  plugins: [
    licenses.main,
    pixelAtlas(fileURLToPath(new URL('assets/pixel', import.meta.url))),
    humanAtlas(root),
    decorAtlas(root),
    faunaAtlas(root),
  ],
  worker: {
    format: 'es',
    plugins: () => [licenses.worker()],
  },
  test: {
    // Composants compris : leurs tests s'écrivent en .test.tsx.
    include:
      mode === 'bench'
        ? ['tools/**/*.bench.ts']
        : mode === 'wave-control'
          ? ['tools/wave-control/*.control.ts']
          : mode === 'human-control'
            ? ['tools/human-control/*.control.ts']
            : ['{src,tools}/**/*.test.{ts,tsx}'],
    // Les bancs d'essai mesurent des durées : l'un après l'autre, pour ne pas se gêner.
    fileParallelism: mode !== 'bench',
    // Les tests de la génération du monde produisent des cartes entières.
    testTimeout: 30_000,
  },
}));
