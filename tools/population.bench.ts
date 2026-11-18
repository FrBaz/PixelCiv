/**
 * Banc d'essai de la population (tâche 2.11 ; IND-03, NF-01) : durée d'un pas mensuel,
 * avec l'image des groupes que le worker envoie à chaque pas, pour 10 000 puis 50 000
 * individus répartis en groupes nomades sur un monde Immense, assez espacés pour que chacun
 * trouve de quoi vivre : la population se maintient pendant la mesure (un monde Grand ne
 * nourrit pas 50 000 chasseurs-cueilleurs). Il se lance par `npm run bench`, hors des
 * tests. Il échoue si un pas de 10 000 individus dépasse la durée d'un mois à la vitesse
 * la plus rapide (×16), ou un pas de 50 000 celle d'un mois à ×4, sur la machine qui le
 * lance : ce sont des garde-fous contre les régressions ; la cible de 50 000 individus à
 * ×16 se mesure sur un vrai PC. Les mesures sont consignées dans docs/BACKLOG.md.
 *
 * Chaque scénario imprime aussi l'empreinte de l'état au bout de ses trente mois : une
 * optimisation qui ne change pas le déroulement la laisse intacte (ADR 0011), ce que l'on
 * vérifie en comparant la sortie du banc avant et après elle.
 */
import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/core/data';
import { monthDuration } from '../src/core/time';
import { WORLD_SIZES } from '../src/core/world';
import { defaultWorldParams } from '../src/core/worldParams';
import { spawnGroup } from '../src/sim/spawn';
import { createState, type SimState } from '../src/sim/state';
import { fingerprint, step } from '../src/sim/step';
import { groupsFrame } from '../src/sim/views';
import { generateWorld } from '../src/worldgen/generate';

const data = loadGameData();

/** Mois de mise en route, puis mois mesurés. */
const WARMUP = 6;
const MEASURED = 24;
/** Taille des groupes semés. */
const GROUP_SIZE = 25;
/** Écart, en cases, entre deux groupes semés : leurs aires de cueillette se touchent à peine. */
const SPACING = 12;
/** Familles de biomes où l'on sème des groupes : celles où l'on vit de la cueillette. */
const HABITABLE = new Set(['temperate', 'tropical', 'arid', 'wetland', 'coast']);

const params = defaultWorldParams(data.worldgen.parameters, 'banc-population', 'huge');
const world = generateWorld({ ...params, size: WORLD_SIZES.huge }, data);

/** Une partie de `people` individus, en groupes semés régulièrement sur les terres. */
function seeded(people: number): SimState {
  const state = createState(params, world, data);
  const { width, height } = state.size;
  const candidates: { x: number; y: number }[] = [];
  for (let y = 2; y < height; y += SPACING) {
    for (let x = 2; x < width; x += SPACING) {
      const biome = data.biomes.entries.at(world.biome[y * width + x] ?? 0);
      const walkable = Number.isFinite(state.cost[y * width + x]);
      if (biome !== undefined && HABITABLE.has(biome.family) && walkable) {
        candidates.push({ x, y });
      }
    }
  }
  const groups = Math.ceil(people / GROUP_SIZE);
  if (candidates.length < groups) throw new Error('trop peu de cases où semer les groupes');
  const subspecies = data.species.entries[0]?.subspecies.map((entry) => entry.id) ?? [];
  for (let index = 0; index < groups; index++) {
    const cell = candidates[Math.floor((index * candidates.length) / groups)] ?? { x: 0, y: 0 };
    spawnGroup(
      state,
      {
        type: 'spawnGroup',
        ...cell,
        species: 'human',
        subspecies: subspecies[index % subspecies.length] ?? 'plains',
        count: GROUP_SIZE,
      },
      data,
    );
  }
  return state;
}

function percentile(sorted: readonly number[], share: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? 0;
}

describe('pas mensuel de la population', () => {
  for (const people of [10_000, 50_000]) {
    it(`${String(people)} individus`, { timeout: 600_000 }, () => {
      const state = seeded(people);
      for (let month = 0; month < WARMUP; month++) step(state, [], data);
      const before = state.people.count;
      const steps: number[] = [];
      const frames: number[] = [];
      for (let month = 0; month < MEASURED; month++) {
        // Comme l'hôte du worker : le pas, puis l'image des groupes, de ses membres.
        const start = performance.now();
        const members = step(state, [], data);
        const middle = performance.now();
        groupsFrame(state, data, members);
        steps.push(middle - start);
        frames.push(performance.now() - middle);
      }
      const total = steps.map((time, index) => time + (frames[index] ?? 0));
      const mean = (times: readonly number[]) =>
        times.reduce((sum, time) => sum + time, 0) / times.length;
      const sorted = [...total].sort((a, b) => a - b);
      const format = (time: number) => `${time.toFixed(1)} ms`;
      process.stdout.write(
        `${String(people).padStart(6)} semés, de ${String(before)} à ` +
          `${String(state.people.count)} vivants pendant la mesure, ` +
          `${String(state.society.groups.size)} groupes : pas ${format(mean(steps))}, ` +
          `image ${format(mean(frames))}, total moyen ${format(mean(total))}, ` +
          `p95 ${format(percentile(sorted, 0.95))}, max ${format(sorted.at(-1) ?? 0)} ` +
          `(un mois à ×16 : ${format(monthDuration('faster'))}, ` +
          `à ×4 : ${format(monthDuration('fast'))}) ; empreinte ${fingerprint(state)}\n`,
      );
      expect(mean(total)).toBeLessThan(monthDuration(people === 50_000 ? 'fast' : 'faster'));
    });
  }
});
