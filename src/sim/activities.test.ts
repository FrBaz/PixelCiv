import { describe, expect, it } from 'vitest';
import { ACT_RANK } from '../core/protocol';
import { deltaFixedX, FIXED } from '../core/position';
import { dayIndex, DAYS_PER_MONTH } from '../core/time';
import { encodeDrainage, riverClass } from '../core/world';
import { GENERATOR_VERSION } from '../worldgen/generate';
import { activityWeights, shoresOf, standsClear } from './activities';
import { SHORE_STRIDE } from './activityCache';
import { advanceDay, step } from './day';
import { describeMovement, rebuildMovement } from './movement';
import { CARRIED, FEMALE, INTENTION, MALE, NO_ACTIVITY, REST, WALK } from './population';
import { restoreState, saveState } from './save';
import type { SimState } from './state';
import { applyCommands, fingerprint, type SimContent } from './step';
import { flatState, scatteredGroups, testData, testState, withoutFauna } from './testing';

const activities = testData.activities.activities;
const rankOf = (id: string) => activities.findIndex((activity) => activity.id === id);
const REST_RANK = rankOf('rest');
const GATHER = rankOf('gather');
const HUNT = rankOf('hunt');
const FISH = rankOf('fish');
const WATER = rankOf('water');
const PLAY = rankOf('play');
const FOLLOW = rankOf('follow');

/** Taille du monde des mondes plats (flatState). */
const FLAT = { width: 512, height: 256 };

/** Fait apparaître `count` humains des plaines sur la case (x, y). */
function spawnAt(state: SimState, x: number, y: number, count: number, content: SimContent) {
  applyCommands(
    state,
    [{ type: 'spawnGroup', x, y, species: 'human', subspecies: 'plains', count }],
    content,
  );
}

/** Cent groupes de trente sur le monde « graine », comme la référence de state.test.ts. */
function populated(content: SimContent = testData, seed = 'graine'): SimState {
  const state = testState(seed, content);
  step(state, scatteredGroups(state, 100), content);
  return state;
}

/** Poids des activités de `slot`, par rang. */
function weightsOf(state: SimState, content: SimContent, slot: number): number[] {
  const out = new Float64Array(activities.length);
  activityWeights(state, content, slot, out);
  return [...out];
}

/** Un adulte non porté de la partie, entre 20 et 40 ans. */
function adultOf(state: SimState): number {
  let found = -1;
  state.people.forEach((slot) => {
    const years = (state.tick - state.people.get('birth', slot)) / 12;
    const intention = state.people.get('move', slot) & INTENTION;
    if (found < 0 && years >= 20 && years <= 40 && intention !== CARRIED) found = slot;
  });
  if (found < 0) throw new Error('pas d’adulte');
  return found;
}

