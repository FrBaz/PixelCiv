import { describe, expect, it } from 'vitest';
import { catalogOf } from '../core/data/catalog';
import type { FaunaSpecies } from '../core/data/fauna';
import { Fingerprint } from '../core/hash';
import { deltaFixedX, FIXED, legAt, wrapFixedX } from '../core/position';
import { FAUNA_GAIT, FAUNA_MALE, FAUNA_RUN, FAUNA_SPECIES, FAUNA_YOUNG } from '../core/protocol';
import { dayIndex } from '../core/time';
import { emptyLayers, WORLD_SIZES, type WorldLayers } from '../core/world';
import { advanceDay, step } from './day';
import {
  FAUNA_STREAM,
  FaunaJournal,
  faunaDay,
  faunaFrame,
  faunaLimit,
  faunaMonth,
  faunaTargets,
  fingerprintFauna,
  gameRatio,
  habitatTable,
  ownPace,
  rebuildFauna,
  seedFauna,
  territoriesOf,
  territoryOf,
} from './fauna';
import { deplete, gameCap } from './forage';
import { trace } from './movement';
import { createState, type SimState } from './state';
import { applyCommand, applyCommands, type SimContent } from './step';
import {
  FLAT_TEMPERATURE,
  scatteredGroups,
  testData,
  testParams,
  testState,
  withoutFauna,
} from './testing';

const HUMANS = withoutFauna(testData);
const RULES = testData.faunaRules;
const SPECIES = testData.fauna.entries;
const S = SPECIES.length;
const index = (id: string): number => {
  const found = testData.fauna.indexOf(id);
  if (found === undefined) throw new Error(`espèce ${id} absente`);
  return found;
};
const DEER = index('deer');
const BOAR = index('boar');
const HARE = index('hare');
const species = (s: number): FaunaSpecies => {
  const entry = SPECIES.at(s);
  if (entry === undefined) throw new Error(`espèce ${String(s)} absente`);
  return entry;
};
const biome = (id: string): number => testData.biomes.indexOf(id) ?? 0;

/**
 * Un monde plat, tout du biome `id`, à 15 °C toute l'année, sans gibier semé : chaque essai pose
 * ses hardes. `land` retouche le monde : ce qu'il rend faux devient de l'océan.
 */
function blank(id = 'temperate-forest', land?: (x: number, y: number) => boolean): SimState {
  const world: WorldLayers = emptyLayers(WORLD_SIZES.small);
  const { width } = WORLD_SIZES.small;
  world.biome.fill(biome(id));
  world.elevation.fill(120);
  world.temperature.fill(FLAT_TEMPERATURE);
  if (land !== undefined) {
    world.biome.forEach((_, cell) => {
      if (!land(cell % width, Math.floor(cell / width))) world.biome[cell] = biome('ocean');
    });
  }
  return createState(testParams('gibier'), world, HUMANS);
}

/**
 * Une harde de `count` animaux de l'espèce `s`, au repos sur le point (x, y) en cases, adultes,
 * femelles, son prochain but dans `next` jours : renvoie son emplacement.
 */
function herdAt(
  state: SimState,
  s: number,
  x: number,
  y: number,
  count: number,
  next = 99,
): number {
  const fauna = state.fauna;
  const today = dayIndex(state);
  const gx = Math.round(x * FIXED);
  const gy = Math.round(y * FIXED);
  const herd = fauna.addHerd(s, Math.floor(x), Math.floor(y), gx, gy, today + next);
  const spread = species(s).spread;
  for (let member = 0; member < count; member++) {
    // Les membres en ligne, à moins de `spread` du but.
    const dx = count === 1 ? 0 : ((member / (count - 1)) * 2 - 1) * spread * 0.8;
    fauna.add(
      s,
      herd,
      state.tick - 36,
      0,
      wrapFixedX(gx + Math.round(dx * FIXED), state.size.width),
      gy,
    );
  }
  return herd;
}

/** Le jour du gibier seul, puis le jour suivant, sans pas mensuel. */
function day(state: SimState, content: SimContent = testData): void {
  faunaDay(state, content);
  state.day++;
  if (state.day === 30) {
    state.day = 0;
    state.tick++;
  }
}

/** Un humain seul, qui marche en (x, y) cases ; renvoie son emplacement. */
function walker(state: SimState, x: number, y: number): number {
  applyCommands(
    state,
    [{ type: 'spawnGroup', x: 400, y: 200, species: 'human', subspecies: 'plains', count: 1 }],
    HUMANS,
  );
  let slot = -1;
  state.people.forEach((found) => {
    slot = found;
  });
  moveWalker(state, slot, x, y);
  state.movement.release(slot);
  state.movement.addActive(slot);
  return slot;
}

/** L'humain `slot` marche désormais en (x, y) cases ; le gibier le voit dès ce jour. */
function moveWalker(state: SimState, slot: number, x: number, y: number): void {
  state.people.columns.x[slot] = Math.round(x * FIXED);
  state.people.columns.y[slot] = Math.round(y * FIXED);
  state.fauna.humans.day = -1;
}

/** Les membres d'une harde. */
const membersOf = (state: SimState, herd: number): number[] => state.fauna.members(herd, []);

