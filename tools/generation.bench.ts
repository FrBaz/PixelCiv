/**
 * Banc d'essai de la génération (tâche 1.10 ; NF-03) : durée de la génération d'un monde,
 * pour chaque taille, sur plusieurs graines. Il se lance par `npm run bench`, hors des
 * tests ; il échoue si un monde Grand dépasse 10 s sur la machine qui le lance. Les
 * mesures sont consignées dans docs/BACKLOG.md.
 */
import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/core/data';
import { WORLD_SIZES, type WorldSizeId } from '../src/core/world';
import { defaultWorldParams } from '../src/core/worldParams';
import { generateWorld } from '../src/worldgen/generate';

const data = loadGameData();

/** Mondes générés par taille, chacun d'une autre graine, après un premier pour chauffer. */
const RUNS: Readonly<Record<WorldSizeId, number>> = { small: 6, medium: 4, large: 3, huge: 2 };

/** Cible de NF-03 : un monde Grand en moins de 10 s sur PC. */
const LARGE_TARGET_MS = 10_000;

function generate(id: WorldSizeId, seed: string): number {
  const params = defaultWorldParams(data.worldgen.parameters, seed, id);
  const start = performance.now();
  generateWorld({ ...params, size: WORLD_SIZES[id] }, data);
  return performance.now() - start;
}

describe("génération d'un monde, par taille", () => {
  for (const id of Object.keys(WORLD_SIZES) as WorldSizeId[]) {
    it(id, { timeout: 600_000 }, () => {
      generate(id, 'banc-chauffe');
      const times = Array.from({ length: RUNS[id] }, (_, run) =>
        generate(id, `banc-${String(run)}`),
      );
      const mean = times.reduce((sum, time) => sum + time, 0) / times.length;
      const { width, height } = WORLD_SIZES[id];
      const format = (time: number) => `${(time / 1000).toFixed(2)} s`;
      process.stdout.write(
        `${id.padEnd(7)} ${String(width)} × ${String(height)} : moyenne ${format(mean)}, ` +
          `de ${format(Math.min(...times))} à ${format(Math.max(...times))} ` +
          `(${String(times.length)} mondes)\n`,
      );
      if (id === 'large') expect(mean).toBeLessThan(LARGE_TARGET_MS);
    });
  }
});