describe('activités : qui fait quoi (ADR 0021, § 1)', () => {
  it('donne à chaque vivant qui n’est pas porté l’une des activités, chaque jour, et aucune au porté', () => {
    const state = populated();
    let carried = 0;
    let free = 0;
    const seen = new Set<number>();
    for (let day = 0; day < 3 * DAYS_PER_MONTH; day++) {
      advanceDay(state, [], testData);
      const { people } = state;
      people.forEach((slot) => {
        const byte = people.get('activity', slot);
        const intention = people.get('move', slot) & INTENTION;
        if (intention === CARRIED) {
          carried++;
          expect(byte, `porté ${String(slot)}`).toBe(NO_ACTIVITY);
          expect(people.get('until', slot)).toBe(0);
          return;
        }
        free++;
        const rank = byte & ACT_RANK;
        expect(rank, `jour ${String(day)}, emplacement ${String(slot)}`).toBeLessThan(
          activities.length,
        );
        seen.add(rank);
      });
    }
    expect(carried).toBeGreaterThan(1000);
    expect(free).toBeGreaterThan(100_000);
    // Toutes les activités se voient en trois mois de cent groupes.
    expect([...seen].sort((a, b) => a - b)).toEqual(activities.map((_, rank) => rank));
  });

  it('ne fait chasser ni un enfant ni une mère qui porte ; la faim mène au repos ; l’hiver sans plantes, personne ne cueille', () => {
    const content = withoutFauna(testData);
    const state = flatState('qui');
    spawnAt(state, 100, 100, 30, content);
    const slot = adultOf(state);
    const { columns } = state.people;
    const base = weightsOf(state, content, slot);
    expect(base[HUNT]).toBeGreaterThan(0);
    expect(base[GATHER]).toBeGreaterThan(0);
    expect(base[FOLLOW]).toBe(0);
    // Un enfant de dix ans : ni chasse, mais le jeu ; un adulte ne joue pas.
    const birth = columns.birth[slot] ?? 0;
    columns.birth[slot] = state.tick - 10 * 12;
    const child = weightsOf(state, content, slot);
    expect(child[HUNT]).toBe(0);
    expect(child[PLAY]).toBeGreaterThan(0);
    expect(base[PLAY]).toBe(0);
    columns.birth[slot] = birth;
    // Une mère qui porte : pas de chasse, la pêche réduite de moitié.
    state.movement.childHead[slot] = slot;
    const mother = weightsOf(state, content, slot);
    expect(mother[HUNT]).toBe(0);
    state.movement.childHead[slot] = -1;
    // La faim : le repos doublé, la chasse à 0,3.
    columns.nutrition[slot] = 40;
    const hungry = weightsOf(state, content, slot);
    expect(hungry[REST_RANK]).toBeCloseTo(2 * (base[REST_RANK] ?? 0), 9);
    expect(hungry[HUNT]).toBeCloseTo(0.3 * (base[HUNT] ?? 0), 9);
    columns.nutrition[slot] = 255;
    // Un monde gelé, à −20 °C : aucune plante ne pousse, personne ne cueille.
    const frozen = flatState('gel', (world) => world.temperature.fill(-200));
    spawnAt(frozen, 100, 100, 30, content);
    expect(weightsOf(frozen, content, adultOf(frozen))[GATHER]).toBe(0);
  });

  it('garde le goût d’une culture d’un appel et d’une relecture à l’autre, et ne partage rien entre les sexes par défaut', () => {
    const tasty = {
      ...testData,
      activities: {
        ...testData.activities,
        activities: activities.map((activity) =>
          activity.id === 'gather'
            ? { ...activity, taste: [0.75, 1.33] as [number, number] }
            : activity,
        ),
      },
    };
    const state = flatState('goût');
    for (let index = 0; index < 6; index++) spawnAt(state, 40 + 60 * index, 100, 20, tasty);
    // Le goût de la cueillette, rapporté au poids sans goût, pour un adulte de chaque culture.
    const factors = new Map<number, number>();
    state.people.forEach((slot) => {
      const culture = state.people.get('culture', slot);
      if (factors.has(culture) || (state.people.get('move', slot) & INTENTION) === CARRIED) return;
      const years = (state.tick - state.people.get('birth', slot)) / 12;
      if (years < 20 || years > 50) return;
      const plain = weightsOf(state, testData, slot)[GATHER] ?? 0;
      factors.set(culture, (weightsOf(state, tasty, slot)[GATHER] ?? 0) / plain);
    });
    expect(factors.size).toBeGreaterThan(3);
    for (const factor of factors.values()) {
      expect(factor).toBeGreaterThanOrEqual(0.75);
      expect(factor).toBeLessThanOrEqual(1.33);
    }
    expect(new Set([...factors.values()].map((f) => f.toFixed(6))).size).toBeGreaterThan(1);
    // Relue, la partie garde les mêmes goûts.
    const restored = restoreState(saveState(state, GENERATOR_VERSION, tasty), tasty);
    restored.people.forEach((slot) => {
      const culture = restored.people.get('culture', slot);
      const factor = factors.get(culture);
      if (factor === undefined || (restored.people.get('move', slot) & INTENTION) === CARRIED) {
        return;
      }
      const years = (restored.tick - restored.people.get('birth', slot)) / 12;
      if (years < 20 || years > 50) return;
      const plain = weightsOf(restored, testData, slot)[GATHER] ?? 0;
      expect((weightsOf(restored, tasty, slot)[GATHER] ?? 0) / plain).toBeCloseTo(factor, 12);
    });
    // Aucun partage des tâches entre les sexes avec les données : les mêmes poids.
    const slot = adultOf(state);
    const sex = state.people.get('sex', slot);
    state.people.set('sex', slot, FEMALE);
    const woman = weightsOf(state, testData, slot);
    state.people.set('sex', slot, MALE);
    expect(weightsOf(state, testData, slot)).toEqual(woman);
    state.people.set('sex', slot, sex);
  });
});

