import { describe, expect, it } from 'vitest';
import { GameCommandSchema } from './commands';
import { NONE } from './population';
import { membersOf, spawnGroup } from './spawn';
import { step } from './step';
import { firstCellOf, testData, testState } from './testing';

const spawn = (x: number, y: number, count = 20, subspecies = 'nordic') =>
  ({ type: 'spawnGroup', x, y, species: 'human', subspecies, count }) as const;

describe("apparition d'un groupe (CRE-03, C2 D4)", () => {
  it('forme un groupe de familles, avec sa langue et sa culture embryonnaires', () => {
    const state = testState();
    const cell = firstCellOf(state, (family) => family === 'temperate');
    // L'apparition seule, sans le mois qui suit, où le groupe se déplacerait déjà.
    spawnGroup(state, spawn(cell.x, cell.y, 20), testData);
    const group = [...state.society.groups.values()].at(0);
    if (group === undefined) throw new Error('aucun groupe');
    expect(group).toMatchObject({ x: cell.x, y: cell.y, culture: 1, parent: NONE });
    expect(state.society.languages).toHaveLength(1);
    expect(state.society.cultures[0]).toMatchObject({ id: 1, language: 1 });
    const members = membersOf(state.people, group.id);
    expect(members).toHaveLength(20);
    // Des couples, et des enfants nés d'eux, dans le même groupe.
    let couples = 0;
    let children = 0;
    for (const slot of members) {
      if (state.people.slotOf(state.people.get('partner', slot)) !== undefined) couples++;
      const mother = state.people.slotOf(state.people.get('mother', slot));
      if (mother !== undefined) {
        children++;
        expect(state.people.get('group', mother)).toBe(group.id);
        expect(state.people.get('birth', slot)).toBeGreaterThan(state.people.get('birth', mother));
      }
    }
    expect(couples).toBeGreaterThanOrEqual(4);
    expect(children).toBeGreaterThan(0);
  });

  it("ne fait rien apparaître sur l'eau", () => {
    const state = testState();
    const water = firstCellOf(state, (family) => family === 'water');
    step(state, [spawn(water.x, water.y)], testData);
    expect(state.society.groups.size).toBe(0);
    expect(state.people.count).toBe(0);
  });

  it("n'accepte que des groupes de deux à cinquante membres", () => {
    expect(GameCommandSchema.safeParse(spawn(1, 1, 1)).success).toBe(false);
    expect(GameCommandSchema.safeParse(spawn(1, 1, 51)).success).toBe(false);
    expect(GameCommandSchema.safeParse(spawn(1, 1, 50)).success).toBe(true);
  });
});
