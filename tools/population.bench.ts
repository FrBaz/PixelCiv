/**
 * Banc d'essai de la population (tâches 2.11 et 2b.2 ; IND-03, NF-01 ; ADR 0013) : durée
 * du pas mensuel, avec l'image des groupes que le worker envoie après lui, et durée d'un
 * jour du sous-pas quotidien, pour 10 000 puis 50 000 individus répartis en groupes nomades
 * sur un monde Immense, assez espacés pour que chacun trouve de quoi vivre : la population
 * se maintient pendant la mesure (un monde Grand ne nourrit pas 50 000
 * chasseurs-cueilleurs). Il se lance par `npm run bench`, hors des tests. Il échoue si le
 * pas mensuel de 10 000 individus dépasse 52 ms, ou celui de 50 000 individus 208 ms, sur
 * la machine qui le lance, ou si un jour de 50 000 individus dépasse 0,5 ms : ce sont des
 * garde-fous contre les régressions. Les seuils du pas mensuel sont ceux d'avant les deux
 * horloges, quand un mois durait 52 ms à ×16 et 208 ms à ×4 ; ils ne suivent plus
 * monthDuration, qui a quadruplé, car un pas mensuel trop long arrête le mouvement à
 * l'écran. La cible de 50 000 individus à ×16 se mesure sur un vrai PC. Les mesures sont
 * consignées dans docs/BACKLOG.md.
 *
 * Chaque scénario imprime aussi l'empreinte de l'état au bout de ses trente mois : une
 * optimisation qui ne change pas le déroulement la laisse intacte (ADR 0011), ce que l'on
 * vérifie en comparant la sortie du banc avant et après elle.
 */
import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/core/data';
import { DAYS_PER_MONTH } from '../src/core/time';
import { WORLD_SIZES } from '../src/core/world';
import { defaultWorldParams } from '../src/core/worldParams';
import { spawnGroup } from '../src/sim/spawn';
import { createState, type SimState } from '../src/sim/state';
import { advanceDay, step } from '../src/sim/day';
import { fingerprint } from '../src/sim/step';
import { groupsFrame } from '../src/sim/views';
import { generateWorld } from '../src/worldgen/generate';

const data = loadGameData();

/** Mois de mise en route, puis mois mesurés. */
const WARMUP = 6;
const MEASURED = 24;
/** Seuils du pas mensuel, image comprise, et d'un jour, en millisecondes. */
const MONTH_LIMIT_MS: Readonly<Record<number, number>> = { 10_000: 52, 50_000: 208 };
const DAY_LIMIT_MS = 0.5;
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

describe('pas mensuel et jours de la population', () => {
  for (const people of [10_000, 50_000]) {
    it(`${String(people)} individus`, { timeout: 600_000 }, () => {
      const state = seeded(people);
      for (let month = 0; month < WARMUP; month++) step(state, [], data);
      const before = state.people.count;
      const steps: number[] = [];
      const frames: number[] = [];
      const days: number[] = [];
      const walks: number[] = [];
      for (let month = 0; month < MEASURED; month++) {
        // Les jours ordinaires du mois, chacun mesuré, puis, comme l'hôte du worker, le pas
        // mensuel du trentième jour et l'image des groupes, de ses membres.
        for (let day = 1; day < DAYS_PER_MONTH; day++) {
          const start = performance.now();
          advanceDay(state, [], data);
          days.push(performance.now() - start);
          walks.push(state.dayPositions.walking);
        }
        const start = performance.now();
        const members = advanceDay(state, [], data);
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
      const limit = MONTH_LIMIT_MS[people] ?? 0;
      process.stdout.write(
        `${String(people).padStart(6)} semés, de ${String(before)} à ` +
          `${String(state.people.count)} vivants pendant la mesure, ` +
          `${String(state.society.groups.size)} groupes : pas mensuel ${format(mean(steps))}, ` +
          `image ${format(mean(frames))}, total moyen ${format(mean(total))}, ` +
          `p95 ${format(percentile(sorted, 0.95))}, max ${format(sorted.at(-1) ?? 0)} ` +
          `(seuil ${format(limit)}) ; jour ${mean(days).toFixed(3)} ms, ` +
          `${mean(walks).toFixed(0)} marches en cours en moyenne ; ` +
          `empreinte ${fingerprint(state)}\n`,
      );
      expect(mean(total)).toBeLessThan(limit);
      if (people === 50_000) expect(mean(days)).toBeLessThan(DAY_LIMIT_MS);
    });
  }
});