describe('activités : lieux (ADR 0021, § 3)', () => {
  it('cueille sur une case à plantes, pêche et puise depuis une rive, jamais dans l’eau ni sur une rivière', () => {
    const state = populated();
    const { width } = state.size;
    const { biome, drainage } = state.world;
    const plantsOf = (cell: number) =>
      testData.biomes.entries.at(biome[cell] ?? 0)?.forage.plants ?? 0;
    const familyOf = (cell: number) => testData.biomes.entries.at(biome[cell] ?? 0)?.family;
    const idOf = (cell: number) => testData.biomes.entries.at(biome[cell] ?? 0)?.id;
    const counts = { gather: 0, fish: 0, water: 0 };
    for (let day = 0; day < 3 * DAYS_PER_MONTH; day++) {
      advanceDay(state, [], testData);
      const { people } = state;
      const { x, y, homeX, homeY, move } = people.columns;
      people.forEach((slot) => {
        if (((move[slot] ?? 0) & INTENTION) !== REST) return;
        if (x[slot] === homeX[slot] && y[slot] === homeY[slot]) return;
        const rank = people.get('activity', slot) & ACT_RANK;
        const column = Math.floor((x[slot] ?? 0) / FIXED);
        const row = Math.floor((y[slot] ?? 0) / FIXED);
        const cell = row * width + column;
        // Hors de sa place : sur une case franchissable, sans rivière.
        expect(state.cost[cell], `emplacement ${String(slot)}`).toBeLessThan(Infinity);
        expect(riverClass(drainage[cell] ?? 0), `emplacement ${String(slot)}`).toBe(0);
        if (rank === GATHER) {
          counts.gather++;
          expect(plantsOf(cell)).toBeGreaterThan(0);
        }
        if (rank === FISH || rank === WATER) {
          // Au bord d'une de ses eaux : une case voisine en est une.
          const waters = new Set(activities[rank]?.water?.biomes ?? []);
          const neighbors = [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ].map(([dx = 0, dy = 0]) => (row + dy) * width + ((column + dx + width) % width));
          const shore = neighbors.some(
            (other) =>
              waters.has(idOf(other) ?? '') ||
              (familyOf(other) !== 'water' && riverClass(drainage[other] ?? 0) > 0),
          );
          // Pour la corvée d'eau, une eau douce : ni la mer, ni la mer côtière n'en sont.
          expect(shore, `rive de ${String(slot)}`).toBe(true);
          counts[rank === FISH ? 'fish' : 'water']++;
        }
      });
    }
    expect(counts.gather).toBeGreaterThan(1000);
    expect(counts.fish).toBeGreaterThan(200);
    expect(counts.water).toBeGreaterThan(20);
  });

  it('trouve les rives d’une rivière de l’autre côté de la couture, sur les cases voisines sans rivière', () => {
    const state = flatState('couture', (world) => {
      const { width } = FLAT;
      // Une rivière qui coule vers le nord dans la dernière colonne du monde.
      for (let row = 80; row < 120; row++) {
        world.drainage[row * width + width - 1] = encodeDrainage(2, 2);
      }
    });
    const { width } = state.size;
    const shores = shoresOf(state, testData, 1, 100, WATER);
    expect(shores.length).toBeGreaterThan(0);
    for (let at = 0; at < shores.length; at += SHORE_STRIDE) {
      const sx = shores[at] ?? 0;
      const column = Math.floor(sx / FIXED);
      // Sur la case voisine de la rivière, de part et d'autre de la couture, rentrée de 0,3 case.
      expect([0, width - 2]).toContain(column);
      const inset = column === 0 ? sx / FIXED : width - 1 - sx / FIXED;
      expect(inset).toBeCloseTo(testData.activities.rules.shore.inset, 4);
      expect(shores[at + 3]).toBe(Math.floor((shores[at + 1] ?? 0) / FIXED) * width + width - 1);
    }
    // Les plus proches du camp d'abord : à l'est de la couture, sur la colonne 0.
    expect(Math.floor(shores[0] / FIXED)).toBe(0);
  });

  it('ne se tient ni sur une case dont une rivière coupe un coin, ni à moins d’un quart de case d’une eau', () => {
    const lake = testData.biomes.indexOf('lake') ?? 0;
    const state = flatState('coins', (world) => {
      const { width } = FLAT;
      // Une rivière qui passe en diagonale de (100, 99) à (101, 100), au coin de (100, 100).
      world.drainage[99 * width + 100] = encodeDrainage(1, 2);
      world.drainage[100 * width + 101] = encodeDrainage(0, 2);
      // Un lac (200, 99) qui se vide en diagonale dans une rivière (201, 100).
      world.biome[99 * width + 200] = lake;
      world.drainage[99 * width + 200] = encodeDrainage(1, 0);
      world.drainage[100 * width + 201] = encodeDrainage(0, 1);
      // Un lac seul en (300, 99), en diagonale de (301, 100).
      world.biome[99 * width + 300] = lake;
    });
    const at = (x: number, y: number) => standsClear(state, testData, x * FIXED, y * FIXED);
    // Les deux cases au coin de la diagonale, et celle au coin de la sortie du lac : coupées.
    expect(at(100.5, 100.5)).toBe(false);
    expect(at(101.5, 99.5)).toBe(false);
    expect(at(200.5, 100.5)).toBe(false);
    // Leurs voisines, que la rivière ne coupe pas, se tiennent en leur milieu.
    expect(at(99.5, 100.5)).toBe(true);
    expect(at(200.5, 101.5)).toBe(true);
    // Près du lac seul : pas dans le quart de case de son coin, mais le long des voisines de terre.
    expect(at(301.1, 100.1)).toBe(false);
    expect(at(301.5, 100.1)).toBe(true);
    expect(at(301.1, 100.5)).toBe(true);
    expect(at(300.5, 100.1)).toBe(false);
    expect(at(300.5, 100.3)).toBe(true);
  });

  it('pêche quand une rivière poissonneuse coule à trois cases du camp', () => {
    const content = withoutFauna(testData);
    const river = testData.biomes.indexOf('river') ?? 0;
    const state = flatState('pêche', (world) => {
      const { width } = FLAT;
      for (let row = 60; row < 140; row++) world.biome[row * width + 103] = river;
    });
    spawnAt(state, 100, 100, 30, content);
    // Le poisson de la rivière compte dans les saisons du camp : la pêche a un poids.
    expect(weightsOf(state, content, adultOf(state))[FISH]).toBeGreaterThan(0);
    for (let month = 0; month < 3; month++) step(state, [], content);
    expect(state.movement.acts.counts.chosen[FISH]).toBeGreaterThan(0);
    // Ni rivière ni lac à portée : personne ne pêche.
    const dry = flatState('sec');
    spawnAt(dry, 100, 100, 30, content);
    for (let month = 0; month < 3; month++) step(dry, [], content);
    expect(dry.movement.acts.counts.chosen[FISH]).toBe(0);
    expect(dry.movement.acts.counts.chosen[WATER]).toBe(0);
  });
});

