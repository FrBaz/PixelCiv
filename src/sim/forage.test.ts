import { describe, expect, it } from 'vitest';
import type { Biome, Catalog } from '../core/data';
import type { SpawnGroupCommand } from '../core/protocol';
import { COVER_RAMPS, coverShare, latitude } from '../core/seasons';
import { riverClass } from '../core/world';
import { DEATH_CAUSES } from './population';
import {
  cellFood,
  deplete,
  depletedCells,
  disk,
  feedGroup,
  fishSeason,
  FOOD_STRIDE,
  gameSeason,
  groupNeed,
  plantSeason,
  regrowFood,
  totalStock,
} from './forage';
import { groupMembers } from './groups';
import { spawnGroup } from './spawn';
import { createState, type SimState } from './state';
import { fingerprint, step, type SimContent } from './step';
import { testData, testParams, testState, testWorld, withHuman } from './testing';

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

/** Apparition de `count` nordiques sur une case. */
function nordics(at: { x: number; y: number }, count: number): SpawnGroupCommand {
  return { type: 'spawnGroup', x: at.x, y: at.y, species: 'human', subspecies: 'nordic', count };
}

/** Pas de janvier et de juillet de la première année : le mois le plus froid et le plus chaud au nord. */
const JANUARY = 0;
const JULY = 6;

/** Températures du mois le plus froid et du plus chaud d'une case, en °C. */
function extremes(state: SimState, cell: number) {
  const annual = (state.world.temperature[cell] ?? 0) / 10;
  const amplitude = (state.world.amplitude[cell] ?? 0) / 10;
  return { coldest: annual - amplitude, warmest: annual + amplitude };
}

/** Première case de l'hémisphère nord qui vérifie `test`, et son indice. */
function northernCell(state: SimState, test: (cell: number, biome: Biome) => boolean): number {
  const { width, height } = state.size;
  for (let cell = 0; cell < (height / 2) * width; cell++) {
    const biome = testData.biomes.entries.at(state.world.biome[cell] ?? 0);
    if (biome !== undefined && test(cell, biome)) return cell;
  }
  throw new Error('aucune case de ce genre');
}

/**
 * Départs répartis : `count` cases de l'hémisphère nord des biomes voulus, entre deux
 * latitudes (en degrés), qui vérifient `where`, à intervalles réguliers dans l'ordre des
 * cases.
 */
function startsIn(
  state: SimState,
  biomes: readonly string[],
  from: number,
  to: number,
  count: number,
  where: (cell: number) => boolean = () => true,
): { x: number; y: number }[] {
  const wanted = new Set(biomes.map((id) => testData.biomes.indexOf(id)));
  const { width, height } = state.size;
  const found: { x: number; y: number }[] = [];
  state.world.biome.forEach((biome, cell) => {
    const y = Math.floor(cell / width);
    const degrees = latitude(y, height) * 90;
    if (wanted.has(biome) && y < height / 2 && degrees >= from && degrees < to && where(cell)) {
      found.push({ x: cell % width, y });
    }
  });
  const starts: { x: number; y: number }[] = [];
  for (let index = 0; index < count; index++) {
    const start = found.at(Math.floor(((index + 0.5) * found.length) / count));
    if (start !== undefined) starts.push(start);
  }
  return starts;
}

/** La case gèle-t-elle au mois le plus froid ? */
const freezing = (state: SimState) => (cell: number) => extremes(state, cell).coldest < 0;

/** Ce que vivent des groupes, par mois de leur hémisphère (0 : janvier au nord). */
interface Lived {
  /** Réserve moyenne des groupes à la fin de chaque mois, en mois de leur besoin. */
  readonly reserve: number[];
  /** Part des membres mal nourris (nutrition sous 80 %) à la fin de chaque mois. */
  readonly hungry: number[];
  /** Nutrition moyenne des membres, sur toute la partie, de 0 à 1. */
  readonly nutrition: number;
  readonly alive: number;
  readonly famine: number;
}

/**
 * Trente nordiques posés à chaque départ, chacun dans sa partie, pendant `years` ans ; la
 * première année, le temps de s'installer, ne compte pas dans les moyennes. Avec `frost`,
 * les moyennes par mois ne comptent que les groupes qui vivent là où l'hiver gèle : les
 * autres, partis vers une côte douce, n'ont guère d'hiver.
 */
