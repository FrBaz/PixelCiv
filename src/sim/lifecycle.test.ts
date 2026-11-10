import { describe, expect, it } from 'vitest';
import type { SpawnGroupCommand } from '../core/protocol';
import { fertilityAt, monthlyProbability, silerHazards } from './lifecycle';
import { DEATH_CAUSES, FEMALE, NONE } from './population';
import { closeKin, monthOf } from './people';
import { membersOf } from './spawn';
import type { SimState } from './state';
import { fingerprint, step } from './step';
import { testData, testState } from './testing';

const human = testData.species.entries.at(0);
if (human === undefined) throw new Error('pas d’humains dans les données');

/** Cases de terre des biomes voulus, espacées. */
function cells(state: SimState, biomes: readonly string[], count: number) {
  const found: { x: number; y: number }[] = [];
  const { width } = state.size;
  for (let index = 0; index < state.world.biome.length && found.length < count; index += 211) {
    const biome = testData.biomes.entries.at(state.world.biome[index] ?? 0);
    if (biome !== undefined && biomes.includes(biome.id)) {
      found.push({ x: index % width, y: Math.floor(index / width) });
    }
  }
  return found;
}

function spawn(
  state: SimState,
  biomes: readonly string[],
  groups: number,
  subspecies = 'plains',
): SpawnGroupCommand[] {
  return cells(state, biomes, groups).map((cell) => ({
    type: 'spawnGroup',
    ...cell,
    species: 'human',
    subspecies,
    count: 30,
  }));
}

function run(state: SimState, months: number): void {
  for (let month = 0; month < months; month++) step(state, [], testData);
}

/** Morts d'une cause, depuis le début de la partie. */
function deathsBy(state: SimState, cause: string): number {
  const code = DEATH_CAUSES.indexOf(cause as (typeof DEATH_CAUSES)[number]);
  let count = 0;
  for (let row = 0; row < state.people.archive.rows; row++) {
    if (state.people.archive.columns.cause[row] === code) count++;
  }
  return count;
}