describe('activités : agenda, relecture, lots de jours (ADR 0021, § 2 et § 8)', () => {
  it('tient l’agenda et les lieux comme l’état les redonne, à la fin de chaque jour et de chaque mois', () => {
    const state = populated(withoutFauna(testData), 'agenda');
    const content = withoutFauna(testData);
    for (let day = 0; day < 2 * DAYS_PER_MONTH + 5; day++) {
      advanceDay(state, [], content);
      const kept = describeMovement(state);
      expect(kept.problems, `jour ${String(day)}`).toEqual([]);
      rebuildMovement(state);
      expect(describeMovement(state).text, `jour ${String(day)}`).toBe(kept.text);
    }
  });

  it('donne la même suite à une partie relue qu’à la partie continue, à plusieurs jours de plusieurs mois, sur cent groupes', () => {
    // Critique de la conception, requis 1 : la relecture refait l'agenda d'après l'état ; la partie
    // continue doit l'avoir tenu de même, sevrés et apparus compris.
    const content = testData;
    const state = populated(content);
    let compared = 0;
    for (let month = 0; month < 4; month++) {
      for (const at of [3, 17]) {
        while (state.day < at) advanceDay(state, [], content);
        const copy = restoreState(saveState(state, GENERATOR_VERSION, content), content);
        for (let ahead = 0; ahead < 12; ahead++) {
          advanceDay(state, [], content);
          advanceDay(copy, [], content);
        }
        expect(fingerprint(copy), `mois ${String(month)}, jour ${String(at)}`).toBe(
          fingerprint(state),
        );
        expect(describeMovement(copy).text).toBe(describeMovement(state).text);
        compared++;
      }
      while (state.day !== 0) advanceDay(state, [], content);
    }
    expect(compared).toBe(8);
  });

  it('étale les premiers choix d’une apparition sur la durée d’un repos', () => {
    const content = withoutFauna(testData);
    const state = flatState('foule');
    for (let index = 0; index < 20; index++) {
      spawnAt(state, 20 + 24 * index, 60 + 6 * (index % 5), 30, content);
    }
    const restMax = activities[REST_RANK]?.days?.[1] ?? 1;
    const free = state.people.count;
    const perDay: number[] = [];
    let before = state.movement.acts.counts.decisions;
    for (let day = 0; day < restMax; day++) {
      advanceDay(state, [], content);
      perDay.push(state.movement.acts.counts.decisions - before);
      before = state.movement.acts.counts.decisions;
    }
    // Personne ne choisit le jour de l'apparition ; ensuite, au plus trois fois la part d'un jour.
    expect(perDay[0]).toBe(0);
    expect(Math.max(...perDay)).toBeLessThanOrEqual(Math.ceil((3 * free) / restMax));
    expect(perDay.reduce((sum, count) => sum + count, 0)).toBeGreaterThan(free / 2);
    expect(dayIndex(state)).toBe(restMax);
  });
});