function live(
  make: () => SimState,
  starts: readonly { x: number; y: number }[],
  years: number,
  frost = false,
): Lived {
  const reserve = new Array<number>(12).fill(0);
  const hungry = new Array<number>(12).fill(0);
  const counts = new Array<number>(12).fill(0);
  let nutrition = 0;
  let observed = 0;
  let alive = 0;
  let deaths = 0;
  for (const start of starts) {
    const state = make();
    step(state, [nordics(start, 30)], testData);
    for (let month = 1; month < years * 12; month++) {
      const members = step(state, [], testData);
      if (month < 12) continue;
      const tick = state.tick - 1;
      const cold = freezing(state);
      for (const group of state.society.groups.values()) {
        const list = members.get(group.id) ?? [];
        if (list.length === 0) continue;
        if (frost && !cold(group.y * state.size.width + group.x)) continue;
        const local = (tick + (group.y >= state.size.height / 2 ? 6 : 0)) % 12;
        reserve[local] =
          (reserve[local] ?? 0) + group.food / groupNeed(state.people, list, tick, testData);
        let low = 0;
        for (const slot of list) {
          const value = state.people.get('nutrition', slot) / 255;
          nutrition += value;
          observed++;
          if (value < 0.8) low++;
        }
        hungry[local] = (hungry[local] ?? 0) + low / list.length;
        counts[local] = (counts[local] ?? 0) + 1;
      }
    }
    alive += state.people.count;
    deaths += famine(state);
  }
  const mean = (sums: number[]) => sums.map((sum, month) => sum / Math.max(1, counts[month] ?? 0));
  return {
    reserve: mean(reserve),
    hungry: mean(hungry),
    nutrition: nutrition / Math.max(1, observed),
    alive,
    famine: deaths,
  };
}

/** Le monde Petit des tests, toutes ses terres changées en un seul biome : même climat. */
function uniform(biome: string): () => SimState {
  const index = testData.biomes.indexOf(biome) ?? 0;
  return () => {
    const world = testWorld();
    world.biome.forEach((current, cell) => {
      if (testData.biomes.entries.at(current)?.family !== 'water') world.biome[cell] = index;
    });
    return createState(testParams(), world, testData);
  };
}

const MARCH = 2;
const SEPTEMBER = 8;

