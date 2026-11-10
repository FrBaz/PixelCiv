import { describe, expect, it } from 'vitest';
import { DEATH_CAUSES } from './population';
import {
  cellFood,
  deplete,
  depletedCells,
  feedGroup,
  FOOD_STRIDE,
  plantSeason,
  regrowFood,
  totalStock,
} from './forage';
import { groupMembers } from './groups';
import type { SimState } from './state';
import { step } from './step';
import { testData, testState } from './testing';

/** Première case d'un biome, et sa position. */
function cellOf(state: SimState, biome: string): { cell: number; x: number; y: number } {
  const index = testData.biomes.indexOf(biome);
  const cell = state.world.biome.indexOf(index ?? -1);
  if (cell < 0) throw new Error(`pas de case ${biome}`);
  return { cell, x: cell % state.size.width, y: Math.floor(cell / state.size.width) };
}

/** Morts de faim depuis le début de la partie. */
function famine(state: SimState): number {
  const code = DEATH_CAUSES.indexOf('famine');
  let count = 0;
  for (let row = 0; row < state.people.archive.rows; row++) {
    if (state.people.archive.columns.cause[row] === code) count++;
  }
  return count;
}

describe('survie (tâche 2.4)', () => {
  it("ne fait pousser les plantes qu'à la belle saison, moins à la saison sèche", () => {
    expect(plantSeason(-5, 1)).toBe(0);
    expect(plantSeason(20, 1)).toBe(1);
    expect(plantSeason(20, 0.5)).toBeLessThan(plantSeason(20, 1));
  });

  it('tient une case intacte au plafond, la suit une fois entamée, puis la libère', () => {
    const state = testState();
    const { cell } = cellOf(state, 'temperate-forest');
    // Juillet au nord : la belle saison.
    const july = 6;
    const full = totalStock(state.food, state.world, state.size, cell, july, testData);
    expect(full).toBeGreaterThan(0);
    state.food.stocks.fill(0, cell * FOOD_STRIDE, cell * FOOD_STRIDE + FOOD_STRIDE);
    deplete(state.food, cell);
    expect(state.food.count).toBe(1);
    expect(totalStock(state.food, state.world, state.size, cell, july, testData)).toBe(0);
    for (let month = 0; month < 48 && state.food.count > 0; month++) {
      regrowFood(state.food, state.world, state.size, july, testData);
    }
    expect(depletedCells(state.food)).toEqual([]);
    expect(state.food.count).toBe(0);
    expect(state.food.depleted[cell]).toBe(0);
  });

  it("épuise ce qu'un groupe exploite sans bouger, et la faim s'installe", () => {
    const state = testState();
    const { x, y } = cellOf(state, 'grassland');
    step(
      state,
      [{ type: 'spawnGroup', x, y, species: 'human', subspecies: 'plains', count: 40 }],
      testData,
    );
    const group = [...state.society.groups.values()].at(0);
    if (group === undefined) throw new Error('aucun groupe');
    const members = groupMembers(state.people).get(group.id) ?? [];
    group.food = 0;
    let fed = 1;
    // Sans repousse ni déplacement, mois après mois.
    for (let month = 0; month < 24; month++) {
      fed = feedGroup(
        group,
        members,
        state.people,
        state.food,
        state.world,
        state.size,
        state.tick,
        testData,
      );
    }
    expect(fed).toBeLessThan(0.5);
    for (const slot of members) expect(state.people.get('nutrition', slot)).toBeLessThan(200);
  });

  it('nourrit mieux un groupe en prairie tempérée qu’en toundra', () => {
    const run = (biome: string) => {
      const state = testState();
      const { x, y } = cellOf(state, biome);
      step(
        state,
        [{ type: 'spawnGroup', x, y, species: 'human', subspecies: 'nordic', count: 30 }],
        testData,
      );
      for (let month = 0; month < 10 * 12; month++) step(state, [], testData);
      return { famine: famine(state), alive: state.people.count };
    };
    const grassland = run('grassland');
    const tundra = run('tundra');
    expect(tundra.famine).toBeGreaterThan(grassland.famine);
    expect(grassland.alive).toBeGreaterThan(tundra.alive);
  });

  it('pêche dans les rivières, la mer côtière et les lacs (RES-04)', () => {
    const state = testState();
    for (const biome of ['coastal-ocean', 'lake']) {
      const { cell } = cellOf(state, biome);
      expect(cellFood(state.world, state.size, cell, 6, testData)[5]).toBeGreaterThan(0);
    }
    // Une case de terre traversée par une rivière a son poisson.
    const river = state.world.drainage.findIndex((code, cell) => {
      const family = testData.biomes.entries.at(state.world.biome[cell] ?? 0)?.family;
      return code >> 4 >= 2 && family !== 'water';
    });
    expect(river).toBeGreaterThanOrEqual(0);
    expect(cellFood(state.world, state.size, river, 6, testData)[5]).toBeGreaterThan(0);
  });
});
