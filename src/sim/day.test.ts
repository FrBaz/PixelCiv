import { describe, expect, it } from 'vitest';
import type { GameCommand } from '../core/protocol';
import { DAYS_PER_MONTH } from '../core/time';
import { advanceDay, step } from './day';
import { describeMovement, rebuildMovement } from './movement';
import { fingerprint, type SimContent } from './step';
import type { SimState } from './state';
import { replay } from './replay';
import {
  firstCellOf,
  scatteredGroups,
  testData,
  testParams,
  testState,
  testWorld,
} from './testing';

/** Clé d'un instant (mois, jour). */
const instant = (tick: number, day: number) => `${String(tick)}:${String(day)}`;

/**
 * Commandes à des instants fixés, au début du mois comme en cours de mois, au plus un
 * instant en cours de route par mois : des apparitions, et des coups de pinceau.
 */
function timedCommands(state: SimState): Map<string, GameCommand[]> {
  const spawns = scatteredGroups(state, 12, 20);
  const cell = firstCellOf(state, (family) => family !== 'water');
  return new Map<string, GameCommand[]>([
    [instant(0, 0), spawns.slice(0, 4)],
    [instant(1, 13), spawns.slice(4, 6)],
    [instant(2, 29), [{ type: 'paintBiome', ...cell, biome: 'desert' }]],
    [instant(5, 0), spawns.slice(6, 8)],
    [instant(5, 7), spawns.slice(8, 10)],
    [instant(8, 22), [...spawns.slice(10), { type: 'paintBiome', ...cell, biome: 'steppe' }]],
  ]);
}

describe('sous-pas quotidien (ADR 0013, ADR 0014)', () => {
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
    for (const batch of [1, 2, 3, 7]) {
      const state = testState();
      const commands = timedCommands(state);
      while (state.tick < 12) {
        // Un lot : au plus `batch` jours, comme l'hôte qui s'arrête après le pas mensuel ;
        // chaque jour applique d'abord les commandes de son instant.
        for (let day = 0; day < batch; day++) {
          const due = commands.get(instant(state.tick, state.day)) ?? [];
          if (advanceDay(state, due, testData) !== undefined) break;
        }
      }
      prints.set(`lots de ${String(batch)} jours`, fingerprint(state));
      expect(state.commandLog.map((entry) => instant(entry.tick, entry.day))).toEqual(
        [...commands.keys()].flatMap((key) => (commands.get(key) ?? []).map(() => key)),
      );
    }
    // Par mois entiers : step fait passer le reste du mois, depuis l'instant de ses
    // commandes ; un mois qui en a en cours de route y va d'abord jour après jour.
    const monthly = testState();
    const commands = timedCommands(monthly);
    for (let month = 0; month < 12; month++) {
      const days = [...commands.keys()].filter((key) => key.startsWith(`${String(month)}:`));
      const last = Math.max(0, ...days.map((key) => Number(key.split(':')[1])));
      while (monthly.day < last) {
        advanceDay(monthly, commands.get(instant(month, monthly.day)) ?? [], testData);
      }
      step(monthly, commands.get(instant(month, monthly.day)) ?? [], testData);
    }
    expect(monthly.society.groups.size).toBeGreaterThan(6);
    for (const [label, print] of prints) expect(print, label).toBe(fingerprint(monthly));
    // Le journal, rejoué jour par jour, redonne la même partie.
    const replayed = replay(
      testParams(),
      testWorld(),
      monthly.commandLog,
      { tick: 12, day: 0 },
      testData,
    );
    expect(fingerprint(replayed)).toBe(fingerprint(monthly));
  });

  it('laisse le jour au dernier du mois si le pas mensuel échoue, et refait les caches du mouvement', () => {
    // Un contenu qui fait échouer le pas mensuel au début (la repousse lit les biomes) ou à la
    // fin (le plan du mois lit camp.lag, que le sous-pas ne lit jamais).
    let armed: 'before' | 'after' | undefined;
    const camp = {
      ...testData.nomads.camp,
      get lag() {
        if (armed === 'after') throw new TypeError('défaut du plan');
        return testData.nomads.camp.lag;
      },
    };
    const broken = {
      ...testData,
      get biomes() {
        if (armed === 'before') throw new TypeError('défaut du mois');
        return testData.biomes;
      },
      nomads: { ...testData.nomads, camp },
    } satisfies SimContent;
    const state = testState();
    step(state, scatteredGroups(state, 40, 30), testData);
    step(state, [], testData);
    for (let day = 1; day < DAYS_PER_MONTH; day++) advanceDay(state, [], testData);
    expect(state.movement.activeCount).toBeGreaterThan(0);
    for (const when of ['before', 'after'] as const) {
      armed = when;
      expect(() => advanceDay(state, [], broken), when).toThrow(TypeError);
      expect([state.tick, state.day], when).toEqual([2, DAYS_PER_MONTH - 1]);
      // Les caches suivent l'état tel qu'il est resté : refaits, ils ne changent pas.
      const kept = describeMovement(state);
      expect(kept.problems, when).toEqual([]);
      rebuildMovement(state);
      expect(describeMovement(state).text, when).toBe(kept.text);
    }
    // Le défaut passé, le pas mensuel se refait.
    armed = undefined;
    expect(advanceDay(state, [], broken)).toBeInstanceOf(Map);
    expect([state.tick, state.day]).toEqual([3, 0]);
  });
});
