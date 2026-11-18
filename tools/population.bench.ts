/**
 * Banc d'essai de la population (tâches 2.11, 2b.2 et 2b.3 ; IND-03, NF-01 ; ADR 0013,
 * ADR 0014) : durée d'un jour du sous-pas quotidien, du pas mensuel, avec l'image des
 * groupes que le worker envoie après lui, et du mois entier, ses trente jours et son pas
 * mensuel, pour 10 000 puis 50 000 individus répartis en groupes nomades sur un monde
 * Immense, assez espacés pour que chacun trouve de quoi vivre : la population se maintient
 * pendant la mesure (un monde Grand ne nourrit pas 50 000 chasseurs-cueilleurs). Il se lance
 * par `npm run bench`, hors des tests. Ce sont des garde-fous contre les régressions, sur la
 * machine qui le lance : le pas mensuel de 10 000 individus ne dépasse pas 52 ms ; à 50 000,
 * le budget de l'ADR 0014 : le mois entier tient en 208 ms, la durée d'un mois à ×16, le pas
 * mensuel en 97 ms, et le jour le plus long en 20 ms. La cible de 50 000 individus à ×16 se
 * mesure sur un vrai PC. Les mesures sont consignées dans docs/BACKLOG.md.
 *
 * Chaque scénario imprime aussi les marcheurs, les étapes commencées par jour et l'empreinte
 * de l'état au bout de ses trente mois : une optimisation qui ne change pas le déroulement la
 * laisse intacte (ADR 0011), ce que l'on vérifie en comparant la sortie du banc avant et
 * après elle.
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
/** Seuils du pas mensuel, image comprise, en millisecondes. */
const STEP_LIMIT_MS: Readonly<Record<number, number>> = { 10_000: 52, 50_000: 97 };
/** Budget de 50 000 individus (ADR 0014) : le mois entier, et le jour le plus long. */
const WHOLE_MONTH_LIMIT_MS = 208;
const LONGEST_DAY_LIMIT_MS = 20;
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
      const wholes: number[] = [];
      let walkers = 0;
      const legs = state.movement.counts.legs;
      for (let month = 0; month < MEASURED; month++) {
        // Les jours ordinaires du mois, chacun mesuré, puis, comme l'hôte du worker, le pas
        // mensuel du trentième jour et l'image des groupes, de ses membres.
        let whole = 0;
        for (let day = 1; day < DAYS_PER_MONTH; day++) {
          const start = performance.now();
          advanceDay(state, [], data);
          const time = performance.now() - start;
          days.push(time);
          whole += time;
          walkers += state.movement.walkers;
        }
        const start = performance.now();
        const members = advanceDay(state, [], data);
        const middle = performance.now();
        groupsFrame(state, data, members);
        steps.push(middle - start);
        frames.push(performance.now() - middle);
        wholes.push(whole + middle - start);
      }
      const total = steps.map((time, index) => time + (frames[index] ?? 0));
      const mean = (times: readonly number[]) =>
        times.reduce((sum, time) => sum + time, 0) / times.length;
      const sorted = [...total].sort((a, b) => a - b);
      const longest = Math.max(...days);
      const format = (time: number) => `${time.toFixed(1)} ms`;
      const limit = STEP_LIMIT_MS[people] ?? 0;
      process.stdout.write(
        `${String(people).padStart(6)} semés, de ${String(before)} à ` +
          `${String(state.people.count)} vivants pendant la mesure, ` +
          `${String(state.society.groups.size)} groupes : pas mensuel ${format(mean(steps))}, ` +
          `image ${format(mean(frames))}, total moyen ${format(mean(total))}, ` +
          `p95 ${format(percentile(sorted, 0.95))}, max ${format(sorted.at(-1) ?? 0)} ` +
          `(seuil ${format(limit)}) ; jour ${mean(days).toFixed(3)} ms, ` +
          `p95 ${format(
            percentile(
              [...days].sort((a, b) => a - b),
              0.95,
            ),
          )}, ` +
          `le plus long ${format(longest)} ; mois entier ${format(mean(wholes))}, ` +
          `${(walkers / days.length).toFixed(0)} marcheurs et ` +
          `${((state.movement.counts.legs - legs) / (MEASURED * DAYS_PER_MONTH)).toFixed(0)} ` +
          `étapes par jour en moyenne ; empreinte ${fingerprint(state)}\n`,
      );
      expect(mean(total)).toBeLessThan(limit);
      if (people === 50_000) {
        expect(mean(wholes)).toBeLessThan(WHOLE_MONTH_LIMIT_MS);
        expect(longest).toBeLessThan(LONGEST_DAY_LIMIT_MS);
      }
    });
  }
});
