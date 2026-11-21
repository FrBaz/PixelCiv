import { describe, expect, it } from 'vitest';
import type { Species } from '../core/data';
import { carriedSide, cellOf, deltaFixedX, FIXED, wrapFixedX } from '../core/position';
import { RandomStream, streamSeed } from '../core/rng';
import { DAYS_PER_MONTH } from '../core/time';
import { advanceDay, step } from './day';
import { groupMembers } from './groups';
import {
  anchorOf,
  centralMember,
  describeMovement,
  guideOf,
  locateGroups,
  moveDay,
  rebuildMovement,
  segmentClear,
  trace,
} from './movement';
import { CARRIED, INTENTION, JOIN, LATE, LEAVE, NONE, REST, WALK } from './population';
import { restoreState, saveState } from './save';
import type { SimState } from './state';
import { applyCommands, fingerprint, monthStep, type SimContent } from './step';
import {
  flatState,
  flooded,
  scatteredGroups,
  testData,
  testHuman,
  testState,
  withHuman,
  withoutActivities,
} from './testing';
import { GENERATOR_VERSION } from '../worldgen/generate';

/** Le scénario de 3 000 individus de state.test.ts : cent groupes de trente. */
function populated(seed = 'graine'): SimState {
  const state = testState(seed);
  step(state, scatteredGroups(state, 100), testData);
  return state;
}

/** Les caches tenus au fil des jours sont ceux que l'état redonne : refaits, ils ne changent pas. */
function expectCachesFromState(state: SimState, label: string): void {
  const kept = describeMovement(state);
  expect(kept.problems, label).toEqual([]);
  rebuildMovement(state);
  expect(describeMovement(state).text, label).toBe(kept.text);
}

/** Intention d'un emplacement. */
const intention = (state: SimState, slot: number) => state.people.get('move', slot) & INTENTION;

