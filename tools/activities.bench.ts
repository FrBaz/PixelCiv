/**
 * Banc des activités (tâche 2b.8, relecture ; ADR 0021, ADR 0022 § 2) : ce que la partie fait
 * vraiment des séjours que les données tirent. Sur le monde des tests de trois graines, soixante
 * groupes de vingt-cinq, trois cents jours : chaque séjour lu dans l'état (des jours consécutifs
 * au repos, hors de sa place au camp, à la même position, à la même activité), sa durée, ce qui le
 * coupe (le plan du mois, quand l'activité suivante est le suivi du groupe), et la part du temps de
 * chaque activité. Il se lance par `npm run bench`, hors des tests, et n'impose rien : c'est une
 * mesure de contrôle, à relire quand les données des activités ou le plan du mois changent.
 */
import { describe, expect, it } from 'vitest';
import { ACT_RANK } from '../src/core/protocol';
import { dayIndex } from '../src/core/time';
import { advanceDay } from '../src/sim/day';
import { INTENTION, REST } from '../src/sim/population';
import { scatteredGroups, testData, testState } from '../src/sim/testing';

const GROUPS = 60;
const DAYS = 300;
/** Jours de mise en route, dont les séjours ne se comptent pas. */
const WARMUP = 60;

describe('séjours réalisés des activités', () => {
  for (const seed of ['pixelciv', 'graine', 'autre']) {
    it(`graine ${seed}`, { timeout: 600_000 }, () => {
      const state = testState(seed);
      const ids = testData.activities.activities.map((activity) => activity.id);
      const follow = testData.activities.activities.findIndex((a) => a.place === 'camp');
      const rest = testData.activities.activities.findIndex((a) => a.place === 'home');
      const open = new Map<
        number,
        { rank: number; x: number; y: number; id: number; start: number }
      >();
      const stays = new Map<string, number[]>();
      const cut = new Map<string, number>();
      const time = new Map<string, number>();
      let samples = 0;
      const { columns } = state.people;
      for (let day = 0; day < DAYS; day++) {
        advanceDay(state, day === 0 ? scatteredGroups(state, GROUPS, 25) : [], testData);
        const now = dayIndex(state);
        for (let slot = 0; slot < state.people.end; slot++) {
          const alive = state.people.alive[slot] === 1 && (state.movement.carrier[slot] ?? -1) < 0;
          const rank = alive ? (columns.activity[slot] ?? ACT_RANK) & ACT_RANK : -1;
          const x = columns.x[slot] ?? 0;
          const y = columns.y[slot] ?? 0;
          const resting = alive && ((columns.move[slot] ?? 0) & INTENTION) === REST;
          const away = alive && (x !== columns.homeX[slot] || y !== columns.homeY[slot]);
          if (alive && day >= WARMUP) {
            samples++;
            const id = ids[rank] ?? 'aucune';
            time.set(id, (time.get(id) ?? 0) + 1);
          }
          const stay = open.get(slot);
          const same =
            stay !== undefined &&
            resting &&
            away &&
            stay.rank === rank &&
            stay.x === x &&
            stay.y === y &&
            stay.id === (columns.id[slot] ?? 0);
          if (same) continue;
          if (stay !== undefined) {
            if (stay.start >= WARMUP) {
              const id = ids[stay.rank] ?? '?';
              stays.set(id, [...(stays.get(id) ?? []), now - stay.start]);
              if (rank === follow) cut.set(id, (cut.get(id) ?? 0) + 1);
            }
            open.delete(slot);
          }
          if (resting && away && rank !== rest && rank !== follow && rank < ids.length) {
            open.set(slot, { rank, x, y, id: columns.id[slot] ?? 0, start: now });
          }
        }
      }
      const lines: string[] = [];
      for (const [id, list] of [...stays].sort()) {
        const sorted = [...list].sort((a, b) => a - b);
        const at = (share: number) =>
          sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))];
        const low = testData.activities.activities.find((a) => a.id === id)?.days?.[0] ?? 0;
        const under = sorted.filter((days) => days < low).length;
        lines.push(
          `  ${id} : ${String(sorted.length)} séjours, médiane ${String(at(0.5))} j, 90e centile ${String(at(0.9))} j, ` +
            `${((100 * under) / sorted.length).toFixed(0)} % sous le minimum tiré (${String(low)} j), ` +
            `${((100 * (cut.get(id) ?? 0)) / sorted.length).toFixed(0)} % coupés par le suivi du groupe`,
        );
      }
      const shares = [...time]
        .sort((a, b) => b[1] - a[1])
        .map(([id, count]) => `${id} ${((100 * count) / samples).toFixed(1)} %`)
        .join(', ');
      process.stdout.write(
        `graine ${seed}, ${String(state.people.count)} vivants au jour ${String(DAYS)} :\n${lines.join('\n')}\n  part du temps : ${shares}\n`,
      );
      expect(samples).toBeGreaterThan(0);
    });
  }
});
