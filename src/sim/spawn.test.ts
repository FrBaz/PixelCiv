import { describe, expect, it } from 'vitest';
import { checkContent } from '../core/data';
import { loadCatalog } from '../core/data/catalog';
import { spawnAdultAges, SpeciesListSchema, type Species } from '../core/data/people';
import { emptyLayers, WORLD_SIZES } from '../core/world';
import { GameCommandSchema } from './commands';
import { MONTHS_PER_YEAR } from './people';
import { NEVER, NONE } from './population';
import { membersOf, spawnGroup } from './spawn';
import { createState, type SimState } from './state';
import { step, type SimContent } from './step';
import {
  firstCellOf,
  flatState,
  testData,
  testHuman,
  testParams,
  testState,
  withHuman,
} from './testing';

const spawn = (x: number, y: number, count = 20, subspecies = 'nordic') =>
  ({ type: 'spawnGroup', x, y, species: 'human', subspecies, count }) as const;

/** Un groupe de chaque taille, de 2 à 50 membres, `rounds` fois, sur la steppe. */
function spawnedSizes(content: SimContent, rounds = 1): SimState {
  const state = flatState();
  for (let round = 0; round < rounds; round++) {
    for (let count = 2; count <= 50; count++) {
      spawnGroup(state, spawn(10 + count, 60 + round, count, 'plains'), content);
    }
  }
  return state;
}

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

  it("ne fait rien apparaître sur l'eau, ni sur un sommet qu'on ne franchit pas", () => {
    const state = testState();
    const water = firstCellOf(state, (family) => family === 'water');
    step(state, [spawn(water.x, water.y)], testData);
    expect(state.society.groups.size).toBe(0);
    // Un glacier de la steppe, à 5 000 m : son biome se marche, son étage, non.
    const world = emptyLayers(WORLD_SIZES.small);
    world.biome.fill(testData.biomes.indexOf('glacier') ?? 0);
    world.elevation.fill(120);
    world.elevation[60 * WORLD_SIZES.small.width + 10] = 5000;
    const summit = createState(testParams('sommet'), world, testData);
    expect(Number.isFinite(summit.cost[60 * WORLD_SIZES.small.width + 10])).toBe(false);
    expect(Number.isFinite(summit.cost[60 * WORLD_SIZES.small.width + 11])).toBe(true);
    step(summit, [spawn(10, 60)], testData);
    expect(summit.society.groups.size).toBe(0);
    expect(summit.people.count).toBe(0);
    // Sur le monde généré aussi : aucune case de coût infini ne reçoit de groupe.
    const generated = testState();
    const peaks: number[] = [];
    generated.cost.forEach((cost, cell) => {
      const biome = testData.biomes.entries.at(generated.world.biome[cell] ?? 0);
      if (!Number.isFinite(cost) && biome?.movementCost !== null) peaks.push(cell);
    });
    for (const cell of peaks.slice(0, 5)) {
      const { width } = generated.size;
      spawnGroup(generated, spawn(cell % width, Math.floor(cell / width)), testData);
    }
    expect(generated.society.groups.size).toBe(0);
  });

  it("n'accepte que des groupes de deux à cinquante membres", () => {
    expect(GameCommandSchema.safeParse(spawn(1, 1, 1)).success).toBe(false);
    expect(GameCommandSchema.safeParse(spawn(1, 1, 51)).success).toBe(false);
    expect(GameCommandSchema.safeParse(spawn(1, 1, 50)).success).toBe(true);
  });

  it('forme des familles vraisemblables : fratries espacées, parents en âge (L-4)', () => {
    const state = spawnedSizes(testData, 6);
    const { people, tick } = state;
    const { fertility, couple, maturity } = testHuman;
    const [youngest, eldest] = spawnAdultAges(testHuman);
    // Naissances des enfants de chaque mère.
    const births = new Map<number, number[]>();
    let children = 0;
    people.forEach((slot) => {
      const age = people.age(slot, tick);
      expect(Number.isInteger(age)).toBe(true);
      const mother = people.slotOf(people.get('mother', slot));
      const father = people.slotOf(people.get('father', slot));
      if (mother === undefined || father === undefined) {
        // Un fondateur : un adulte en âge d'être en couple.
        expect(people.get('mother', slot)).toBe(NONE);
        expect(age).toBeGreaterThanOrEqual(youngest);
        expect(age).toBeLessThanOrEqual(eldest);
        return;
      }
      children++;
      const birth = people.get('birth', slot);
      expect(age).toBeLessThan(maturity * MONTHS_PER_YEAR);
      // À sa naissance, ses parents étaient en âge d'être en couple, et sa mère féconde.
      expect(birth - people.get('birth', mother)).toBeGreaterThanOrEqual(
        Math.max(fertility.from, couple.minAge) * MONTHS_PER_YEAR,
      );
      expect(birth - people.get('birth', mother)).toBeLessThanOrEqual(
        fertility.to * MONTHS_PER_YEAR,
      );
      expect(birth - people.get('birth', father)).toBeGreaterThanOrEqual(
        couple.minAge * MONTHS_PER_YEAR,
      );
      const list = births.get(mother) ?? [];
      list.push(birth);
      births.set(mother, list);
    });
    expect(children).toBeGreaterThan(1000);
    // Deux enfants d'une même mère naissent à une grossesse et un allaitement d'écart au
    // moins, et le dernier accouchement de la mère est celui du plus jeune.
    let siblings = 0;
    for (const [mother, list] of births) {
      list.sort((a, b) => a - b);
      for (let index = 1; index < list.length; index++) {
        siblings++;
        expect((list[index] ?? 0) - (list[index - 1] ?? 0)).toBeGreaterThanOrEqual(
          fertility.gestation + fertility.postpartum,
        );
      }
      expect(people.get('lastBirth', mother)).toBe(list.at(-1));
    }
    expect(siblings).toBeGreaterThan(300);
    // Les mères sans enfant n'ont pas accouché.
    people.forEach((slot) => {
      if (people.get('sex', slot) !== 0 || births.has(slot)) return;
      expect(people.get('lastBirth', slot)).toBe(NEVER);
    });
  });

  it('fait apparaître toute espèce que le schéma accepte, sans erreur et en deçà de sa longévité (L-2)', () => {
    const variants: Species[] = [
      { ...testHuman, couple: { ...testHuman.couple, minAge: 16.5 } },
      { ...testHuman, fertility: { ...testHuman.fertility, peak: 24.5 } },
      // Une espèce brève, aînée à 25 ans, et une espèce qui vit des siècles.
      { ...testHuman, longevity: 30, ages: { ...testHuman.ages, elder: 25 } },
      {
        ...testHuman,
        maturity: 30,
        longevity: 300,
        couple: { minAge: 50, maxGap: 40 },
        fertility: { ...testHuman.fertility, from: 40, peak: 70, to: 150, maleTo: 200 },
      },
    ];
    for (const variant of variants) {
      const species = loadCatalog('variante', SpeciesListSchema, [variant]);
      const content = { ...testData, species };
      expect(checkContent({ ...testData, species })).toEqual([]);
      const entry = species.entries[0] ?? testHuman;
      const [youngest, eldest] = spawnAdultAges(entry);
      let state: SimState | undefined;
      expect(() => {
        state = spawnedSizes(content);
      }).not.toThrow();
      if (state === undefined) return;
      // Les 49 groupes, de 2 à 50 membres, sont au complet.
      expect(state.people.count).toBe((2 + 50) * 49 * 0.5);
      const { people, tick } = state;
      people.forEach((slot) => {
        const age = people.age(slot, tick);
        expect(Number.isInteger(age)).toBe(true);
        expect(age).toBeLessThanOrEqual(eldest);
        expect(age).toBeLessThan((entry.longevity - 1) * MONTHS_PER_YEAR + 1);
        if (people.get('mother', slot) === NONE) expect(age).toBeGreaterThanOrEqual(youngest);
      });
    }
    // Une espèce dont les couples se formeraient après la fin de la fécondité est refusée.
    const late = { ...testHuman, couple: { ...testHuman.couple, minAge: 46 } };
    expect(SpeciesListSchema.safeParse([late]).success).toBe(false);
    const short = { ...testHuman, maturity: 10, longevity: 16.5 };
    expect(SpeciesListSchema.safeParse([short]).success).toBe(false);
  });

  it('donne aux enfants le nom que fixe la règle de la culture (IND-08)', () => {
    const rules = ['father', 'mother', 'both', 'none', 'earned'] as const;
    for (const rule of rules) {
      const content = {
        ...testData,
        cultures: {
          naming: { father: 0, mother: 0, both: 0, none: 0, earned: 0, [rule]: 1 },
        },
      };
      const state = spawnedSizes(content);
      const { people } = state;
      for (const culture of state.society.cultures) expect(culture.naming).toBe(rule);
      let children = 0;
      people.forEach((slot) => {
        const code = people.get('familyName', slot);
        const language = people.get('familyLanguage', slot);
        // La langue du nom de famille est celle de la culture du groupe.
        const culture = state.society.cultures.at(people.get('culture', slot) - 1);
        expect(language).toBe(culture?.language);
        const mother = people.slotOf(people.get('mother', slot));
        const father = people.slotOf(people.get('father', slot));
        if (mother === undefined || father === undefined) {
          // Un fondateur n'a de nom de famille que si sa culture en donne.
          if (rule === 'none') expect(code).toBe(0);
          else expect(code).not.toBe(0);
          return;
        }
        children++;
        const of = (parent: number) => people.get('familyName', parent);
        if (rule === 'father' || rule === 'both') expect(code).toBe(of(father));
        if (rule === 'mother') expect(code).toBe(of(mother));
        if (rule === 'none') expect(code).toBe(0);
        if (rule === 'earned') {
          // Un nom obtenu, propre à chacun : il ne vient d'aucun parent.
          expect(code).not.toBe(0);
          expect(code).not.toBe(of(father));
          expect(code).not.toBe(of(mother));
        }
      });
      expect(children).toBeGreaterThan(50);
    }
  });

  it("donne à l'homme d'un couple au plus l'écart d'âge permis", () => {
    const state = spawnedSizes(
      withHuman((human) => human),
      2,
    );
    const gap = testHuman.couple.maxGap * MONTHS_PER_YEAR;
    let couples = 0;
    state.people.forEach((slot) => {
      const partner = state.people.slotOf(state.people.get('partner', slot));
      if (partner === undefined) return;
      couples++;
      expect(
        Math.abs(state.people.get('birth', slot) - state.people.get('birth', partner)),
      ).toBeLessThanOrEqual(gap);
    });
    expect(couples).toBeGreaterThan(400);
  });
});