/** Distance, en cases, entre deux positions en unités, au plus court à travers la couture. */
function apart(state: SimState, ax: number, ay: number, bx: number, by: number): number {
  const dx = deltaFixedX(ax, bx, state.size.width) / FIXED;
  const dy = (by - ay) / FIXED;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Le trentième jour, comme advanceDay le fait : la marche du jour, puis le pas mensuel ;
 * renvoie les positions de chacun entre les deux, et le groupe de chacun avant le pas.
 */
function monthEnd(state: SimState, content: SimContent = testData) {
  moveDay(state, content);
  const before = positions(state);
  const groups = new Map<number, number>();
  const carried = new Set<number>();
  state.people.forEach((slot) => {
    const id = state.people.get('id', slot);
    groups.set(id, state.people.get('group', slot));
    if (intention(state, slot) === CARRIED) carried.add(id);
  });
  monthStep(state, content);
  state.day = 0;
  return { before, groups, carried };
}

/** Position de chaque vivant, par identifiant. */
function positions(state: SimState): Map<number, [number, number]> {
  const map = new Map<number, [number, number]>();
  const { x, y, id } = state.people.columns;
  state.people.forEach((slot) => map.set(id[slot] ?? 0, [x[slot] ?? 0, y[slot] ?? 0]));
  return map;
}

/**
 * Un monde plat, avec un lac en U ouvert au nord autour de (100, 128), une presqu'île qui
 * s'avance dans le lac, et des eaux qui se touchent par un coin.
 */
const lakeWorld = flooded((x, y) => {
  const inU = x >= 90 && x <= 110 && y >= 120 && y <= 140;
  const hollow = x >= 95 && x <= 105 && y >= 120 && y <= 134;
  const peninsula = x >= 99 && x <= 101 && y >= 128 && y <= 140;
  const corner = (x === 80 && y === 128) || (x === 81 && y === 129);
  return (inU && !hollow && !peninsula) || corner;
});

/** Fait apparaître `count` humains des plaines sur la case (x, y) ; renvoie l'identifiant du groupe. */
function spawnAt(
  state: SimState,
  x: number,
  y: number,
  count: number,
  content: SimContent = testData,
) {
  const next = state.society.nextGroupId;
  applyCommands(
    state,
    [{ type: 'spawnGroup', x, y, species: 'human', subspecies: 'plains', count }],
    content,
  );
  return next;
}

describe('mouvement des individus : déterminisme (ADR 0014)', () => {
  it('donne la même empreinte jour par jour, par mois entiers, et quel que soit l’ordre des marcheurs', () => {
    const daily = populated();
    const monthly = populated();
    const shuffled = populated();
    const random = new RandomStream(streamSeed('mélange', 'tests'));
    for (let month = 0; month < 12; month++) {
      step(monthly, [], testData);
      for (let day = 0; day < DAYS_PER_MONTH; day++) {
        advanceDay(daily, [], testData);
        // Les marcheurs dans un ordre quelconque : l'état n'en dépend pas.
        const { movement } = shuffled;
        const list = movement.active;
        for (let index = movement.activeCount - 1; index > 0; index--) {
          const other = random.nextInt(index + 1);
          const swap = list[index] ?? 0;
          list[index] = list[other] ?? 0;
          list[other] = swap;
        }
        advanceDay(shuffled, [], testData);
      }
      expect(fingerprint(daily), `mois ${String(month)}`).toBe(fingerprint(monthly));
      expect(fingerprint(shuffled), `mois ${String(month)}`).toBe(fingerprint(monthly));
    }
    expect(monthly.movement.counts.legs).toBeGreaterThan(10_000);
  });

  it('tient ses caches comme l’état les redonne, et se relit en cours de mois, pinceau et détours compris', () => {
    // Avec les activités (ADR 0021), et sans elles, comme en 2b.7, où le lac demande des détours.
    const run = (content: typeof testData) => {
      const state = flatState('caches', lakeWorld);
      for (const [x, y] of [
        [100, 124],
        [100, 138],
        [86, 128],
        [70, 110],
        [120, 150],
      ] as const) {
        spawnAt(state, x, y, 24, content);
      }
      let copy: SimState | undefined;
      for (let day = 0; day < 8 * DAYS_PER_MONTH; day++) {
        const commands =
          day === 100 ? [{ type: 'paintBiome' as const, x: 97, y: 125, biome: 'marsh' }] : [];
        advanceDay(state, commands, content);
        if (copy !== undefined) advanceDay(copy, commands, content);
        if (day % 3 === 0) expectCachesFromState(state, `jour ${String(day)}`);
        // Une sauvegarde au jour 7 du troisième mois, relue : la suite est la même.
        if (day === 2 * DAYS_PER_MONTH + 7) {
          copy = restoreState(saveState(state, GENERATOR_VERSION, content), content);
          expect(describeMovement(copy).text).toBe(describeMovement(state).text);
        }
      }
      if (copy === undefined) throw new Error('pas de relecture');
      expect(fingerprint(copy)).toBe(fingerprint(state));
      return state;
    };
    run(testData);
    // Le lac a demandé des détours, par le champ de distances d'un camp.
    const plain = run(withoutActivities(testData));
    expect(plain.movement.counts.detours).toBeGreaterThan(0);
    expect(plain.movement.counts.fields).toBeGreaterThan(0);
  });

  it('compte ses marcheurs sans les arrivés du jour, que sa liste garde jusqu’au lendemain', () => {
    const state = populated();
    let kept = 0;
    for (let day = 0; day < 3 * DAYS_PER_MONTH; day++) {
      advanceDay(state, [], testData);
      let walking = 0;
      state.people.forEach((slot) => {
        if (intention(state, slot) === WALK) walking++;
      });
      expect(state.movement.walkers, `jour ${String(day)}`).toBe(walking);
      kept += state.movement.activeCount - walking;
    }
    expect(kept).toBeGreaterThan(1000);
  });
});

describe('segments : cases traversées, règle du coin, coût au prorata (ADR 0014)', () => {
  // Un monde de 8 × 4 cases : la colonne 2 coûte 3 et la case (7, 3) coûte 5 ; les cases
  // (5, 1) et (6, 2) sont de l'eau, qui se touchent par un coin ; tout le reste coûte 1.
  const width = 8;
  const height = 4;
  const cost = new Float32Array(width * height).fill(1);
  for (let y = 0; y < height; y++) cost[y * width + 2] = 3;
  cost[3 * width + 7] = 5;
  cost[1 * width + 5] = Infinity;
  cost[2 * width + 6] = Infinity;
  const at = (x: number) => Math.round(x * FIXED);
  const units = (ax: number, ay: number, bx: number, by: number) => {
    const result = trace(cost, width, height, ax, ay, bx, by);
    return { clear: result.clear, cost: result.cost, blocked: result.blocked };
  };
  const path = (ax: number, ay: number, bx: number, by: number) =>
    units(at(ax), at(ay), at(bx), at(by));

  it('compte chaque case au prorata du chemin qu’on y fait', () => {
    const across = path(0.5, 0.5, 4.5, 0.5);
    expect(across.clear).toBe(true);
    // Une demi-case, puis une case, une case à 3, une case, une demi-case : 6 sur 4 cases.
    expect(across.cost).toBeCloseTo(6 / 4, 9);
    expect(path(0.5, 0.5, 0.7, 0.9)).toMatchObject({ clear: true, cost: 1 });
  });

  it('bute sur l’eau, et dit la part du chemin faite avant elle', () => {
    const blocked = path(3.5, 1.5, 7.5, 1.5);
    expect(blocked.clear).toBe(false);
    // Le bord de la case (5, 1) tombe à 1,5 case sur 4.
    expect(blocked.blocked).toBeCloseTo(1.5 / 4, 9);
    // Un bout posé sur le bord d'une case d'eau la touche : il bute aussi.
    expect(path(3.5, 1.5, 5, 1.5).clear).toBe(false);
    expect(path(3.5, 1.5, 4.999, 1.5).clear).toBe(true);
  });

  it('ne passe un coin qu’entre cases franchissables, même à moins de 2^-16 case du coin', () => {
    // Le coin (6, 1) touche l'eau (5, 1) et trois cases franchissables, (5, 0), (6, 0) et
    // (6, 1) : en diagonale par ce coin, dans un sens comme dans l'autre, on bute sur l'eau.
    expect(path(5.5, 0.5, 6.5, 1.5).clear).toBe(false);
    expect(path(6.5, 1.5, 5.5, 0.5).clear).toBe(false);
    // Le coin commun aux deux eaux, (6, 2), ne se passe pas non plus.
    expect(path(5.5, 2.5, 6.5, 1.5).clear).toBe(false);
    // Passer à moins de 2^-16 case d'un coin, c'est passer par ce coin : de (5,5 ; 0,5) à une
    // unité à l'est de (6,5 ; 1,5), on frôle le coin (6, 1) par (6, 0), à 0,7 × 2^-16 case.
    expect(units(at(5.5), at(0.5), at(6.5) + 1, at(1.5)).clear).toBe(false);
    // À quatre unités, on passe à 2,8 × 2^-16 case du coin : on passe, par (6, 0).
    expect(units(at(5.5), at(0.5), at(6.5) + 4, at(1.5))).toMatchObject({ clear: true });
    // Par un coin entre quatre cases franchissables, on passe.
    expect(path(0.5, 0.5, 1.5, 1.5).clear).toBe(true);
  });

  it('passe la couture, déroulée depuis le départ', () => {
    // De (7,5 ; 0,5) à (8,5 ; 0,5), c'est-à-dire (0,5 ; 0,5) de l'autre côté.
    expect(path(7.5, 0.5, 8.5, 0.5)).toMatchObject({ clear: true, cost: 1 });
    // De (1,5 ; 3,5) vers l'ouest jusqu'à (−2,5 ; 3,5) : la case (7, 3), à 5, est la colonne
    // −1, et la colonne 2 n'est pas traversée ; (0,5 + 1 + 5 + 1 + 0,5) / 4 = 2.
    expect(path(1.5, 3.5, -2.5, 3.5).cost).toBeCloseTo(2, 9);
  });
});

describe('mouvement des individus : terrain (ADR 0014)', () => {
  it('passe la couture : toute abscisse reste dans le monde', () => {
    const state = flatState('couture');
    spawnAt(state, 0, 60, 30);
    spawnAt(state, 511, 90, 30);
    const span = state.size.width * FIXED;
    let crossings = 0;
    let previous = positions(state);
    for (let day = 0; day < 8 * DAYS_PER_MONTH; day++) {
      advanceDay(state, [], testData);
      const now = positions(state);
      for (const [id, [x]] of now) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(span);
        const before = previous.get(id);
        if (before !== undefined && Math.abs(x - before[0]) > span / 2) crossings++;
      }
      previous = now;
    }
    expect(crossings).toBeGreaterThan(5);
  });

  it('ne pose personne sur l’eau, et aucun segment du jour ne la traverse ni n’en coupe un coin', () => {
    // Avec les activités (ADR 0021), et sans elles, comme en 2b.7 : leurs allées et venues ne
    // changent pas le tour du lac, que la partie sans activités fait par détours.
    const run = (content: SimContent) => {
      const state = flatState('lac', lakeWorld);
      for (const [x, y] of [
        [100, 124],
        [100, 136],
        [92, 116],
        [84, 128],
        [112, 132],
      ] as const) {
        spawnAt(state, x, y, 26, content);
      }
      const { width } = state.size;
      let segments = 0;
      let previous = positions(state);
      for (let day = 0; day < 24 * DAYS_PER_MONTH; day++) {
        advanceDay(state, [], content);
        const now = positions(state);
        const { people } = state;
        people.forEach((slot) => {
          const id = people.get('id', slot);
          const [x, y] = now.get(id) ?? [0, 0];
          expect(
            state.cost[cellOf(x, y, width)],
            `${String(id)} au jour ${String(day)}`,
          ).toBeLessThan(Infinity);
          const before = previous.get(id);
          if (before === undefined || intention(state, slot) === CARRIED) return;
          if (before[0] === x && before[1] === y) return;
          segments++;
          expect(segmentClear(state, before[0], before[1], x, y), `segment de ${String(id)}`).toBe(
            true,
          );
        });
        previous = now;
      }
      expect(segments).toBeGreaterThan(2000);
      return state;
    };
    run(testData);
    const plain = run(withoutActivities(testData));
    expect(plain.movement.counts.detours).toBeGreaterThan(0);
    expect(plain.movement.counts.fields).toBeGreaterThan(0);
  });
});