describe('cycle de vie (tâche 2.3)', () => {
  it("donne aux humains l'espérance de vie de chasseurs-cueilleurs", () => {
    // Table de mortalité tirée de Siler : espérance de vie à la naissance, survie à 15 ans.
    let alive = 1;
    let expectancy = 0;
    let at15 = 0;
    for (let month = 0; month < human.longevity * 12; month++) {
      const hazards = silerHazards(human, month / 12);
      alive *= 1 - monthlyProbability(hazards.infant + hazards.background + hazards.senescence);
      expectancy += alive / 12;
      if (month === 15 * 12) at15 = alive;
    }
    expect(expectancy).toBeGreaterThan(28);
    expect(expectancy).toBeLessThan(42);
    expect(at15).toBeGreaterThan(0.5);
    expect(at15).toBeLessThan(0.7);
  });

  it('borne la fécondité féminine à sa période, avec un sommet', () => {
    const { from, peak, to } = human.fertility;
    expect(fertilityAt(human, from - 1)).toBe(0);
    expect(fertilityAt(human, to)).toBe(0);
    expect(fertilityAt(human, peak + 1)).toBe(1);
    expect(fertilityAt(human, from + 1)).toBeLessThan(fertilityAt(human, peak));
  });

  it('fait naître, vivre et mourir : une population nourrie se maintient et croît', () => {
    const state = testState();
    step(state, spawn(state, ['temperate-forest', 'grassland'], 4), testData);
    // Quatre groupes de trente, dont la mort a pu emporter un membre dès le premier mois.
    const appeared = state.society.chronicle.filter((entry) => entry.kind === 'groupAppeared');
    expect(appeared.reduce((sum, entry) => sum + entry.count, 0)).toBe(120);
    const start = state.people.count;
    expect(start).toBeGreaterThan(110);
    run(state, 50 * 12);
    expect(state.people.count).toBeGreaterThan(start);
    expect(state.people.count).toBeLessThan(start * 4);
    expect(state.people.archive.rows).toBeGreaterThan(50);
    // Chaque enfant né en partie a ses deux parents, et vit dans le groupe de sa mère ou
    // l'a quitté avec elle ; aucun couple ne réunit de proches parents.
    let born = 0;
    state.people.forEach((slot) => {
      if (state.people.get('birth', slot) <= 0) return;
      born++;
      expect(state.people.get('mother', slot)).not.toBe(NONE);
      expect(state.people.get('father', slot)).not.toBe(NONE);
      const partner = state.people.slotOf(state.people.get('partner', slot));
      if (partner !== undefined) expect(closeKin(state.people, slot, partner)).toBe(false);
    });
    expect(born).toBeGreaterThan(50);
  });

  it('donne à l’enfant le nom de famille que fixe la règle de sa culture (IND-08)', () => {
    const state = testState();
    step(state, spawn(state, ['temperate-forest', 'grassland'], 4), testData);
    run(state, 20 * 12);
    let checked = 0;
    state.people.forEach((slot) => {
      if (state.people.get('birth', slot) <= 0) return;
      const culture = state.society.cultures.at(state.people.get('culture', slot) - 1);
      const parent = (key: 'mother' | 'father') => {
        const id = state.people.get(key, slot);
        const living = state.people.slotOf(id);
        if (living !== undefined) return state.people.get('familyName', living);
        return state.people.archive.columns.familyName[state.people.archivedRow(id) ?? 0] ?? 0;
      };
      const name = state.people.get('familyName', slot);
      if (culture?.naming === 'mother') expect(name).toBe(parent('mother'));
      else if (culture?.naming === 'none') expect(name).toBe(0);
      else expect(name).toBe(parent('father'));
      checked++;
    });
    expect(checked).toBeGreaterThan(10);
  });

  it("tue davantage de froid les fragiles d'une sous-espèce des sables que les nordiques", () => {
    // Des cases dont le mois le plus froid descend sous −10 °C.
    const state = testState();
    const cold = cells(state, ['taiga', 'cold-forest', 'tundra', 'cold-steppe'], 400).filter(
      ({ x, y }) => {
        const cell = y * state.size.width + x;
        return (state.world.temperature[cell] ?? 0) - (state.world.amplitude[cell] ?? 0) < -100;
      },
    );
    expect(cold.length).toBeGreaterThan(12);
    const command = (subspecies: string, index: number): SpawnGroupCommand => ({
      type: 'spawnGroup',
      x: cold[index]?.x ?? 0,
      y: cold[index]?.y ?? 0,
      species: 'human',
      subspecies,
      count: 30,
    });
    const nordic = testState();
    const sands = testState();
    step(
      nordic,
      cold.slice(0, 6).map((_, index) => command('nordic', index)),
      testData,
    );
    step(
      sands,
      cold.slice(0, 6).map((_, index) => command('sands', index)),
      testData,
    );
    run(nordic, 20 * 12);
    run(sands, 20 * 12);
    expect(deathsBy(sands, 'cold')).toBeGreaterThan(deathsBy(nordic, 'cold') * 1.5);
  });

  it('éteint un groupe dont le dernier membre meurt, et la chronique le note', () => {
    const state = testState();
    step(state, spawn(state, ['grassland', 'temperate-forest'], 1), testData);
    const group = [...state.society.groups.keys()][0] ?? 0;
    for (const slot of membersOf(state.people, group))
      state.people.remove(slot, state.tick, 'accident');
    step(state, [], testData);
    expect(state.society.groups.has(group)).toBe(false);
    expect(state.society.chronicle.at(-1)).toMatchObject({ kind: 'groupExtinct', group });
  });

  it('est déterministe : les mêmes commandes donnent la même histoire', () => {
    const a = testState();
    const b = testState();
    const commands = spawn(a, ['grassland', 'temperate-forest'], 2);
    step(a, commands, testData);
    step(b, commands, testData);
    run(a, 10 * 12);
    run(b, 10 * 12);
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(a.people.archive.rows).toBeGreaterThan(0);
    expect(monthOf(a.tick)).toBeCloseTo((a.tick % 12) + 0.5, 9);
    let women = 0;
    a.people.forEach((slot) => {
      if (a.people.get('sex', slot) === FEMALE) women++;
    });
    expect(women).toBeGreaterThan(0);
  });
});
