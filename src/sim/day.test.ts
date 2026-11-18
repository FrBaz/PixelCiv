import { describe, expect, it } from 'vitest';
import type { GameCommand } from '../core/protocol';
import { DAYS_PER_MONTH } from '../core/time';
import { advanceDay, step } from './day';
import { DayPositions } from './walks';
import { fingerprint, type SimContent } from './step';
import type { SimState } from './state';
import { firstCellOf, scatteredGroups, testData, testState } from './testing';

/** Commandes du premier jour de quelques mois : des apparitions, et un coup de pinceau. */
function monthlyCommands(state: SimState): Map<number, GameCommand[]> {
  const spawns = scatteredGroups(state, 12, 20);
  const cell = firstCellOf(state, (family) => family !== 'water');
  return new Map<number, GameCommand[]>([
    [0, spawns.slice(0, 6)],
    [2, [{ type: 'paintBiome', ...cell, biome: 'desert' }]],
    [5, spawns.slice(6)],
  ]);
}

describe('sous-pas quotidien (ADR 0013)', () => {
  it('fait passer un jour, et le pas mensuel au soir du trentième', () => {
    const state = testState();
    for (let day = 1; day < DAYS_PER_MONTH; day++) {
      expect(advanceDay(state, [], testData)).toBeUndefined();
      expect([state.tick, state.day]).toEqual([0, day]);
    }
    const members = advanceDay(state, [], testData);
    expect(members).toBeInstanceOf(Map);
    expect([state.tick, state.day]).toEqual([1, 0]);
    // step fait passer le reste du mois, même commencé.
    for (let day = 0; day < 12; day++) advanceDay(state, [], testData);
    step(state, [], testData);
    expect([state.tick, state.day]).toEqual([2, 0]);
  });

  it('donne le même état, que les jours passent un à un, par lots, ou par mois entiers', () => {
    const prints = new Map<string, string>();
    for (const batch of [1, 2, 3, 7, DAYS_PER_MONTH]) {
      const state = testState();
      const commands = monthlyCommands(state);
      while (state.tick < 12) {
        // Un lot : au plus `batch` jours, comme l'hôte qui s'arrête après le pas mensuel.
        for (let day = 0; day < batch; day++) {
          const due = state.day === 0 ? (commands.get(state.tick) ?? []) : [];
          if (advanceDay(state, due, testData) !== undefined) break;
        }
      }
      prints.set(`lots de ${String(batch)} jours`, fingerprint(state));
    }
    const monthly = testState();
    const commands = monthlyCommands(monthly);
    for (let month = 0; month < 12; month++) step(monthly, commands.get(month) ?? [], testData);
    expect(monthly.society.groups.size).toBeGreaterThan(6);
    for (const [label, print] of prints) expect(print, label).toBe(fingerprint(monthly));
  });

  it('laisse le jour au dernier du mois si le pas mensuel échoue, et recalcule les positions', () => {
    // Un contenu qui fait échouer le pas mensuel, avant ou après l'oubli des marches passées.
    let armed: 'before' | 'after' | undefined;
    const state = testState();
    const broken = {
      ...testData,
      get nomads() {
        if (armed === 'before') throw new TypeError('défaut du mois');
        if (armed === 'after' && state.walks.count === 0) throw new TypeError('défaut du mois');
        return testData.nomads;
      },
    } satisfies SimContent;
    step(state, scatteredGroups(state, 40, 30), testData);
    step(state, [], testData);
    for (let day = 1; day < DAYS_PER_MONTH; day++) advanceDay(state, [], testData);
    expect(state.walks.count).toBeGreaterThan(0);
    for (const when of ['before', 'after'] as const) {
      armed = when;
      expect(() => advanceDay(state, [], broken), when).toThrow(TypeError);
      expect([state.tick, state.day], when).toEqual([2, DAYS_PER_MONTH - 1]);
      // Les positions suivent l'état tel qu'il est resté : les marches, si elles restent.
      const fresh = new DayPositions();
      fresh.rebuild(state.society.groups.values(), state.walks, state.day, state.size.width);
      expect(state.dayPositions.positions, when).toEqual(fresh.positions);
      expect(state.dayPositions.walking, when).toBe(fresh.walking);
    }
    expect(state.walks.count).toBe(0);
    // Le défaut passé, le pas mensuel se refait.
    armed = undefined;
    expect(advanceDay(state, [], broken)).toBeInstanceOf(Map);
    expect([state.tick, state.day]).toEqual([3, 0]);
  });
});