describe('mouvement des individus : espacement et grégarité (ADR 0014)', () => {
  it('espace les gens au repos, et les marcheurs qui marcheraient côte à côte', () => {
    const state = flatState('espace', lakeWorld);
    for (let index = 0; index < 16; index++) {
      spawnAt(state, 40 + 40 * (index % 8), 60 + 60 * Math.floor(index / 8), 30);
    }
    let resting = 0;
    let crowded = 0;
    let walking = 0;
    let lasting = 0;
    const runs = new Map<number, [neighbor: number, days: number]>();
    for (let day = 0; day < 12 * DAYS_PER_MONTH; day++) {
      advanceDay(state, [], testData);
      if (day < DAYS_PER_MONTH) continue;
      const { people } = state;
      const { x, y, id } = people.columns;
      const rest: number[] = [];
      const walk: number[] = [];
      people.forEach((slot) => {
        if (intention(state, slot) === REST) rest.push(slot);
        else if (intention(state, slot) === WALK) walk.push(slot);
      });
      const nearest = (slot: number, list: readonly number[]) => {
        let best = Infinity;
        let who = -1;
        for (const other of list) {
          if (other === slot) continue;
          const distance = apart(state, x[slot] ?? 0, y[slot] ?? 0, x[other] ?? 0, y[other] ?? 0);
          if (distance < best) {
            best = distance;
            who = other;
          }
        }
        return [best, who] as const;
      };
      if (day % 10 === 0) {
        for (const slot of rest) {
          resting++;
          if (nearest(slot, rest)[0] < 0.45) crowded++;
        }
      }
      const seen = new Set<number>();
      for (const slot of walk) {
        walking++;
        const [distance, who] = nearest(slot, walk);
        const me = id[slot] ?? 0;
        seen.add(me);
        if (distance >= 0.2) {
          runs.delete(me);
          continue;
        }
        const other = id[who] ?? 0;
        const run = runs.get(me);
        const days = run?.[0] === other ? run[1] + 1 : 1;
        runs.set(me, [other, days]);
        if (days >= 3) lasting++;
      }
      for (const me of [...runs.keys()]) if (!seen.has(me)) runs.delete(me);
    }
    expect(resting).toBeGreaterThan(3000);
    expect(walking).toBeGreaterThan(3000);
    // Au repos, 99 % à 0,45 case au moins d'un autre ; en marche, au plus 1 % des jours à
    // moins de 0,2 case d'un même voisin trois jours de suite.
    expect(crowded / resting).toBeLessThan(0.01);
    expect(lasting / walking).toBeLessThan(0.01);
    expect(state.movement.counts.asides).toBeGreaterThan(0);
  });

  it('serre les grégaires près du camp, et les fait partir plus tôt', () => {
    const measure = (mean: number) => {
      const content = withHuman((human): Species => ({
        ...human,
        upbringing: 0,
        subspecies: human.subspecies.map((entry) => ({
          ...entry,
          temperament: { gregariousness: { mean, sd: 0 } },
        })),
      }));
      const state = flatState('grégarité');
      for (let index = 0; index < 8; index++) spawnAt(state, 40 + 50 * index, 100, 28, content);
      let days = 0;
      let departures = 0;
      let distance = 0;
      let resting = 0;
      let kin = 0;
      let near = 0;
      for (let month = 0; month < 10; month++) {
        // Le jour du départ de chacun, au plan du mois, hors des guides.
        step(state, [], content);
        const { people } = state;
        people.forEach((slot) => {
          if (intention(state, slot) !== LEAVE) return;
          if (guideOf(state, people.get('group', slot)) === slot) return;
          days += people.get('depart', slot);
          departures++;
        });
        // Au soir du dernier jour, l'écart des gens au repos au barycentre de leur groupe, et
        // celui des gens qui se placent près d'un proche (un parent, un conjoint) à ce proche.
        while (state.day < DAYS_PER_MONTH - 1) advanceDay(state, [], content);
        for (const [group, list] of groupMembers(people)) {
          const center = centralMember(state, list);
          if (center < 0 || state.society.groups.get(group) === undefined) continue;
          for (const slot of list) {
            if (intention(state, slot) !== REST) continue;
            const x = people.get('x', slot);
            const y = people.get('y', slot);
            const cx = (center % state.size.width) * FIXED + FIXED / 2;
            const cy = Math.floor(center / state.size.width) * FIXED + FIXED / 2;
            distance += apart(state, cx, cy, x, y);
            resting++;
            const anchor = anchorOf(state, content, slot);
            if (anchor < 0 || anchor === guideOf(state, group)) continue;
            if (intention(state, anchor) !== REST) continue;
            kin += apart(state, people.get('x', anchor), people.get('y', anchor), x, y);
            near++;
          }
        }
      }
      return { day: days / departures, distance: distance / resting, kin: kin / near };
    };
    const loner = measure(0.1);
    const social = measure(0.9);
    expect(social.day).toBeLessThan(loner.day);
    expect(social.distance).toBeLessThan(loner.distance);
    expect(loner.day - social.day).toBeGreaterThan(2);
    // Rayons des proches : 0,6 + 1,2 × (1 − g'), soit 1,14 case pour g' = 0,55 et 0,66 pour
    // g' = 0,95 ; l'écart moyen suit, à l'espacement près (0,86 et 0,61 case, ici).
    expect(social.kin).toBeLessThan(0.85 * loner.kin);
  });

  it('marche à son allure : une case par jour sur la steppe, moitié moins sur un terrain de coût 2', () => {
    const speeds = (biome: string) => {
      const marsh = testData.biomes.indexOf(biome) ?? 0;
      const state = flatState('allure', (world) => world.biome.fill(marsh));
      for (let index = 0; index < 6; index++) spawnAt(state, 40 + 60 * index, 120, 30);
      const values: number[] = [];
      for (let day = 0; day < 6 * DAYS_PER_MONTH; day++) {
        advanceDay(state, [], testData);
        const { people } = state;
        people.forEach((slot) => {
          if (intention(state, slot) !== WALK || people.get('stepDays', slot) < 2) return;
          const years = (state.tick - people.get('birth', slot)) / 12;
          if (years < 18 || years > 45) return;
          const sx = people.get('stepX', slot) / FIXED;
          const sy = people.get('stepY', slot) / FIXED;
          values.push(Math.sqrt(sx * sx + sy * sy));
        });
      }
      values.sort((a, b) => a - b);
      return values[Math.floor(values.length / 2)] ?? 0;
    };
    const steppe = speeds('steppe');
    expect(steppe).toBeGreaterThanOrEqual(0.95);
    expect(steppe).toBeLessThanOrEqual(1.1);
    const marsh = speeds('marsh');
    expect(marsh / steppe).toBeGreaterThan(0.45);
    expect(marsh / steppe).toBeLessThan(0.55);
  });
});

