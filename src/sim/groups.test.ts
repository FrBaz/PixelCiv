import { describe, expect, it } from 'vitest';
import { readSave, writeSave } from '../core/save/format';
import { GENERATOR_VERSION } from '../worldgen/generate';
import { cellDistance, groupMembers, mergeGroup, splitGroup, walk } from './groups';
import { NONE } from './population';
import { MIGRATIONS, restoreState, saveState } from './save';
import { spawnGroup } from './spawn';
import type { SimState } from './state';
import { fingerprint, step } from './step';
import { testData, testState } from './testing';

/** Première case d'un biome. */
function cellOf(state: SimState, biome: string): { x: number; y: number } {
  const cell = state.world.biome.indexOf(testData.biomes.indexOf(biome) ?? -1);
  if (cell < 0) throw new Error(`pas de case ${biome}`);
  return { x: cell % state.size.width, y: Math.floor(cell / state.size.width) };
}

/** Fait apparaître un groupe, sans faire passer de mois. */
function spawn(state: SimState, at: { x: number; y: number }, count = 30, subspecies = 'plains') {
  spawnGroup(state, { type: 'spawnGroup', ...at, species: 'human', subspecies, count }, testData);
  const group = [...state.society.groups.values()].at(-1);
  if (group === undefined) throw new Error('aucun groupe');
  return group;
}

describe('groupes nomades (tâche 2.5)', () => {
  it("marche une trentaine de cases de plaine par mois, sans jamais entrer dans l'eau", () => {
    const state = testState();
    const start = cellOf(state, 'grassland');
    const far = { x: (start.x + 200) % state.size.width, y: start.y };
    const reached = walk(state.cost, state.size, start, far, testData.nomads.walk);
    const covered = cellDistance(state.size.width, start.x, start.y, reached.x, reached.y);
    expect(covered).toBeLessThanOrEqual(testData.nomads.walk + 1e-9);
    // Sur dix années de nomadisme, aucun groupe ne se trouve sur une case infranchissable.
    spawn(state, start);
    for (let month = 0; month < 120; month++) {
      step(state, [], testData);
      for (const group of state.society.groups.values()) {
        expect(Number.isFinite(state.cost[group.y * state.size.width + group.x])).toBe(true);
      }
    }
  });

  it('se déplace au fil des saisons, sans trop s’écarter de son aire', () => {
    const state = testState();
    const group = spawn(state, cellOf(state, 'temperate-forest'));
    const visited = new Set<number>();
    for (let month = 0; month < 36; month++) {
      step(state, [], testData);
      visited.add(group.y * state.size.width + group.x);
      expect(
        cellDistance(state.size.width, group.x, group.y, group.homeX, group.homeY),
      ).toBeLessThan(testData.nomads.range * 3);
    }
    expect(visited.size).toBeGreaterThan(5);
  });

  it('se scinde au-delà du seuil en deux groupes de même culture, familles réunies', () => {
    const state = testState();
    const group = spawn(state, cellOf(state, 'grassland'), 48);
    const members = groupMembers(state.people).get(group.id) ?? [];
    const random = state.rng.stream('tests');
    const child = splitGroup(state, group, members, testData, random);
    expect(child).toBeDefined();
    expect(child?.culture).toBe(group.culture);
    expect(child?.parent).toBe(group.id);
    const after = groupMembers(state.people);
    const left = after.get(group.id)?.length ?? 0;
    const gone = after.get(child?.id ?? -1)?.length ?? 0;
    expect(left + gone).toBe(members.length);
    expect(Math.abs(left - gone)).toBeLessThan(members.length / 2);
    // Un enfant part avec sa mère.
    for (const slot of members) {
      const mother = state.people.slotOf(state.people.get('mother', slot));
      if (mother === undefined || state.people.age(slot, state.tick) >= 15 * 12) continue;
      expect(state.people.get('group', slot)).toBe(state.people.get('group', mother));
    }
    expect(state.society.chronicle.at(-1)).toMatchObject({ kind: 'groupSplit', group: group.id });
  });

  it('réunit un groupe trop petit à son voisin', () => {
    const state = testState();
    const at = cellOf(state, 'grassland');
    const big = spawn(state, at, 20);
    const small = spawn(state, at, 2);
    const merged = mergeGroup(state, small, groupMembers(state.people), testData);
    expect(merged).toBe(true);
    expect(state.society.groups.has(small.id)).toBe(false);
    expect(groupMembers(state.people).get(big.id)?.length ?? 0).toBeGreaterThanOrEqual(21);
  });

  it('marie des célibataires de deux groupes voisins de même culture', () => {
    const state = testState();
    const at = cellOf(state, 'grassland');
    const a = spawn(state, at, 20);
    const b = spawn(state, at, 20);
    // Même culture, et des célibataires d'un seul sexe de chaque côté.
    Object.assign(b, { culture: a.culture });
    const members = groupMembers(state.people);
    for (const [group, sex] of [
      [a.id, 0],
      [b.id, 1],
    ] as const) {
      for (const slot of members.get(group) ?? []) {
        const partner = state.people.slotOf(state.people.get('partner', slot));
        if (partner !== undefined) state.people.set('partner', partner, NONE);
        state.people.set('partner', slot, NONE);
        state.people.set('sex', slot, sex);
        state.people.set('birth', slot, state.tick - 20 * 12);
        state.people.set('mother', slot, NONE);
        state.people.set('father', slot, NONE);
      }
    }
    for (let month = 0; month < 12; month++) step(state, [], testData);
    let couples = 0;
    state.people.forEach((slot) => {
      const partner = state.people.slotOf(state.people.get('partner', slot));
      if (partner === undefined) return;
      couples++;
      // Le couple vit dans le même groupe.
      expect(state.people.get('group', slot)).toBe(state.people.get('group', partner));
    });
    expect(couples).toBeGreaterThan(4);
  });

  it('se sauvegarde en pleine nomadisation, et se poursuit à l’identique', async () => {
    const state = testState();
    spawn(state, cellOf(state, 'temperate-forest'));
    for (let month = 0; month < 30; month++) step(state, [], testData);
    expect(state.food.list.length).toBeGreaterThan(0);
    const restored = restoreState(
      await readSave(await writeSave(saveState(state, GENERATOR_VERSION, testData)), MIGRATIONS),
      testData,
    );
    expect(fingerprint(restored)).toBe(fingerprint(state));
    for (let month = 0; month < 24; month++) {
      step(state, [], testData);
      step(restored, [], testData);
    }
    expect(fingerprint(restored)).toBe(fingerprint(state));
  });
});