/** Distance, en cases, de deux points en unités, au plus court à travers la couture. */
function distance(state: SimState, ax: number, ay: number, bx: number, by: number): number {
  const dx = deltaFixedX(ax, bx, state.size.width) / FIXED;
  const dy = (by - ay) / FIXED;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Les animaux de chaque territoire et de chaque espèce, comptés au territoire de leur harde. */
function counts(state: SimState): Float64Array {
  const fauna = state.fauna;
  const { columns, rows } = territoriesOf(state, RULES);
  const result = new Float64Array(columns * rows * S);
  for (let slot = 0; slot < fauna.end; slot++) {
    if (fauna.alive[slot] !== 1) continue;
    const herd = fauna.herd[slot] ?? 0;
    const tile = territoryOf(state, RULES, fauna.homeX[herd] ?? 0, fauna.homeY[herd] ?? 0);
    result[tile * S + (fauna.species[slot] ?? 0)]++;
  }
  return result;
}

/** Le contenu des essais, une espèce changée par `change`. */
function withSpecies(s: number, change: (entry: FaunaSpecies) => FaunaSpecies): SimContent {
  return {
    ...testData,
    fauna: catalogOf(SPECIES.map((entry, at) => (at === s ? change(entry) : entry))),
  };
}

describe('effectifs du gibier (ADR 0018, § 1 et 3)', () => {
  it('sème chaque monde sous son plafond, près des cibles de chaque territoire', () => {
    for (const seed of ['graine', 'pixelciv', 'autre']) {
      const state = testState(seed);
      const fauna = state.fauna;
      expect(fauna.count, seed).toBeGreaterThan(400);
      expect(fauna.count, seed).toBeLessThanOrEqual(faunaLimit(state));
      const target = faunaTargets(state, testData);
      const found = counts(state);
      for (let s = 0; s < S; s++) {
        let wanted = 0;
        let seeded = 0;
        let gap = 0;
        for (let key = s; key < target.length; key += S) {
          wanted += target[key] ?? 0;
          seeded += found[key] ?? 0;
          gap += Math.abs((found[key] ?? 0) - (target[key] ?? 0));
        }
        const label = `${seed}, ${species(s).id}`;
        expect(Math.abs(seeded - wanted), label).toBeLessThan(0.05 * wanted + 6);
        // L'arrondi au hasard de chaque territoire, au plus.
        expect(gap / (target.length / S), label).toBeLessThan(0.6);
      }
      // Toutes les hardes sur des cases franchissables, chacune d'une seule espèce.
      for (let slot = 0; slot < fauna.end; slot++) {
        if (fauna.alive[slot] !== 1) continue;
        const cell =
          Math.floor((fauna.y[slot] ?? 0) / FIXED) * state.size.width +
          Math.floor((fauna.x[slot] ?? 0) / FIXED);
        expect(Number.isFinite(state.cost[cell] ?? Infinity)).toBe(true);
        expect(fauna.herdSpecies[fauna.herd[slot] ?? 0]).toBe(fauna.species[slot]);
      }
    }
  });

  it('réduit la cible d’un territoire à proportion du gibier que la chasse a pris', () => {
    // Un carré de forêt de 64 × 64 cases : ses cibles restent sous le plafond du monde.
    const state = blank('temperate-forest', (x, y) => x < 64 && y < 64);
    const before = faunaTargets(state, testData).slice();
    const cell = 10 * state.size.width + 12;
    const cap = gameCap(state.world, state.size, cell, state.tick, testData);
    expect(cap).toBeGreaterThan(0);
    deplete(state.food, cell);
    state.food.stocks[cell * 3 + 1] = cap / 4;
    expect(gameRatio(state, cell, testData)).toBeCloseTo(0.25, 6);
    const after = faunaTargets(state, testData);
    const tile = territoryOf(state, RULES, 12, 10);
    const habitat = habitatTable(testData);
    for (let s = 0; s < S; s++) {
      const quality = habitat[s]?.[biome('temperate-forest')] ?? 0;
      expect(after[tile * S + s]).toBeCloseTo(
        (before[tile * S + s] ?? 0) - quality * species(s).density * 0.75,
        9,
      );
    }
    // Les autres territoires n'y perdent rien.
    expect(after[(tile + 1) * S + DEER]).toBe(before[(tile + 1) * S + DEER]);
  });

  it('partage le plafond entre tous les territoires, sans remplir le monde d’un bord à l’autre', () => {
    // Un monde tout en forêt dépasse le plafond : toutes ses cibles se réduisent à proportion.
    const state = blank('temperate-forest');
    const target = faunaTargets(state, testData);
    const total = target.reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(faunaLimit(state), 6);
    const { columns, rows } = territoriesOf(state, RULES);
    const last = (rows - 1) * columns + columns - 1;
    expect(target[last * S + DEER]).toBeCloseTo(target[DEER] ?? 0, 9);
    seedFauna(state, { ...testData, nomads: testData.nomads });
    expect(state.fauna.count).toBeLessThanOrEqual(faunaLimit(state));
    expect(state.fauna.count).toBeGreaterThan(0.9 * faunaLimit(state));
    // Le nord et le sud, l'ouest et l'est sont peuplés.
    const found = counts(state);
    for (const tile of [0, columns - 1, (rows - 1) * columns, last]) {
      expect(found[tile * S + DEER], `territoire ${String(tile)}`).toBeGreaterThan(0);
    }
  });

  it('fait mourir une part de l’excès, jamais au-dessous de la cible', () => {
    const state = blank('temperate-forest', (x, y) => x < 32 && y < 32);
    const target = faunaTargets(state, testData);
    const goal = target[DEER] ?? 0;
    expect(goal).toBeGreaterThan(9);
    for (let herd = 0; herd < 3 * Math.ceil(goal / 9); herd++) herdAt(state, DEER, 8 + herd, 8, 9);
    const before = counts(state)[DEER] ?? 0;
    expect(before).toBeGreaterThan(2.5 * goal);
    state.tick = 0; // janvier : pas de naissances
    faunaMonth(state, testData);
    const after = counts(state)[DEER] ?? 0;
    const expected = before - (before - goal) * species(DEER).cull;
    expect(after).toBeLessThan(before);
    expect(Math.abs(after - expected)).toBeLessThanOrEqual(1);
    expect(state.fauna.counts.deaths).toBe(before - after);
  });

  it('comble le manque aux seuls mois de mise bas, six mois plus tard au sud, près des mères', () => {
    // Deux carrés de forêt, au nord et au sud : chacun sous sa cible.
    const north = (x: number, y: number) => x < 32 && y < 32;
    const south = (x: number, y: number) => x < 32 && y >= 224;
    const births = (month: number, where: 'north' | 'south'): number => {
      const state = blank('temperate-forest', (x, y) => north(x, y) || south(x, y));
      const herd =
        where === 'north' ? herdAt(state, DEER, 10, 10, 4) : herdAt(state, DEER, 10, 240, 4);
      state.tick = month;
      faunaMonth(state, testData);
      const born = state.fauna.counts.births;
      // Chaque jeune naît là où se tient une mère de sa harde.
      const fauna = state.fauna;
      for (let slot = 0; slot < fauna.end; slot++) {
        if (fauna.alive[slot] !== 1 || fauna.born[slot] !== month) continue;
        const own = fauna.herd[slot] ?? 0;
        const mothers = membersOf(state, own).filter(
          (other) => other !== slot && fauna.born[other] !== month,
        );
        expect(
          mothers.some(
            (other) => fauna.x[other] === fauna.x[slot] && fauna.y[other] === fauna.y[slot],
          ),
        ).toBe(true);
        expect([herd, ...membersOf(state, own)]).toBeDefined();
      }
      return born;
    };
    const months = species(DEER).birth.months;
    for (let month = 0; month < 12; month++) {
      const northern = births(month, 'north');
      const southern = births(month, 'south');
      if (months.includes(month))
        expect(northern, `nord, mois ${String(month)}`).toBeGreaterThan(0);
      else expect(northern, `nord, mois ${String(month)}`).toBe(0);
      if (months.includes((month + 6) % 12)) {
        expect(southern, `sud, mois ${String(month)}`).toBeGreaterThan(0);
      } else expect(southern, `sud, mois ${String(month)}`).toBe(0);
    }
  });

  it('laisse les lièvres seuls, chacun dans sa harde, leurs jeunes compris', () => {
    const state = blank('steppe', (x, y) => x < 64 && y < 64);
    for (let hare = 0; hare < 6; hare++) herdAt(state, HARE, 5 + 5 * hare, 20, 1);
    for (let month = 0; month < 12; month++) {
      state.tick = month;
      faunaMonth(state, testData);
    }
    const fauna = state.fauna;
    expect(fauna.counts.births).toBeGreaterThan(0);
    for (let herd = 0; herd < fauna.herdEnd; herd++) {
      if (fauna.herdAlive[herd] === 1) expect(fauna.size[herd]).toBe(1);
    }
  });

  it('fait mourir les vieux à la fin de leur vie', () => {
    const state = blank('steppe', (x, y) => x < 64 && y < 64);
    const herd = herdAt(state, HARE, 10, 10, 1);
    const hare = membersOf(state, herd).at(0);
    if (hare === undefined) throw new Error('lièvre absent');
    state.tick = 40;
    state.fauna.born[hare] = 40 - species(HARE).lifespan * 12 + 1;
    faunaMonth(state, testData);
    expect(state.fauna.alive[hare]).toBe(1);
    state.tick = 41;
    faunaMonth(state, testData);
    expect(state.fauna.alive[hare]).toBe(0);
    expect(state.fauna.counts.aged).toBe(1);
  });

  it('recolonise un territoire vide par une harde voisine, qui s’en détache et y marche', () => {
    // Deux territoires de forêt côte à côte ; des cerfs dans le premier seulement.
    const state = blank('temperate-forest', (x, y) => x < 64 && y < 32);
    const content = withSpecies(DEER, (entry) => ({
      ...entry,
      colonize: 1,
      birth: { ...entry.birth, months: [0] },
    }));
    const from = herdAt(state, DEER, 10, 16, 9, 0);
    herdAt(state, DEER, 20, 16, 9);
    state.tick = 0;
    const before = new Map<number, [number | undefined, number | undefined]>();
    for (let slot = 0; slot < state.fauna.end; slot++) {
      before.set(slot, [state.fauna.x[slot], state.fauna.y[slot]]);
    }
    expect(membersOf(state, from)).toHaveLength(9);
    faunaMonth(state, content);
    const fauna = state.fauna;
    expect(fauna.counts.colonized).toBe(1);
    const empty = territoryOf(state, RULES, 40, 16);
    const settlers = [...Array(fauna.herdEnd).keys()].filter(
      (herd) =>
        fauna.herdAlive[herd] === 1 &&
        territoryOf(state, RULES, fauna.homeX[herd] ?? 0, fauna.homeY[herd] ?? 0) === empty,
    );
    expect(settlers).toHaveLength(1);
    const herd = settlers[0] ?? 0;
    const members = membersOf(state, herd);
    expect(members.length).toBeGreaterThanOrEqual(species(DEER).herd[0]);
    // Aucun n'apparaît : ce sont des membres d'une harde voisine, là où ils se tenaient.
    for (const slot of members) {
      expect(before.get(slot)).toEqual([fauna.x[slot], fauna.y[slot]]);
    }
    // De but en but, ils gagnent leur nouveau domaine.
    for (let days = 0; days < 120; days++) day(state, content);
    const home = (fauna.homeX[herd] ?? 0) + 0.5;
    for (const slot of membersOf(state, herd)) {
      expect(Math.abs((fauna.x[slot] ?? 0) / FIXED - home)).toBeLessThan(species(DEER).range + 1);
    }
  });

  it('refait les cibles d’un territoire repeint au pinceau', () => {
    const state = blank('temperate-forest', (x, y) => x < 64 && y < 64);
    const before = faunaTargets(state, testData).slice();
    for (let x = 0; x < 16; x++) {
      applyCommand(state, { type: 'paintBiome', x, y: 3, biome: 'desert' }, testData);
    }
    expect(state.fauna.base).toBeUndefined();
    const after = faunaTargets(state, testData);
    // Le désert n'abrite ni cerf ni sanglier : 16 cases de forêt de moins.
    expect(after[DEER]).toBeCloseTo((before[DEER] ?? 0) - 16 * species(DEER).density, 9);
    expect(after[BOAR]).toBeCloseTo((before[BOAR] ?? 0) - 16 * species(BOAR).density, 9);
  });
});

describe('mouvements du gibier (ADR 0018, § 2)', () => {
  it('ne pose jamais un animal sur l’eau, et aucune étape ne coupe l’eau ni un coin', () => {
    const state = testState('pixelciv');
    step(state, scatteredGroups(state, 40), testData);
    const journal = new FaunaJournal();
    state.fauna.journal = journal;
    const { width, height } = state.size;
    for (let days = 0; days < 60; days++) {
      advanceDay(state, [], testData);
      const legs = journal.take();
      for (let leg = 0; leg < legs.slots.length; leg++) {
        const ax = legs.start[2 * leg] ?? 0;
        const ay = legs.start[2 * leg + 1] ?? 0;
        const count = legs.count[leg] ?? 0;
        const bx = ax + count * (legs.step[2 * leg] ?? 0);
        const by = ay + count * (legs.step[2 * leg + 1] ?? 0);
        expect(trace(state.cost, width, height, ax, ay, bx, by).clear).toBe(true);
      }
      const fauna = state.fauna;
      for (let slot = 0; slot < fauna.end; slot++) {
        if (fauna.alive[slot] !== 1) continue;
        const x = fauna.x[slot] ?? 0;
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(width * FIXED);
        const cell = Math.floor((fauna.y[slot] ?? 0) / FIXED) * width + Math.floor(x / FIXED);
        expect(Number.isFinite(state.cost[cell] ?? Infinity)).toBe(true);
      }
    }
  });

  it('traverse la couture au plus court, x toujours dans le monde', () => {
    const state = blank('temperate-forest');
    const span = state.size.width * FIXED;
    const herd = herdAt(state, DEER, 0.3, 100, 9, 0);
    let east = 0;
    let west = 0;
    for (let days = 0; days < 200; days++) {
      day(state);
      const fauna = state.fauna;
      const gx = fauna.goalX[herd] ?? 0;
      for (const slot of membersOf(state, herd)) {
        const x = fauna.x[slot] ?? 0;
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(span);
        if (x > span / 2) west++;
        else east++;
        // Au repos, chacun se tient à moins de `spread` du but, au plus court.
        if ((fauna.stepDays[slot] ?? 0) === 0 && fauna.depart[slot] === -1) {
          expect(
            distance(
              state,
              x,
              fauna.y[slot] ?? 0,
              fauna.placeX[slot] ?? 0,
              fauna.placeY[slot] ?? 0,
            ),
          ).toBe(0);
        }
        expect(
          Math.abs(deltaFixedX(gx, fauna.placeX[slot] ?? 0, state.size.width)),
        ).toBeLessThanOrEqual(species(DEER).spread * FIXED + 1);
      }
    }
    // La harde vit de part et d'autre de la couture.
    expect(east).toBeGreaterThan(0);
    expect(west).toBeGreaterThan(0);
  });

  it('choisit chaque but dans l’habitat de son espèce et dans son domaine', () => {
    const state = testState('graine');
    const fauna = state.fauna;
    const habitat = habitatTable(testData);
    let checked = 0;
    let homing = 0;
    step(state, scatteredGroups(state, 60), testData);
    for (let days = 0; days < 90; days++) {
      const goals = Int32Array.from(fauna.goalX.subarray(0, fauna.herdEnd));
      const goalsY = Int32Array.from(fauna.goalY.subarray(0, fauna.herdEnd));
      advanceDay(state, [], testData);
      for (let herd = 0; herd < fauna.herdEnd; herd++) {
        if (fauna.herdAlive[herd] !== 1 || herd >= goals.length) continue;
        if (fauna.goalX[herd] === goals[herd] && fauna.goalY[herd] === goalsY[herd]) continue;
        // Une fuite pose le calme de la harde : son but n'est que franchissable.
        if ((fauna.calm[herd] ?? 0) > dayIndex(state) - 1) continue;
        const s = fauna.herdSpecies[herd] ?? 0;
        const home = (x: number, y: number) =>
          distance(
            state,
            ((fauna.homeX[herd] ?? 0) + 0.5) * FIXED,
            ((fauna.homeY[herd] ?? 0) + 0.5) * FIXED,
            x,
            y,
          );
        const away = home(goals[herd] ?? 0, goalsY[herd] ?? 0);
        const now = home(fauna.goalX[herd] ?? 0, fauna.goalY[herd] ?? 0);
        if (away > species(s).range) {
          // Hors du domaine (après une fuite) : chaque but l'en rapproche.
          expect(now).toBeLessThan(away);
          homing++;
          continue;
        }
        const cell =
          Math.floor((fauna.goalY[herd] ?? 0) / FIXED) * state.size.width +
          Math.floor((fauna.goalX[herd] ?? 0) / FIXED);
        expect(habitat[s]?.[state.world.biome[cell] ?? 0] ?? 0).toBeGreaterThan(0);
        expect(now).toBeLessThanOrEqual(species(s).range + 1e-6);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(500);
    expect(homing).toBeGreaterThan(0);
  });

  it('va en harde : places à gap au moins, dans spread du but, départs étalés sur lag jours', () => {
    const state = blank('temperate-forest');
    const herd = herdAt(state, DEER, 100, 100, 9, 0);
    const today = dayIndex(state);
    faunaDay(state, testData);
    const fauna = state.fauna;
    expect(fauna.counts.roams).toBe(1);
    const deer = species(DEER);
    const members = membersOf(state, herd);
    const departs = new Set<number>();
    let pairs = 0;
    let spaced = 0;
    for (const slot of members) {
      const px = fauna.placeX[slot] ?? 0;
      const py = fauna.placeY[slot] ?? 0;
      expect(
        distance(state, px, py, fauna.goalX[herd] ?? 0, fauna.goalY[herd] ?? 0),
      ).toBeLessThanOrEqual(deer.spread + 1e-6);
      for (const other of members) {
        if (other === slot) continue;
        const apart = distance(state, px, py, fauna.placeX[other] ?? 0, fauna.placeY[other] ?? 0);
        pairs++;
        if (apart >= deer.gap - 1e-6) spaced++;
        expect(apart).toBeGreaterThan(deer.gap / 4);
      }
      // Parti le jour même, ou à son jour, jusqu'à `lag` jours plus tard.
      const depart = (fauna.stepDays[slot] ?? 0) > 0 ? today : (fauna.depart[slot] ?? -1);
      expect(depart).toBeGreaterThanOrEqual(today);
      expect(depart).toBeLessThanOrEqual(today + deer.lag);
      departs.add(depart);
    }
    expect(departs.size).toBeGreaterThan(1);
    // Neuf cerfs tiennent sans peine à `gap` les uns des autres dans un disque de `spread` : à
    // défaut d'une place libre en quelques tirages, chacun prend la moins serrée.
    expect(spaced / pairs).toBeGreaterThan(0.9);
  });

  it('marche chacun à son allure, tirée de son identifiant, la même d’une étape à l’autre', () => {
    const paces = new Set<number>();
    for (let id = 1; id <= 64; id++) {
      const pace = ownPace(1, id, RULES.jitter);
      expect(pace).toBeGreaterThanOrEqual(1 - RULES.jitter);
      expect(pace).toBeLessThan(1 + RULES.jitter);
      expect(ownPace(1, id, RULES.jitter)).toBe(pace);
      paces.add(pace);
    }
    expect(paces.size).toBe(64);
  });

  it('coupe l’étape d’un membre en route quand sa harde change de but : il gagne sa nouvelle place', () => {
    const state = blank('temperate-forest');
    const herd = herdAt(state, DEER, 100, 100, 6, 0);
    const fauna = state.fauna;
    // Le premier but, et quelques jours de marche : des membres en route.
    day(state);
    let moving = -1;
    for (let days = 0; days < 6 && moving < 0; days++) {
      day(state);
      moving = membersOf(state, herd).find((slot) => (fauna.stepDays[slot] ?? 0) > 1) ?? -1;
    }
    expect(moving).toBeGreaterThanOrEqual(0);
    // Un autre but, aujourd'hui.
    fauna.next[herd] = dayIndex(state);
    const journal = new FaunaJournal();
    fauna.journal = journal;
    const before = fauna.counts.roams;
    day(state);
    expect(fauna.counts.roams).toBe(before + 1);
    expect(fauna.counts.cut).toBeGreaterThan(0);
    const px = fauna.placeX[moving] ?? 0;
    const py = fauna.placeY[moving] ?? 0;
    // Il est reparti le jour même : une étape d'arrêt, puis celle qui la remplace, du même jour.
    const legs = journal.take();
    const his = [...legs.slots.keys()].filter((leg) => legs.slots[leg] === moving);
    expect(his.length).toBeGreaterThanOrEqual(1);
    expect(legs.days[his.at(-1) ?? 0]).toBe(dayIndex(state) - 1);
    for (let days = 0; days < 40 && (fauna.stepDays[moving] ?? 0) > 0; days++) day(state);
    expect(fauna.stepDays[moving]).toBe(0);
    expect(distance(state, fauna.x[moving] ?? 0, fauna.y[moving] ?? 0, px, py)).toBeLessThan(0.01);
    expect([fauna.placeX[moving], fauna.placeY[moving]]).toEqual([
      fauna.x[moving],
      fauna.y[moving],
    ]);
  });

  it('fuit à l’opposé d’un marcheur, tous au galop le jour même, en route compris, puis se calme', () => {
    const state = blank('temperate-forest');
    const herd = herdAt(state, DEER, 100, 100, 6, 0);
    const fauna = state.fauna;
    // Le premier but, et un jour de marche : des membres en route.
    day(state);
    day(state);
    const inRoute = membersOf(state, herd).filter((slot) => (fauna.stepDays[slot] ?? 0) > 0);
    expect(inRoute.length).toBeGreaterThan(0);
    // Un marcheur à l'est du premier membre, à moins de la distance d'alarme.
    const first = membersOf(state, herd)[0] ?? 0;
    const human = walker(state, (fauna.x[first] ?? 0) / FIXED + 1, (fauna.y[first] ?? 0) / FIXED);
    const journal = new FaunaJournal();
    fauna.journal = journal;
    const center = () => {
      const list = membersOf(state, herd);
      return list.reduce((sum, slot) => sum + (fauna.x[slot] ?? 0), 0) / list.length;
    };
    const was = center();
    const today = dayIndex(state);
    day(state);
    expect(fauna.counts.flights).toBe(1);
    // Le but passe à l'ouest, à l'opposé de l'humain.
    expect(deltaFixedX(was, fauna.goalX[herd] ?? 0, state.size.width)).toBeLessThan(-2 * FIXED);
    // Chacun part au galop le jour même, ceux qui étaient en route compris.
    const legs = journal.take();
    for (const slot of membersOf(state, herd)) {
      const own = [...legs.slots.keys()].filter((leg) => legs.slots[leg] === slot);
      const last = own.at(-1);
      expect(last, `membre ${String(slot)}`).toBeDefined();
      expect(legs.days[last ?? 0]).toBe(today);
      expect(legs.gaits[last ?? 0]).toBe(FAUNA_GAIT.run);
      expect(legs.count[last ?? 0]).toBeGreaterThan(0);
      // Au galop : plus vite que le pas le plus rapide de l'espèce, même sur une case de plaine.
      const sx = (legs.step[2 * (last ?? 0)] ?? 0) / FIXED;
      const sy = (legs.step[2 * (last ?? 0) + 1] ?? 0) / FIXED;
      expect(Math.sqrt(sx * sx + sy * sy)).toBeGreaterThan(
        species(DEER).pace.walk * (1 + RULES.jitter),
      );
    }
    // Calme : le même marcheur, tout près, ne la fait plus fuir pendant `calm` jours.
    for (let days = 1; days < species(DEER).flee.calm; days++) {
      moveWalker(state, human, (fauna.x[first] ?? 0) / FIXED + 0.5, (fauna.y[first] ?? 0) / FIXED);
      day(state);
      expect(fauna.counts.flights, `jour ${String(days)}`).toBe(1);
    }
    moveWalker(state, human, (fauna.x[first] ?? 0) / FIXED + 0.5, (fauna.y[first] ?? 0) / FIXED);
    day(state);
    expect(fauna.counts.flights).toBe(2);
  });

  it('s’alarme d’un marcheur près d’un membre en route, même loin du but de la harde', () => {
    const state = blank('temperate-forest');
    const herd = herdAt(state, DEER, 100, 100, 3, 0);
    const fauna = state.fauna;
    // Un but lointain, et un membre en route depuis un jour, encore loin de lui.
    day(state);
    fauna.goalX[herd] = 112 * FIXED;
    fauna.goalY[herd] = 100 * FIXED;
    const member = membersOf(state, herd).at(0);
    if (member === undefined) throw new Error('membre absent');
    fauna.placeX[member] = 112 * FIXED;
    fauna.placeY[member] = 100 * FIXED;
    fauna.stepX[member] = FIXED / 2;
    fauna.stepY[member] = 0;
    fauna.stepDays[member] = 20;
    const deer = species(DEER);
    const mx = (fauna.x[member] ?? 0) / FIXED;
    const my = (fauna.y[member] ?? 0) / FIXED;
    expect(112 - mx).toBeGreaterThan(deer.flee.distance + deer.spread + 2);
    walker(state, mx, my + 0.8 * deer.flee.distance);
    day(state);
    expect(fauna.counts.flights).toBe(1);
    // L'humain marche au sud du membre : la harde fuit vers le nord.
    expect((fauna.goalY[herd] ?? 0) / FIXED).toBeLessThan(my);
  });

  it('choisit ses buts loin des camps', () => {
    const state = blank('temperate-forest');
    applyCommands(
      state,
      [{ type: 'spawnGroup', x: 100, y: 100, species: 'human', subspecies: 'plains', count: 20 }],
      HUMANS,
    );
    const held: [number, number][] = [];
    state.people.forEach((slot) => {
      held.push([state.people.columns.x[slot] ?? 0, state.people.columns.y[slot] ?? 0]);
    });
    const herd = herdAt(state, DEER, 110, 100, 6, 0);
    const fauna = state.fauna;
    const avoid = RULES.camps * species(DEER).flee.distance;
    let goals = 0;
    for (let days = 0; days < 200; days++) {
      const gx = fauna.goalX[herd];
      const gy = fauna.goalY[herd];
      fauna.next[herd] = Math.min(fauna.next[herd] ?? 0, dayIndex(state));
      day(state);
      if (fauna.goalX[herd] === gx && fauna.goalY[herd] === gy) continue;
      goals++;
      for (const [x, y] of held) {
        expect(
          distance(state, x, y, fauna.goalX[herd] ?? 0, fauna.goalY[herd] ?? 0),
        ).toBeGreaterThan(avoid);
      }
    }
    expect(goals).toBeGreaterThan(20);
  });

  it('ne reste pas figée près d’un camp posé à côté d’elle, et ne s’en approche pas', () => {
    // Le camp au centre de sa tuile de 8 × 8 cases ; huit hardes autour de lui, à 2,6 cases, dans la
    // zone qu'il interdit aux buts, et à plus de `roam` cases de sa sortie : avant la reprise de
    // 2b.6, aucun tirage n'y trouvait de but, et elles restaient là, au camp, tant qu'il durait.
    const state = blank('temperate-forest');
    applyCommands(
      state,
      [{ type: 'spawnGroup', x: 100, y: 100, species: 'human', subspecies: 'plains', count: 20 }],
      HUMANS,
    );
    // Des campeurs : ils tiennent leur place et ne marchent pas, si bien que rien n'alarme les hardes.
    const people: [number, number][] = [];
    let cx = 0;
    let cy = 0;
    state.people.forEach((slot) => {
      state.movement.removeActive(slot);
      const x = state.people.columns.x[slot] ?? 0;
      const y = state.people.columns.y[slot] ?? 0;
      people.push([x, y]);
      cx += x / FIXED / 20;
      cy += y / FIXED / 20;
    });
    const fauna = state.fauna;
    const avoid = RULES.camps * species(DEER).flee.distance;
    const nearest = (x: number, y: number) =>
      Math.min(...people.map(([hx, hy]) => distance(state, hx, hy, x, y)));
    const D = 0.7071;
    const around: [number, number][] = [
      [1, 0],
      [D, D],
      [0, 1],
      [-D, D],
      [-1, 0],
      [-D, -D],
      [0, -1],
      [D, -D],
    ];
    const herds = around.map(([ux, uy]) => herdAt(state, DEER, cx + 2.6 * ux, cy + 2.6 * uy, 3, 0));
    fauna.humans.build(state);
    const before = herds.map((herd) => {
      const gx = fauna.goalX[herd] ?? 0;
      const gy = fauna.goalY[herd] ?? 0;
      expect(fauna.humans.any(gx, gy, avoid, false)).toBe(true);
      expect(nearest(gx, gy)).toBeLessThan(avoid);
      return nearest(gx, gy);
    });
    const goals = herds.map(() => 0);
    for (let days = 0; days < 60; days++) {
      const last = herds.map((herd) => [fauna.goalX[herd], fauna.goalY[herd]]);
      for (const herd of herds) fauna.next[herd] = Math.min(fauna.next[herd] ?? 0, dayIndex(state));
      day(state);
      herds.forEach((herd, k) => {
        const gx = fauna.goalX[herd] ?? 0;
        const gy = fauna.goalY[herd] ?? 0;
        if (gx === last[k]?.[0] && gy === last[k]?.[1]) return;
        goals[k] = (goals[k] ?? 0) + 1;
        // Chaque but nouveau garde ses distances : à `avoid` au moins de l'humain le plus proche,
        // ou, si le précédent en était plus près, pas plus près que lui.
        const now = nearest(gx, gy);
        expect(now).toBeGreaterThanOrEqual(Math.min(before[k] ?? 0, avoid) - 1e-9);
        before[k] = now;
      });
    }
    expect(fauna.counts.flights).toBe(0);
    for (const count of goals) expect(count).toBeGreaterThan(5);
    for (const far of before) expect(far).toBeGreaterThanOrEqual(avoid);
  });

  it('mesure la distance à l’humain le plus proche, du jour, à travers la couture', () => {
    const state = blank('temperate-forest');
    walker(state, 511.5, 50.5);
    const b = walker(state, 300.5, 120.5);
    const humans = state.fauna.humans;
    humans.build(state);
    const at = (x: number, y: number) =>
      humans.nearest(state, Math.round(x * FIXED), Math.round(y * FIXED), 20);
    expect(at(0.5, 50.5)).toBeCloseTo(1, 9);
    expect(at(300.5, 123.5)).toBeCloseTo(3, 9);
    expect(at(200.5, 120.5)).toBe(20);
    // Les listes suivent les humains, le jour même quand l'index se refait, et le lendemain.
    moveWalker(state, b, 200.5, 118.5);
    humans.build(state);
    expect(at(200.5, 120.5)).toBeCloseTo(2, 9);
    expect(at(300.5, 123.5)).toBe(20);
    moveWalker(state, b, 300.5, 121.5);
    day(state);
    humans.build(state);
    expect(at(300.5, 123.5)).toBeCloseTo(2, 9);
    // `closer` répond comme nearest(…, bound) < bound, même quand un humain de la même tuile se
    // tient au-delà de la borne.
    const closer = (x: number, y: number, bound: number) =>
      humans.closer(state, Math.round(x * FIXED), Math.round(y * FIXED), bound);
    expect(closer(300.5, 123.5, 1.5)).toBe(false);
    expect(closer(300.5, 123.5, 2)).toBe(false);
    expect(closer(300.5, 123.5, 2.5)).toBe(true);
    expect(closer(1.5, 50.5, 2.5)).toBe(true);
    expect(closer(1.5, 50.5, 1.5)).toBe(false);
  });

  it('ne dépend ni de ses caches ni de l’ordre où ils se refont', () => {
    const a = testState('autre');
    const b = testState('autre');
    step(a, scatteredGroups(a, 30), testData);
    step(b, scatteredGroups(b, 30), testData);
    for (let days = 0; days < 45; days++) {
      advanceDay(a, [], testData);
      rebuildFauna(b.fauna);
      advanceDay(b, [], testData);
    }
    const print = (state: SimState) => {
      const print = new Fingerprint();
      fingerprintFauna(print, state.fauna);
      return print.hex();
    };
    expect(print(b)).toBe(print(a));
    expect(b.rng.states()[FAUNA_STREAM]).toEqual(a.rng.states()[FAUNA_STREAM]);
  });

  it('donne le même gibier à la même graine, et un autre à une autre', () => {
    const print = (seed: string) => {
      const state = testState(seed);
      for (let days = 0; days < 40; days++) advanceDay(state, [], testData);
      const print = new Fingerprint();
      fingerprintFauna(print, state.fauna);
      return print.hex();
    };
    expect(print('graine')).toBe(print('graine'));
    expect(print('graine')).not.toBe(print('autre'));
  });

  it('note au journal des étapes qui redonnent, aux jours entiers, les positions du worker', () => {
    const state = testState('graine');
    step(state, scatteredGroups(state, 40), testData);
    const fauna = state.fauna;
    const frame = faunaFrame(state, testData);
    const journal = new FaunaJournal();
    fauna.journal = journal;
    // L'étape qui vaut pour chaque emplacement : celle de l'image, puis la dernière reçue.
    const legs = new Map<number, [number, number, number, number, number, number]>();
    for (let leg = 0; leg < frame.legs.slots.length; leg++) {
      legs.set(frame.legs.slots[leg] ?? 0, [
        frame.legs.days[leg] ?? 0,
        frame.legs.start[2 * leg] ?? 0,
        frame.legs.start[2 * leg + 1] ?? 0,
        frame.legs.step[2 * leg] ?? 0,
        frame.legs.step[2 * leg + 1] ?? 0,
        frame.legs.count[leg] ?? 0,
      ]);
    }
    const start = new Map<number, [number, number]>();
    frame.slots.forEach((slot, at) => {
      start.set(slot, [frame.positions[2 * at] ?? 0, frame.positions[2 * at + 1] ?? 0]);
    });
    let stops = 0;
    for (let days = 0; days < 25; days++) {
      advanceDay(state, [], testData);
      const taken = journal.take();
      for (let leg = 0; leg < taken.slots.length; leg++) {
        if ((taken.count[leg] ?? 0) === 0) stops++;
        legs.set(taken.slots[leg] ?? 0, [
          taken.days[leg] ?? 0,
          taken.start[2 * leg] ?? 0,
          taken.start[2 * leg + 1] ?? 0,
          taken.step[2 * leg] ?? 0,
          taken.step[2 * leg + 1] ?? 0,
          taken.count[leg] ?? 0,
        ]);
      }
      const now = dayIndex(state);
      for (const [slot, [x0, y0]] of start) {
        if (fauna.alive[slot] !== 1) continue;
        const leg = legs.get(slot);
        const x = leg === undefined ? x0 : legAt(leg[1], leg[3], leg[5], now - leg[0]);
        const y = leg === undefined ? y0 : legAt(leg[2], leg[4], leg[5], now - leg[0]);
        expect(
          Math.abs(deltaFixedX(x, fauna.x[slot] ?? 0, state.size.width)),
          `emplacement ${String(slot)}`,
        ).toBe(0);
        expect(y).toBe(fauna.y[slot]);
      }
    }
    expect(stops).toBeGreaterThan(0);
  });
});

describe('image du gibier (protocole 7, ADR 0018, § 4)', () => {
  it('donne chaque vivant, sa sorte, sa harde, sa position et son étape à l’allure de l’état', () => {
    const state = testState('graine');
    step(state, scatteredGroups(state, 40), testData);
    for (let days = 0; days < 12; days++) advanceDay(state, [], testData);
    const fauna = state.fauna;
    const frame = faunaFrame(state, testData);
    expect(frame.slots.length).toBe(fauna.count);
    expect(frame.positions.length).toBe(2 * fauna.count);
    let young = 0;
    let males = 0;
    let running = 0;
    frame.slots.forEach((slot, at) => {
      expect(frame.ids[at]).toBe(fauna.id[slot]);
      const kind = frame.kinds[at] ?? 0;
      expect(kind & FAUNA_SPECIES).toBe(fauna.species[slot]);
      expect(frame.herds[at]).toBe(fauna.herdId[fauna.herd[slot] ?? 0]);
      expect(frame.positions[2 * at]).toBe(fauna.x[slot]);
      if ((kind & FAUNA_YOUNG) !== 0) young++;
      if ((kind & FAUNA_MALE) !== 0) {
        males++;
        expect(species(fauna.species[slot] ?? 0).look.male).toBeDefined();
        expect(fauna.sex[slot]).toBe(1);
      }
      const run = (kind & FAUNA_RUN) !== 0;
      if (run) running++;
      expect(run).toBe((fauna.stepDays[slot] ?? 0) > 0 && fauna.gait[slot] === FAUNA_GAIT.run);
    });
    expect(males).toBeGreaterThan(0);
    expect(young + running).toBeGreaterThanOrEqual(0);
    // Une étape par marcheur, repartie de l'instant de l'image.
    const walking = [...frame.slots].filter((slot) => (fauna.stepDays[slot] ?? 0) > 0);
    expect(frame.legs.slots.length).toBe(walking.length);
    expect([...frame.legs.days].every((leg) => leg === dayIndex(state))).toBe(true);
  });
});