describe('mouvement des individus : vie, mort et changements de groupe (ADR 0014)', () => {
  it('change de groupe à pied : position gardée au pas mensuel, marche bornée, arrivée au camp', () => {
    const state = populated('autre');
    const started = new Map<number, number>();
    const durations: number[] = [];
    let changed = 0;
    for (let month = 0; month < 18; month++) {
      for (let day = 0; day < DAYS_PER_MONTH - 1; day++) {
        const before = positions(state);
        advanceDay(state, [], testData);
        // Chaque jour, un pas d'au plus l'allure la plus vive, ou un écart de côté.
        const { people } = state;
        people.forEach((slot) => {
          const id = people.get('id', slot);
          const was = before.get(id);
          if (was === undefined) return;
          const moved = apart(state, was[0], was[1], people.get('x', slot), people.get('y', slot));
          expect(moved).toBeLessThan(2.5);
        });
      }
      // Le pas mensuel : qui change de groupe ne bouge pas.
      const { before, groups: groupOf, carried } = monthEnd(state);
      const after = positions(state);
      const { people } = state;
      const t = state.tick * DAYS_PER_MONTH;
      people.forEach((slot) => {
        const id = people.get('id', slot);
        const from = groupOf.get(id);
        if (from === undefined || from === people.get('group', slot)) return;
        // Un nourrisson suit sa mère ; sevré, on le dessinait déjà contre elle.
        if (intention(state, slot) === CARRIED || carried.has(id)) return;
        changed++;
        expect(after.get(id)).toEqual(before.get(id));
        expect(people.get('move', slot) & JOIN).toBe(JOIN);
        // Qui change encore de groupe en chemin (un orphelin rendu à un autre groupe) rejoint
        // le nouveau : sa marche se compte de ce changement.
        started.set(id, t);
      });
      for (const [id, start] of started) {
        const slot = people.slotOf(id);
        if (slot === undefined) {
          started.delete(id);
        } else if ((people.get('move', slot) & JOIN) === 0) {
          durations.push(t - start);
          started.delete(id);
        }
      }
    }
    expect(changed).toBeGreaterThan(50);
    expect(durations.length).toBeGreaterThan(50);
    // Le groupe attend qui le rejoint : chacun arrive en moins de quatre mois.
    expect(Math.max(...durations)).toBeLessThan(120);
  });

  it('porte le nouveau-né à la position de sa mère, puis le sèvre à 0,3 case d’elle au plus', () => {
    const state = populated('pixelciv');
    let carried = 0;
    let weaned = 0;
    for (let month = 0; month < 14; month++) {
      for (let day = 0; day < DAYS_PER_MONTH - 1; day++) {
        advanceDay(state, [], testData);
        const { people } = state;
        people.forEach((slot) => {
          if (intention(state, slot) !== CARRIED) return;
          carried++;
          const mother = people.slotOf(people.get('mother', slot));
          if (mother === undefined) throw new Error('porté sans mère');
          expect([people.get('x', slot), people.get('y', slot)]).toEqual([
            people.get('x', mother),
            people.get('y', mother),
          ]);
        });
      }
      const before = new Set<number>();
      state.people.forEach((slot) => {
        if (intention(state, slot) === CARRIED) before.add(state.people.get('id', slot));
      });
      advanceDay(state, [], testData);
      const { people } = state;
      for (const id of before) {
        const slot = people.slotOf(id);
        if (slot === undefined || intention(state, slot) === CARRIED) continue;
        const mother = people.slotOf(people.get('mother', slot));
        if (mother === undefined || intention(state, mother) !== REST) continue;
        if (intention(state, slot) !== WALK) continue;
        weaned++;
        const goal = apart(
          state,
          people.get('x', mother),
          people.get('y', mother),
          people.get('goalX', slot),
          people.get('goalY', slot),
        );
        // À l'arrondi près de la virgule fixe.
        expect(goal).toBeLessThanOrEqual(testData.nomads.camp.wean + 1e-4);
        const start = apart(
          state,
          people.get('x', mother),
          people.get('y', mother),
          people.get('x', slot),
          people.get('y', slot),
        );
        expect(start).toBeLessThanOrEqual(testHuman.display.carry + 1e-4);
      }
    }
    expect(carried).toBeGreaterThan(1000);
    expect(weaned).toBeGreaterThan(3);
  });

  it('fait partir qui marchait encore, le transféré et le sevré le jour 0, ou avec leur ancre', () => {
    // Ils n'ont pas de décalage propre : ils partent le jour 0, ou le jour de leur ancre si
    // elle part plus tard, et l'attendent sur place ; le nourrisson sevré part avec sa mère.
    const state = populated('pixelciv');
    const { columns } = state.people;
    const leaving = (slot: number) => intention(state, slot) === LEAVE;
    const seen = { late: 0, waiting: 0, joined: 0, withWalker: 0, withLeaver: 0 };
    for (let month = 0; month < 14; month++) {
      while (state.day < DAYS_PER_MONTH - 1) advanceDay(state, [], testData);
      const { groups, carried } = monthEnd(state);
      // L'ancre d'un mineur dépend de son âge : elle se lit au mois du plan.
      state.tick--;
      state.people.forEach((slot) => {
        if (!leaving(slot)) return;
        const id = columns.id[slot] ?? 0;
        const anchor = anchorOf(state, testData, slot);
        const anchorDay = anchor >= 0 && leaving(anchor) ? (columns.depart[anchor] ?? 0) : 0;
        const before = groups.get(id);
        if (carried.has(id)) {
          // Sevré, sa mère dans son groupe : elle est son ancre, et part ou marche.
          const mother = state.people.slotOf(columns.mother[slot] ?? NONE);
          if (mother === undefined || columns.group[mother] !== columns.group[slot]) return;
          expect(anchor).toBe(mother);
          if (intention(state, mother) === WALK) seen.withWalker++;
          else seen.withLeaver++;
        } else if ((state.people.get('move', slot) & LATE) !== 0) {
          seen.late++;
          if (anchorDay > 0) seen.waiting++;
        } else if (before !== undefined && before !== columns.group[slot]) {
          seen.joined++;
        } else {
          return;
        }
        expect(columns.depart[slot], String(id)).toBe(anchorDay);
      });
      state.tick++;
    }
    expect(seen.late).toBeGreaterThan(1000);
    expect(seen.waiting).toBeGreaterThan(100);
    expect(seen.joined).toBeGreaterThan(100);
    expect(seen.withLeaver).toBeGreaterThan(50);
    expect(seen.withWalker).toBeGreaterThan(0);
  });

  it('ne fait bouger personne au pas mensuel, morts comprises', () => {
    const state = populated();
    let deaths = 0;
    let kept = 0;
    let released = 0;
    let orphans = 0;
    for (let month = 0; month < 12; month++) {
      while (state.day < DAYS_PER_MONTH - 1) advanceDay(state, [], testData);
      // Au soir du dernier jour, après la marche du jour : le pas mensuel ne déplace personne,
      // sauf les nourrissons qui quittent les bras de leur mère, sevrés ou orphelins : ils se
      // posent là où on les dessinait, contre elle, du côté que dit leur identifiant, si la
      // case se franchit, et sur elle sinon (render, PositionMirror).
      const archived = state.people.archive.rows;
      const { before, carried } = monthEnd(state);
      deaths += state.people.archive.rows - archived;
      const { width } = state.size;
      for (const [id, now] of positions(state)) {
        const was = before.get(id);
        if (was === undefined) continue;
        const slot = state.people.slotOf(id);
        if (carried.has(id) && slot !== undefined && intention(state, slot) !== CARRIED) {
          const offset = Math.round(carriedSide(id) * testHuman.display.carry * FIXED);
          const drawn = wrapFixedX(was[0] + offset, width);
          const dry = Number.isFinite(state.cost[cellOf(drawn, was[1], width)] ?? Number.NaN);
          expect(now, String(id)).toEqual([dry ? drawn : was[0], was[1]]);
          released++;
          if (state.people.slotOf(state.people.get('mother', slot)) === undefined) orphans++;
        } else {
          expect(now, String(id)).toEqual(was);
          kept++;
        }
      }
    }
    expect(deaths).toBeGreaterThan(20);
    expect(kept).toBeGreaterThan(10_000);
    expect(released).toBeGreaterThan(5);
    expect(orphans).toBeGreaterThan(0);
  });

  it('situe un groupe à travers la couture, et prend pour guide son meneur, sinon l’aîné', () => {
    const state = flatState('lieu');
    const id = spawnAt(state, 0, 80, 12);
    const group = state.society.groups.get(id);
    if (group === undefined) throw new Error('pas de groupe');
    const list = groupMembers(state.people).get(id) ?? [];
    // La moitié des membres juste à l'ouest de la couture, l'autre juste à l'est.
    const span = state.size.width * FIXED;
    list.forEach((slot, rank) => {
      state.people.set('x', slot, rank % 2 === 0 ? span - FIXED / 4 : FIXED / 4);
      state.people.set('y', slot, 80 * FIXED + FIXED / 2);
    });
    locateGroups(state, groupMembers(state.people));
    expect([0, state.size.width - 1]).toContain(group.x);
    expect(group.y).toBe(80);
    rebuildMovement(state);
    const leader = state.people.slotOf(group.leader);
    expect(guideOf(state, id)).toBe(leader);
    // Le meneur mort, l'aîné des autres guide le groupe.
    if (leader === undefined) throw new Error('pas de meneur');
    state.people.remove(leader, state.tick, 'accident');
    rebuildMovement(state);
    const eldest = (groupMembers(state.people).get(id) ?? []).reduce((best, slot) =>
      state.people.get('birth', slot) < state.people.get('birth', best) ? slot : best,
    );
    expect(guideOf(state, id)).toBe(eldest);
    expect(state.people.get('group', eldest)).toBe(id);
  });
});