describe('activités : la chasse et le gibier (ADR 0021, § 5)', () => {
  it('ne fait jamais viser un animal par deux chasseurs, et libère ceux des chasseurs qui ne chassent plus', () => {
    const state = populated();
    let reserved = 0;
    for (let day = 0; day < 3 * DAYS_PER_MONTH; day++) {
      advanceDay(state, [], testData);
      const { fauna, people } = state;
      const hunters = new Set<number>();
      for (let animal = 0; animal < fauna.end; animal++) {
        const hunter = fauna.hunter[animal] ?? 0;
        if (hunter === 0 || fauna.alive[animal] !== 1) continue;
        reserved++;
        expect(hunters.has(hunter), `chasseur ${String(hunter)} en double`).toBe(false);
        hunters.add(hunter);
        const slot = people.slotOf(hunter);
        // Les réservations d'un chasseur mort, ou qui ne chasse plus, se libèrent le lendemain au
        // plus tard ; au soir d'un jour, le chasseur vit, et chasse ou vient de finir sa chasse.
        if (slot === undefined) continue;
        // Au soir d'un pas mensuel, qui part vers un autre camp peut la garder jusqu'au lendemain.
        expect([HUNT, FOLLOW]).toContain(people.get('activity', slot) & ACT_RANK);
      }
    }
    expect(reserved).toBeGreaterThan(100);
    expect(state.movement.acts.counts.strikes).toBeGreaterThan(5);
  });

  it('donne au chasseur un affût hors de la distance de fuite de l’animal, et ne frappe qu’au repos', () => {
    const state = populated();
    let stalking = 0;
    let close = 0;
    for (let day = 0; day < 2 * DAYS_PER_MONTH; day++) {
      advanceDay(state, [], testData);
      const { fauna, people } = state;
      const { width } = state.size;
      for (let animal = 0; animal < fauna.end; animal++) {
        const hunter = fauna.hunter[animal] ?? 0;
        if (hunter === 0 || fauna.alive[animal] !== 1) continue;
        const slot = people.slotOf(hunter);
        if (slot === undefined || (people.get('move', slot) & INTENTION) !== WALK) continue;
        // Il marche vers son affût : à `stalk` distances de fuite de l'animal quand il l'a visé ;
        // l'animal a pu s'en approcher depuis, de `revise` case au plus.
        const flee = testData.fauna.entries.at(fauna.species[animal] ?? 0)?.flee.distance ?? 1;
        const { revise } = testData.activities.rules.hunt;
        const gx = deltaFixedX(fauna.x[animal] ?? 0, people.get('goalX', slot), width) / FIXED;
        const gy = (people.get('goalY', slot) - (fauna.y[animal] ?? 0)) / FIXED;
        const apart = Math.sqrt(gx * gx + gy * gy);
        if (apart > 3 * flee) continue;
        stalking++;
        if (apart <= flee - revise) close++;
      }
    }
    expect(stalking).toBeGreaterThan(20);
    // L'animal s'approche parfois de l'affût depuis que le chasseur l'a visé : rarement.
    expect(close / stalking).toBeLessThan(0.1);
  });
});