describe('survie (tâche 2.4)', () => {
  it("ne fait pousser les plantes qu'à la belle saison, moins à la saison sèche", () => {
    expect(plantSeason(-5, 1)).toBe(0);
    expect(plantSeason(20, 1)).toBe(1);
    expect(plantSeason(20, 0.5)).toBeLessThan(plantSeason(20, 1));
  });

  it('raréfie le gibier dans le froid, selon data/nomads.json', () => {
    const { cold } = testData.nomads.stocks.game;
    expect(gameSeason(cold.from, cold)).toBe(1);
    expect(gameSeason(cold.from + 10, cold)).toBe(1);
    expect(gameSeason(cold.to, cold)).toBeCloseTo(cold.share, 12);
    expect(gameSeason(cold.to - 20, cold)).toBe(cold.share);
    // D'un trait entre les deux.
    expect(gameSeason((cold.from + cold.to) / 2, cold)).toBeCloseTo((1 + cold.share) / 2, 12);
    // Le plafond d'une case de toundra suit : plus bas l'hiver que l'été.
    const state = testState();
    const tundra = northernCell(
      state,
      (cell, biome) => biome.id === 'tundra' && extremes(state, cell).coldest < cold.to - 1,
    );
    const winter = cellFood(state.world, state.size, tundra, JANUARY, testData)[4];
    const summer = cellFood(state.world, state.size, tundra, JULY, testData)[4];
    expect(winter).toBeLessThan(summer * 0.5);
    expect(winter).toBeCloseTo(
      (testData.biomes.entries.at(state.world.biome[tundra] ?? 0)?.forage.game ?? 0) *
        cold.share *
        testData.nomads.stocks.game.capacity,
      6,
    );
  });

  it('fait geler la pêche comme la carte : rivières des terres, lacs, banquise (F-3)', () => {
    const state = testState();
    const { covered, capacity } = testData.nomads.stocks.fish;
    // Sous une couverture pleine, la pêche garde la part `covered` de ce qu'elle rend.
    expect(fishSeason(0, covered)).toBe(1);
    expect(fishSeason(1, covered)).toBeCloseTo(covered, 12);
    const fishCap = (cell: number, tick: number) =>
      cellFood(state.world, state.size, cell, tick, testData)[5];
    // Les seuils sont ceux du shader de la carte, qui lit aussi COVER_RAMPS.
    const iceBelow = COVER_RAMPS.ice.onset - COVER_RAMPS.ice.span;
    const seaIceBelow = COVER_RAMPS['sea-ice'].onset - COVER_RAMPS['sea-ice'].span;
    // Une rivière dans une case de terre, l'eau douce qui gèle la première.
    const stream = northernCell(state, (cell, biome) => {
      const { coldest, warmest } = extremes(state, cell);
      return (
        biome.family !== 'water' &&
        biome.forage.fish === 0 &&
        riverClass(state.world.drainage[cell] ?? 0) >= 2 &&
        coldest < iceBelow - 2 &&
        warmest > COVER_RAMPS.ice.onset + 2
      );
    });
    const streamFish = testData.nomads.river[riverClass(state.world.drainage[stream] ?? 0)] ?? 0;
    expect(fishCap(stream, JULY)).toBeCloseTo(streamFish * capacity, 6);
    expect(fishCap(stream, JANUARY)).toBeCloseTo(
      fishCap(stream, JULY) * fishSeason(COVER_RAMPS.ice.full, covered),
      6,
    );
    // Un lac ou le lit d'un fleuve, sous la glace d'eau douce de sa couverture
    // (`seasons.cover` de data/biomes.json).
    const lake = northernCell(state, (cell, biome) => {
      const { coldest, warmest } = extremes(state, cell);
      return biome.seasons.cover === 'ice' && coldest < iceBelow - 2 && warmest > 2;
    });
    expect(fishCap(lake, JULY)).toBeGreaterThan(0);
    expect(fishCap(lake, JANUARY)).toBeCloseTo(
      fishCap(lake, JULY) * fishSeason(COVER_RAMPS.ice.full, covered),
      6,
    );
    // La mer côtière sous la banquise, dès le seuil de la banquise, et pas avant.
    const sea = northernCell(state, (cell, biome) => {
      const { coldest, warmest } = extremes(state, cell);
      return biome.seasons.cover === 'sea-ice' && coldest < seaIceBelow - 2 && warmest > 0;
    });
    expect(fishCap(sea, JANUARY)).toBeCloseTo(
      fishCap(sea, JULY) * fishSeason(COVER_RAMPS['sea-ice'].full, covered),
      6,
    );
    const mild = northernCell(state, (cell, biome) => {
      const { coldest } = extremes(state, cell);
      return biome.seasons.cover === 'sea-ice' && coldest > COVER_RAMPS['sea-ice'].onset + 1;
    });
    expect(coverShare(COVER_RAMPS['sea-ice'], extremes(state, mild).coldest)).toBe(0);
    expect(fishCap(mild, JANUARY)).toBeCloseTo(fishCap(mild, JULY), 6);
  });

  it('ne compte la pêche du lit d’un fleuve qu’une fois (F-6)', () => {
    const state = testState();
    const { capacity } = testData.nomads.stocks.fish;
    // Au plus chaud de l'été, sans glace : la pêche du biome, sans part de rivière.
    for (const id of ['river', 'lake', 'coastal-ocean']) {
      const water = northernCell(
        state,
        (cell, biome) => biome.id === id && extremes(state, cell).warmest > 5,
      );
      const fish = testData.biomes.entries.at(state.world.biome[water] ?? 0)?.forage.fish ?? 0;
      expect(fish).toBeGreaterThan(0);
      expect(cellFood(state.world, state.size, water, JULY, testData)[5]).toBeCloseTo(
        fish * capacity,
        6,
      );
    }
  });

  it('tient une case intacte au plafond, la suit une fois entamée, puis la libère', () => {
    const state = testState();
    const { cell } = cellOf(state, 'temperate-forest');
    const full = totalStock(state.food, state.world, state.size, cell, JULY, testData);
    expect(full).toBeGreaterThan(0);
    state.food.stocks.fill(0, cell * FOOD_STRIDE, cell * FOOD_STRIDE + FOOD_STRIDE);
    deplete(state.food, cell);
    expect(state.food.count).toBe(1);
    expect(totalStock(state.food, state.world, state.size, cell, JULY, testData)).toBe(0);
    for (let month = 0; month < 48 && state.food.count > 0; month++) {
      regrowFood(state.food, state.world, state.size, JULY, testData);
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

  it("entame sa réserve l'hiver et la refait l'été, tenu sur place en forêt tempérée", () => {
    // Douze nordiques qui ne bougent pas : la cueillette et la chasse du mois, la repousse,
    // et rien d'autre (ni marche, ni naissances, ni morts).
    const probe = testState();
    for (const start of startsIn(probe, ['temperate-forest'], 40, 54, 3)) {
      const state = testState();
      spawnGroup(state, nordics(start, 12), testData);
      const group = [...state.society.groups.values()].at(0);
      if (group === undefined) throw new Error('aucun groupe');
      const members = groupMembers(state.people).get(group.id) ?? [];
      const reserve: number[] = [];
      for (let month = 0; month < 3 * 12; month++) {
        regrowFood(state.food, state.world, state.size, state.tick, testData);
        feedGroup(
          group,
          members,
          state.people,
          state.food,
          state.world,
          state.size,
          state.tick,
          testData,
        );
        const need = groupNeed(state.people, members, state.tick, testData);
        expect(group.food).toBeLessThanOrEqual(testData.nomads.reserve.months * need);
        reserve.push(group.food / need);
        state.tick++;
      }
      // La troisième année : la réserve est au plus bas à la fin de l'hiver.
      const year = reserve.slice(24);
      expect(year[MARCH] ?? 0).toBeLessThan((year[SEPTEMBER] ?? 0) - 0.3);
    }
  });

  it("fait sentir l'hiver aux groupes des latitudes moyennes et hautes (SAI-03)", () => {
    // Des départs répartis en forêt tempérée, en taïga et en toundra, au nord de 40°, là où
    // l'hiver gèle : les groupes marchent, se scindent et vivent leur vie, quinze ans durant,
    // et tous comptent, même ceux qui gagnent une côte plus douce.
    const probe = testState();
    const cold = freezing(probe);
    const forests = startsIn(probe, ['temperate-forest'], 40, 54, 6, cold);
    const north = live(
      () => testState(),
      [
        ...forests,
        ...startsIn(probe, ['taiga', 'cold-forest'], 50, 65, 4, cold),
        ...startsIn(probe, ['tundra'], 54, 72, 4, cold),
      ],
      15,
    );
    // La réserve baisse jusqu'à la fin de l'hiver, et se refait l'été.
    expect(north.reserve[MARCH] ?? 0).toBeLessThan((north.reserve[SEPTEMBER] ?? 0) - 0.15);
    // Les mal nourris sont plus nombreux à la fin de l'hiver qu'à la fin de l'été.
    expect(north.hungry[MARCH] ?? 0).toBeGreaterThan((north.hungry[SEPTEMBER] ?? 0) * 2);
    // Même en forêt tempérée, la réserve sert là où l'hiver gèle.
    const forest = live(() => testState(), forests, 15, true);
    expect(forest.reserve[MARCH] ?? 0).toBeLessThan((forest.reserve[SEPTEMBER] ?? 0) - 0.1);
  });

  it('fait mieux vivre un groupe en forêt tempérée qu’en toundra, sur plusieurs départs', () => {
    // Huit départs de chaque biome, chacun sous son climat, quinze ans : la toundra affame,
    // et la forêt compte nettement plus de monde à la fin.
    const probe = testState();
    const forest = live(() => testState(), startsIn(probe, ['temperate-forest'], 36, 54, 8), 15);
    const tundra = live(() => testState(), startsIn(probe, ['tundra'], 54, 72, 8), 15);
    expect(tundra.famine).toBeGreaterThan(forest.famine + 20);
    expect(forest.alive).toBeGreaterThan(tundra.alive * 1.2);
    expect(forest.nutrition).toBeGreaterThan(tundra.nutrition);
    // Mondes témoins : toutes les terres d'un seul biome, le même climat et les mêmes
    // départs, de la forêt tempérée au grand nord. Le biome seul fait la différence, même
    // pour des groupes qui le quittent : il n'y en a pas d'autre.
    const starts = startsIn(probe, ['temperate-forest', 'taiga', 'tundra'], 40, 66, 8);
    const wooded = live(uniform('temperate-forest'), starts, 15);
    const barren = live(uniform('tundra'), starts, 15);
    expect(barren.famine).toBeGreaterThan(wooded.famine + 20);
    expect(wooded.alive).toBeGreaterThan(barren.alive * 1.1);
    expect(wooded.nutrition).toBeGreaterThan(barren.nutrition);
  });

  it('pêche dans les rivières, la mer côtière et les lacs (RES-04)', () => {
    const state = testState();
    for (const biome of ['coastal-ocean', 'lake']) {
      const { cell } = cellOf(state, biome);
      expect(cellFood(state.world, state.size, cell, JULY, testData)[5]).toBeGreaterThan(0);
    }
    // Une case de terre traversée par une rivière a son poisson.
    const river = state.world.drainage.findIndex((code, cell) => {
      const family = testData.biomes.entries.at(state.world.biome[cell] ?? 0)?.family;
      return riverClass(code) >= 2 && family !== 'water';
    });
    expect(river).toBeGreaterThanOrEqual(0);
    expect(cellFood(state.world, state.size, river, JULY, testData)[5]).toBeGreaterThan(0);
  });
});

describe('cueillette d’un groupe (tâche 2.4)', () => {
  /** Un groupe de trente nordiques posé sur une case, sans faire passer de mois. */
  function posed(content: SimContent, at: { x: number; y: number }, make = () => testState()) {
    const state = make();
    spawnGroup(state, nordics(at, 30), content);
    const group = [...state.society.groups.values()].at(0);
    if (group === undefined) throw new Error('aucun groupe');
    const members = groupMembers(state.people).get(group.id) ?? [];
    const feed = (tick: number) =>
      feedGroup(group, members, state.people, state.food, state.world, state.size, tick, content);
    return { state, group, members, feed };
  }

  it('nourrit sur sa réserve, qui perd sa part chaque mois, faute de rien trouver', () => {
    const probe = testState();
    const at = startsIn(probe, ['temperate-forest'], 40, 54, 1)[0] ?? { x: 0, y: 0 };
    const { state, group, members, feed } = posed(testData, at);
    // Plus rien autour du groupe.
    for (const cell of disk(state.size, group.x, group.y, testData.nomads.forage.radius)) {
      state.food.stocks.fill(0, cell * FOOD_STRIDE, cell * FOOD_STRIDE + FOOD_STRIDE);
      deplete(state.food, cell);
    }
    const need = groupNeed(state.people, members, state.tick, testData);
    const { spoilage } = testData.nomads.reserve;
    group.food = 1.5 * need;
    expect(feed(state.tick)).toBe(1);
    expect(group.food).toBeCloseTo(0.5 * need * (1 - spoilage), 9);
    // Le mois suivant, la réserve ne couvre plus qu'une part du besoin.
    const left = group.food;
    expect(feed(state.tick)).toBeCloseTo(left / need, 9);
    expect(group.food).toBe(0);
    // Une réserve trop pleine revient à son plafond.
    group.food = 100 * need;
    feed(state.tick);
    expect(group.food).toBeLessThanOrEqual(testData.nomads.reserve.months * need);
  });

  it('cueille mieux dans un biome de prédilection de sa sous-espèce (ESP-02)', () => {
    // En plein hiver, sur un monde de toundra, loin de toute eau : le groupe prend tout ce
    // qu'il trouve, sans réserve, et la toundra est un biome de prédilection des nordiques.
    const tundra = uniform('tundra');
    const probe = tundra();
    const { radius } = testData.nomads.forage;
    const at = startsIn(probe, ['tundra'], 60, 72, 200).find((start) =>
      disk(probe.size, start.x, start.y, radius).every(
        (cell) => testData.biomes.entries.at(probe.world.biome[cell] ?? 0)?.id === 'tundra',
      ),
    );
    if (at === undefined) throw new Error('aucun départ loin de l’eau');
    const elsewhere = withHuman((human) => ({
      ...human,
      subspecies: human.subspecies.map((entry) =>
        entry.id === 'nordic' ? { ...entry, biomes: [] } : entry,
      ),
    }));
    const fed = (content: SimContent) => {
      const { group, feed } = posed(content, at, tundra);
      group.food = 0;
      return feed(JANUARY);
    };
    const home = fed(testData);
    expect(home).toBeLessThan(0.5);
    expect(home).toBeGreaterThan(0);
    expect(home / fed(elsewhere)).toBeCloseTo(1.25, 6);
  });

  it('ne garde pas en cache les biomes de prédilection d’un autre catalogue (P-4)', () => {
    // Deux copies des humains, de nouveaux objets : l'une a d'abord cueilli sous un autre
    // catalogue de biomes, dans l'ordre inverse.
    const polluted = withHuman((human) => human);
    const fresh = withHuman((human) => human);
    const reversed = [...testData.biomes.entries].reverse();
    const biomes: Catalog<Biome> = {
      entries: reversed,
      indexOf: (id) => {
        const index = reversed.findIndex((biome) => biome.id === id);
        return index < 0 ? undefined : index;
      },
    };
    const at = cellOf(testState(), 'temperate-forest');
    posed({ ...polluted, biomes }, at).feed(JULY);
    const play = (content: SimContent) => {
      const state = testState();
      step(state, [nordics(at, 30)], content);
      for (let month = 0; month < 24; month++) step(state, [], content);
      return fingerprint(state);
    };
    expect(play(polluted)).toBe(play(fresh));
  });
});
