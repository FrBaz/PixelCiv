import { describe, expect, it } from 'vitest';
import { deltaX } from '../core/cylinder';
import { readSave, writeSave } from '../core/save/format';
import type { WorldSize } from '../core/world';
import { GENERATOR_VERSION } from '../worldgen/generate';
import { depletedCells, disk, feedGroup } from './forage';
import {
  cellDistance,
  groupMembers,
  households,
  mergeGroup,
  moveGroup,
  splitGroup,
  walk,
  walkBudget,
  walkCosts,
} from './groups';
import { MONTHS_PER_YEAR } from './people';
import { NONE } from './population';
import { MIGRATIONS, restoreState, saveState } from './save';
import { spawnGroup } from './spawn';
import type { SimState } from './state';
import { fingerprint, step, type SimContent } from './step';
import { terrainLands } from './terrain';
import { flatState, flooded, scatteredGroups, testData, testHuman, testState } from './testing';

/** Première case d'un biome. */
function cellOf(state: SimState, biome: string): { x: number; y: number } {
  const cell = state.world.biome.indexOf(testData.biomes.indexOf(biome) ?? -1);
  if (cell < 0) throw new Error(`pas de case ${biome}`);
  return { x: cell % state.size.width, y: Math.floor(cell / state.size.width) };
}

/** Fait apparaître un groupe, sans faire passer de mois. */
function spawn(
  state: SimState,
  at: { x: number; y: number },
  count = 30,
  subspecies = 'plains',
  content: SimContent = testData,
) {
  spawnGroup(state, { type: 'spawnGroup', ...at, species: 'human', subspecies, count }, content);
  const group = [...state.society.groups.values()].at(-1);
  if (group === undefined) throw new Error('aucun groupe');
  return group;
}

/** Coûts de marche d'un monde où tout est plaine (coût 1). */
function plain(size: WorldSize): Float32Array {
  return new Float32Array(size.width * size.height).fill(1);
}

/**
 * Terres où l'on marche : composantes des cases franchissables, voisines par un côté
 * (4-connexité), x bouclant ; -1 pour une case infranchissable.
 */
function lands(cost: Float32Array, size: WorldSize): Int32Array {
  const { width, height } = size;
  const label = new Int32Array(cost.length).fill(-1);
  let next = 0;
  for (let start = 0; start < cost.length; start++) {
    if (label[start] !== -1 || !Number.isFinite(cost[start] ?? Number.POSITIVE_INFINITY)) continue;
    label[start] = next;
    const queue = [start];
    for (let cell = queue.pop(); cell !== undefined; cell = queue.pop()) {
      const x = cell % width;
      const y = (cell - x) / width;
      const around = [
        y * width + ((x + 1) % width),
        y * width + ((x + width - 1) % width),
        y > 0 ? cell - width : -1,
        y < height - 1 ? cell + width : -1,
      ];
      for (const near of around) {
        if (near < 0 || label[near] !== -1) continue;
        if (!Number.isFinite(cost[near] ?? Number.POSITIVE_INFINITY)) continue;
        label[near] = next;
        queue.push(near);
      }
    }
    next++;
  }
  return label;
}

/**
 * Coût de marche le plus faible de `from` vers chaque case `targets`, au plus `budget`,
 * calculé à part de walkCosts, par relaxations successives jusqu'à ce que rien ne bouge,
 * sur les cases à moins de `budget` + 1 colonnes et lignes de `from`, avec la couture et la
 * règle du coin : de quoi vérifier walkCosts.
 */
function referenceCosts(
  cost: Float32Array,
  size: WorldSize,
  from: { x: number; y: number },
  targets: readonly number[],
  budget: number,
): number[] {
  const { width, height } = size;
  const reach = Math.floor(budget) + 1;
  const spent = new Map<number, number>([[from.y * width + from.x, 0]]);
  const open = (x: number, y: number) =>
    y >= 0 && y < height && Number.isFinite(cost[y * width + ((x + width) % width)] ?? Infinity);
  for (let changed = true; changed;) {
    changed = false;
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const x = (from.x + dx + width) % width;
        const y = from.y + dy;
        const here = spent.get(y * width + x);
        if (here === undefined) continue;
        for (const [sx, sy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
          [1, 1],
          [1, -1],
          [-1, 1],
          [-1, -1],
        ] as const) {
          const nx = (x + sx + width) % width;
          const ny = y + sy;
          if (!open(nx, ny)) continue;
          if (sx !== 0 && sy !== 0 && (!open(nx, y) || !open(x, ny))) continue;
          const step =
            (cost[ny * width + nx] ?? Infinity) * (sx !== 0 && sy !== 0 ? Math.SQRT2 : 1);
          const total = here + step;
          const cell = ny * width + nx;
          if (total <= budget && total < (spent.get(cell) ?? Infinity) - 1e-12) {
            spent.set(cell, total);
            changed = true;
          }
        }
      }
    }
  }
  return targets.map((target) => spent.get(target) ?? Infinity);
}

/** Ce que l'on relève, mois après mois, sur un siècle de nomadisme. */
interface Century {
  /** Pas où un groupe a changé de terre en un mois, et ses deux cases. */
  readonly crossings: string[];
  /**
   * Pas où une personne a changé de terre en un mois, celle de la case de son groupe : par
   * une marche, une réunion, un mariage ou une scission.
   */
  readonly travellers: string[];
  /** Pas où deux groupes vivants avaient le même meneur. */
  readonly sharedLeaders: string[];
  /** Scissions dont le nouveau groupe a le même meneur que l'ancien. */
  readonly sameLeader: number;
  /** Scissions dont le meneur vivant du groupe d'origine est parti avec le nouveau groupe. */
  readonly leaderLeft: number;
  /** Nouveaux groupes dont le centre de l'aire tombe sur une case infranchissable. */
  readonly homesInWater: number;
  /**
   * Scissions dont le centre de l'aire du nouveau groupe est sur une autre terre que la
   * case de la scission, sans être l'aire du groupe d'origine, qu'il garde faute de mieux.
   */
  readonly homesElsewhere: string[];
  /** Scissions où aucune direction ne convient : le nouveau groupe garde l'aire d'origine. */
  readonly fallbacks: number;
  readonly splits: number;
  readonly merges: number;
  readonly groups: number;
}

const centuries = new Map<string, Century>();

/**
 * `count` groupes répartis sur le monde Petit de la graine `seed`, pendant un siècle
 * (calculé une fois). Les terres viennent ici d'un calcul indépendant de terrainLands.
 */
function playCentury(seed = 'graine', count = 16): Century {
  const key = `${seed}:${String(count)}`;
  const known = centuries.get(key);
  if (known !== undefined) return known;
  const state = testState(seed);
  const land = lands(state.cost, state.size);
  const { width } = state.size;
  const landOf = (group: { x: number; y: number }) => land[group.y * width + group.x] ?? -1;
  step(state, scatteredGroups(state, count), testData);
  const seen = new Map<number, { land: number; at: string }>();
  for (const group of state.society.groups.values()) {
    seen.set(group.id, { land: landOf(group), at: `${group.x},${group.y}` });
  }
  const crossings: string[] = [];
  const travellers: string[] = [];
  const homesElsewhere: string[] = [];
  const sharedLeaders: string[] = [];
  let sameLeader = 0;
  let leaderLeft = 0;
  let homesInWater = 0;
  let splits = 0;
  let merges = 0;
  let fallbacks = 0;
  // Terre de chaque personne au début du mois, par identifiant, et aire de chaque groupe.
  const landsBefore = new Map<number, number>();
  const homes = new Map<number, string>();
  for (let month = 1; month < 100 * MONTHS_PER_YEAR; month++) {
    const tick = state.tick;
    const { people, society } = state;
    landsBefore.clear();
    people.forEach((slot) => {
      const group = society.groups.get(people.get('group', slot));
      if (group !== undefined) landsBefore.set(people.get('id', slot), landOf(group));
    });
    homes.clear();
    for (const group of society.groups.values()) {
      homes.set(group.id, `${String(group.homeX)},${String(group.homeY)}`);
    }
    const facts = society.chronicle.length;
    step(state, [], testData);
    people.forEach((slot) => {
      const id = people.get('id', slot);
      const group = society.groups.get(people.get('group', slot));
      const was = landsBefore.get(id);
      if (group === undefined || was === undefined || was === landOf(group)) return;
      travellers.push(`pas ${String(tick)}, personne ${String(id)} : groupe ${String(group.id)}`);
    });
    for (const fact of society.chronicle.slice(facts)) {
      if (fact.kind === 'groupMerged') merges++;
      const child = society.groups.get(fact.other);
      if (fact.kind !== 'groupSplit' || child === undefined) continue;
      const home = { x: child.homeX, y: child.homeY };
      const at = `${String(home.x)},${String(home.y)}`;
      if (landOf(home) === landOf(fact)) continue;
      if (homes.get(fact.group) === at) fallbacks++;
      else homesElsewhere.push(`pas ${String(tick)}, groupe ${String(child.id)} : aire ${at}`);
    }
    const leaders = new Map<number, number>();
    for (const group of state.society.groups.values()) {
      const before = seen.get(group.id) ?? seen.get(group.parent);
      const now = landOf(group);
      if (before !== undefined && before.land !== now) {
        crossings.push(`pas ${tick}, groupe ${group.id} : ${before.at} → ${group.x},${group.y}`);
      }
      seen.set(group.id, { land: now, at: `${group.x},${group.y}` });
      if (group.leader !== NONE) {
        const other = leaders.get(group.leader);
        if (other !== undefined) sharedLeaders.push(`pas ${tick}, groupes ${other} et ${group.id}`);
        leaders.set(group.leader, group.id);
      }
      if (group.founded !== tick || group.parent === NONE) continue;
      splits++;
      if (!Number.isFinite(state.cost[group.homeY * width + group.homeX] ?? Number.NaN)) {
        homesInWater++;
      }
      const parent = state.society.groups.get(group.parent);
      if (parent === undefined) continue;
      if (parent.leader === group.leader) sameLeader++;
      const leader = state.people.slotOf(parent.leader);
      if (leader !== undefined && state.people.get('group', leader) === group.id) leaderLeft++;
    }
  }
  const century: Century = {
    crossings,
    travellers,
    sharedLeaders,
    sameLeader,
    leaderLeft,
    homesInWater,
    homesElsewhere,
    fallbacks,
    splits,
    merges,
    groups: state.society.groups.size,
  };
  centuries.set(key, century);
  return century;
}

describe('distance entre deux cases', () => {
  it('passe par la couture, quelles que soient les copies du monde où sont les colonnes (W-3)', () => {
    const width = 512;
    // De la colonne 5 à elle-même, puis à ses voisines, vue depuis chaque copie du monde.
    for (let copy = -2; copy <= 2; copy++) {
      const x = 5 + copy * width;
      expect(cellDistance(width, x, 10, 5, 10)).toBe(0);
      expect(cellDistance(width, x, 10, width - 3, 10)).toBe(8);
      expect(cellDistance(width, x, 10, 9, 13)).toBe(5);
    }
    expect(cellDistance(width, 0, 0, width / 2, 0)).toBe(width / 2);
  });
});

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

  it('parcourt bien son budget de plaine en un mois, en ligne droite ou en diagonale (D-8)', () => {
    const { size } = testState();
    const cost = plain(size);
    const budget = testData.nomads.walk;
    const from = { x: 100, y: 128 };
    for (const target of [
      { x: 300, y: 128 },
      { x: 200, y: 28 },
      { x: 0, y: 128 },
    ]) {
      const reached = walk(cost, size, from, target, budget);
      const covered = cellDistance(size.width, from.x, from.y, reached.x, reached.y);
      expect(covered).toBeGreaterThan(budget - 1.5);
      expect(covered).toBeLessThanOrEqual(budget + 1e-9);
    }
  });

  it('ne coupe pas un coin entre deux eaux qui se touchent en diagonale (F-2, D-2)', () => {
    // Une ligne d'eau en escalier, x = y : 8-connexe, elle a des coins, mais pas de passage.
    const { size } = testState();
    const cost = plain(size);
    for (let k = 0; k < 80; k++) cost[k * size.width + k] = Number.POSITIVE_INFINITY;
    const reached = walk(cost, size, { x: 40, y: 36 }, { x: 36, y: 40 }, 30);
    expect(reached.x).toBeGreaterThan(reached.y);
    // La même ligne, fermée sur ses côtés : le groupe la longe sans la franchir.
    for (let k = 0; k < 79; k++) cost[k * size.width + k + 1] = Number.POSITIVE_INFINITY;
    const along = walk(cost, size, { x: 40, y: 36 }, { x: 36, y: 40 }, 30);
    expect(along.x).toBeGreaterThan(along.y);
  });

  it('ne franchit aucun coin de mer, de lac ni de lit de fleuve du monde des tests', () => {
    const state = testState();
    const { width, height } = state.size;
    const { cost } = state;
    const passable = (x: number, y: number) =>
      Number.isFinite(cost[y * width + ((x + width) % width)] ?? Number.POSITIVE_INFINITY);
    const kinds = new Map<string, number>();
    for (let y = 0; y < height - 1; y++) {
      for (let x = 0; x < width; x++) {
        for (const dx of [1, -1]) {
          // A = (x, y), B = (x + dx, y + 1) : deux terres en diagonale, deux eaux entre elles.
          const bx = (x + dx + width) % width;
          if (!passable(x, y) || !passable(bx, y + 1)) continue;
          if (passable(bx, y) || passable(x, y + 1)) continue;
          const reached = walk(cost, state.size, { x, y }, { x: bx, y: y + 1 }, 30);
          expect(reached).toEqual({ x, y });
          const biome = (cx: number, cy: number) =>
            testData.biomes.entries.at(state.world.biome[cy * width + cx] ?? 0)?.id ?? '';
          const pair = [biome(bx, y), biome(x, y + 1)];
          const kind = pair.every((id) => id === 'river')
            ? 'fleuve'
            : pair.every((id) => id === 'lake')
              ? 'lac'
              : pair.every((id) => id.endsWith('ocean'))
                ? 'mer'
                : 'autre';
          kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
        }
      }
    }
    // Des coins de chaque sorte d'eau : la mer, les lacs, le lit des fleuves.
    expect(kinds.get('mer') ?? 0).toBeGreaterThan(10);
    expect(kinds.get('lac') ?? 0).toBeGreaterThan(2);
    expect(kinds.get('fleuve') ?? 0).toBeGreaterThan(10);
  });

  it('ne change jamais de terre en un siècle : ni la mer, ni les lacs, ni les fleuves (D-2)', () => {
    // Ni un groupe en marchant, ni l'un de ses membres en rejoignant un autre groupe : une
    // réunion, un mariage ou une scission ne font pas passer l'eau (3-nomades/P0).
    const { crossings, travellers, splits, merges, groups } = playCentury();
    expect(splits).toBeGreaterThan(30);
    expect(merges).toBeGreaterThan(10);
    expect(groups).toBeGreaterThan(16);
    expect(crossings).toEqual([]);
    expect(travellers).toEqual([]);
  });

  it('ne fait changer personne de terre en un siècle, sur « pixelciv » avec quarante groupes', () => {
    const { crossings, travellers, homesElsewhere, splits, merges } = playCentury('pixelciv', 40);
    expect(splits).toBeGreaterThan(60);
    expect(merges).toBeGreaterThan(10);
    expect(crossings).toEqual([]);
    expect(travellers).toEqual([]);
    // Le centre d'une nouvelle aire est sur la terre de la scission, sauf quand aucune des
    // huit directions n'y mène : le nouveau groupe garde alors l'aire du groupe d'origine.
    expect(homesElsewhere).toEqual([]);
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

  it('choisit sa destination à dix cases au plus de lui, l’aire le rappelant (F-12)', () => {
    // Une plaine uniforme, et un groupe à soixante cases du centre de son aire : partout la
    // même nourriture, seul compte le malus hors de l'aire. Les cases comparées se tirent
    // autour du groupe, et non dans son aire : chaque destination est à dix cases au plus
    // de lui, et le rapproche de l'aire.
    const state = flatState();
    const group = spawn(state, { x: 40, y: 60 });
    group.homeX = 100;
    group.homeY = 60;
    const members = groupMembers(state.people).get(group.id) ?? [];
    const random = state.rng.stream('tests');
    const { width } = state.size;
    const away = () => cellDistance(width, group.x, group.y, group.homeX, group.homeY);
    const start = away();
    for (let month = 0; month < 12; month++) {
      const from = { x: group.x, y: group.y };
      moveGroup(state, group, members, testData, random);
      expect(Math.abs(deltaX(from.x, group.targetX, width))).toBeLessThanOrEqual(10);
      expect(Math.abs(group.targetY - from.y)).toBeLessThanOrEqual(10);
    }
    expect(away()).toBeLessThan(start - 20);
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

  it('garde le meneur dans son groupe, et donne au nouveau groupe un autre meneur (F-4, W-8)', () => {
    // Le foyer du meneur est le premier, et le deuxième part : sans précaution, le meneur
    // s'en irait souvent avec le nouveau groupe, qui porterait son nom.
    for (let attempt = 0; attempt < 12; attempt++) {
      const state = flatState(`meneur ${String(attempt)}`);
      const group = spawn(state, { x: 100, y: 100 }, 48);
      const members = groupMembers(state.people).get(group.id) ?? [];
      const child = splitGroup(state, group, members, testData, state.rng.stream('tests'));
      if (child === undefined) throw new Error('pas de scission');
      const leader = state.people.slotOf(group.leader);
      expect(leader).toBeDefined();
      expect(state.people.get('group', leader ?? 0)).toBe(group.id);
      expect(child.leader).not.toBe(group.leader);
      // Le nouveau meneur est l'aîné de ceux qui partent.
      const gone = groupMembers(state.people).get(child.id) ?? [];
      const eldest = Math.min(...gone.map((slot) => state.people.get('birth', slot)));
      expect(state.people.get('birth', state.people.slotOf(child.leader) ?? 0)).toBe(eldest);
      expect(state.society.chronicle.at(-1)).toMatchObject({
        kind: 'groupSplit',
        leader: group.leader,
        otherLeader: child.leader,
      });
    }
    // Sur un siècle, deux groupes vivants n'ont jamais le même meneur.
    const { sharedLeaders, sameLeader, leaderLeft } = playCentury();
    expect(sameLeader).toBe(0);
    expect(leaderLeft).toBe(0);
    expect(sharedLeaders).toEqual([]);
  });

  it('ne donne pas au nouveau groupe le meneur d’un autre groupe vivant (F-4)', () => {
    const state = flatState('deux meneurs');
    const other = spawn(state, { x: 140, y: 100 }, 20);
    const group = spawn(state, { x: 100, y: 100 }, 48);
    // Le meneur de l'autre groupe a rejoint celui-ci, sans son conjoint : c'est le plus
    // âgé de tous, et son foyer, à lui seul, est le deuxième, qui part.
    const guest = state.people.slotOf(other.leader);
    if (guest === undefined) throw new Error('pas de meneur');
    state.people.set('group', guest, group.id);
    state.people.set('birth', guest, state.tick - 80 * MONTHS_PER_YEAR);
    const rest = (groupMembers(state.people).get(group.id) ?? []).filter((slot) => slot !== guest);
    const members = [...rest.slice(0, 1), guest, ...rest.slice(1)];
    const child = splitGroup(state, group, members, testData, state.rng.stream('tests'));
    if (child === undefined) throw new Error('pas de scission');
    expect(state.people.get('group', guest)).toBe(child.id);
    expect(child.leader).not.toBe(other.leader);
    expect(child.leader).not.toBe(group.leader);
    const gone = (groupMembers(state.people).get(child.id) ?? []).filter((slot) => slot !== guest);
    const eldest = Math.min(...gone.map((slot) => state.people.get('birth', slot)));
    expect(state.people.get('birth', state.people.slotOf(child.leader) ?? 0)).toBe(eldest);
  });

  it('ne sépare pas les frères et sœurs orphelins à la scission (F-9)', () => {
    const state = flatState('orphelins');
    const group = spawn(state, { x: 100, y: 100 }, 48);
    // Les parents des fratries d'au moins deux enfants meurent.
    const members = groupMembers(state.people).get(group.id) ?? [];
    const minor = (slot: number) =>
      state.people.age(slot, state.tick) < testHuman.maturity * MONTHS_PER_YEAR;
    const siblings = new Map<number, number[]>();
    for (const slot of members) {
      const mother = state.people.get('mother', slot);
      if (!minor(slot) || mother === NONE) continue;
      siblings.set(mother, [...(siblings.get(mother) ?? []), slot]);
    }
    const orphaned = [...siblings.values()].filter((children) => children.length >= 2);
    expect(orphaned.length).toBeGreaterThan(1);
    for (const children of orphaned) {
      const first = children[0] ?? 0;
      for (const link of ['mother', 'father'] as const) {
        const parent = state.people.slotOf(state.people.get(link, first));
        if (parent !== undefined) state.people.remove(parent, state.tick, 'accident');
      }
    }
    const left = groupMembers(state.people).get(group.id) ?? [];
    // Une fratrie orpheline forme un seul foyer, celui de sa mère disparue.
    const homes = households(state.people, left, state.tick, testData);
    for (const children of orphaned) {
      expect(homes.filter((home) => home.some((slot) => children.includes(slot)))).toHaveLength(1);
    }
    const child = splitGroup(state, group, left, testData, state.rng.stream('tests'));
    expect(child).toBeDefined();
    for (const children of orphaned) {
      const groups = new Set(children.map((slot) => state.people.get('group', slot)));
      expect(groups.size).toBe(1);
    }
  });

  it('pose l’aire du nouveau groupe sur une case franchissable de sa terre (F-7)', () => {
    // Le centre d'une aire sur une autre terre que la scission, une île en face, ne se
    // rejoint pas à pied : le nouveau groupe longerait la côte (3-nomades/P1).
    const { homesInWater, homesElsewhere, fallbacks, splits } = playCentury();
    expect(splits).toBeGreaterThan(30);
    expect(homesInWater).toBe(0);
    expect(homesElsewhere).toEqual([]);
    expect(fallbacks).toBe(0);
  });

  it('cherche l’aire du nouveau groupe dans une autre direction qu’une île en face', () => {
    // Une bande de terre en diagonale, du groupe vers le nord-ouest, dans la mer ; à l'est,
    // à une aire de distance, une île. Des huit centres possibles, seul celui du nord-ouest
    // est sur la terre de la scission ; celui de l'île, franchissable, ne se rejoint pas à
    // pied (3-nomades/P1). La direction tirée change d'une graine à l'autre.
    const band = (x: number, y: number) => x >= 88 && x <= 112 && x - y >= 8 && x - y <= 12;
    const island = (x: number, y: number) => Math.abs(x - 130) <= 3 && Math.abs(y - 100) <= 3;
    const homes = new Set<string>();
    for (let attempt = 0; attempt < 8; attempt++) {
      const state = flatState(
        `île ${String(attempt)}`,
        flooded((x, y) => !band(x, y) && !island(x, y)),
      );
      const { width } = state.size;
      const land = lands(state.cost, state.size);
      expect(land[100 * width + 130]).not.toBe(land[100 * width + 110]);
      const group = spawn(state, { x: 110, y: 100 }, 48);
      const members = groupMembers(state.people).get(group.id) ?? [];
      const child = splitGroup(state, group, members, testData, state.rng.stream('tests'));
      if (child === undefined) throw new Error('pas de scission');
      homes.add(`${String(child.homeX)},${String(child.homeY)}`);
    }
    expect([...homes]).toEqual(['90,80']);
  });

  it('ne fait marcher qu’une fois le nouveau groupe le mois de sa scission (F-5, D-8)', () => {
    // Une aire lointaine, que le nouveau groupe ne peut atteindre en un mois : il marche
    // tout son budget vers elle, une fois, et l'allure d'environ 30 cases de plaine par
    // mois se voit.
    const content: SimContent = { ...testData, nomads: { ...testData.nomads, range: 80 } };
    for (let attempt = 0; attempt < 6; attempt++) {
      const state = flatState(`une marche ${String(attempt)}`);
      spawn(state, { x: 200, y: 128 }, 48, 'plains', content);
      step(state, [], content);
      const split = state.society.chronicle.find((entry) => entry.kind === 'groupSplit');
      const child = state.society.groups.get(split?.other ?? NONE);
      if (split === undefined || child === undefined) throw new Error('pas de scission');
      const members = groupMembers(state.people).get(child.id) ?? [];
      const budget = walkBudget(state.people, members, split.tick, content);
      const covered = cellDistance(state.size.width, split.x, split.y, child.x, child.y);
      expect(covered).toBeLessThanOrEqual(budget + 1e-9);
      expect(covered).toBeGreaterThan(budget - 1.5);
      expect(budget).toBeGreaterThan(content.nomads.walk * 0.8 - 1e-9);
      // Sa destination reste le centre de sa nouvelle aire.
      expect({ x: child.targetX, y: child.targetY }).toEqual({ x: child.homeX, y: child.homeY });
    }
  });

  it('réunit un groupe trop petit à son voisin', () => {
    const state = testState();
    const at = cellOf(state, 'grassland');
    const big = spawn(state, at, 20);
    const small = spawn(state, at, 2);
    const merged = mergeGroup(state, small, groupMembers(state.people), testData);
    expect(merged?.id).toBe(big.id);
    expect(state.society.groups.has(small.id)).toBe(false);
    expect(groupMembers(state.people).get(big.id)?.length ?? 0).toBeGreaterThanOrEqual(21);
    // La sauvegarde ne garde que le groupe vivant, mais les deux cultures et les deux langues,
    // qui ne disparaissent jamais (ADR 0007).
    const { people } = saveState(state, GENERATOR_VERSION, testData).json as {
      people: Record<'groups' | 'cultures' | 'languages', unknown[]>;
    };
    expect([people.groups.length, people.cultures.length, people.languages.length]).toEqual([
      1, 2, 2,
    ]);
  });

  it('préfère, pour une réunion, un groupe de sa culture à un groupe étranger plus proche', () => {
    const state = flatState('réunion');
    const near = spawn(state, { x: 102, y: 100 }, 20);
    const kin = spawn(state, { x: 112, y: 100 }, 20);
    const small = spawn(state, { x: 100, y: 100 }, 2);
    Object.assign(small, { culture: kin.culture });
    expect(near.culture).not.toBe(small.culture);
    expect(mergeGroup(state, small, groupMembers(state.people), testData)?.id).toBe(kin.id);
    // Au-delà de la distance du mariage, le groupe de sa culture ne compte plus.
    const alone = spawn(state, { x: 100, y: 140 }, 2);
    const stranger = spawn(state, { x: 100, y: 150 }, 20);
    const far = spawn(state, { x: 100, y: 140 + testData.nomads.marriage + 15 }, 20);
    Object.assign(alone, { culture: far.culture });
    expect(mergeGroup(state, alone, groupMembers(state.people), testData)?.id).toBe(stranger.id);
  });

  it('marie des célibataires de deux groupes voisins de même culture', () => {
    // Sur la steppe, où les deux groupes restent à moins d'un mois de marche l'un de
    // l'autre : en terrain plus rude, ils cesseraient vite d'être voisins.
    const state = flatState('voisins');
    const at = { x: 100, y: 100 };
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
    expect(state.food.count).toBeGreaterThan(0);
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

describe('couture et pôles (monde cylindrique, F-11)', () => {
  it('marche à travers la couture est-ouest et le long des pôles', () => {
    const { size } = testState();
    const cost = plain(size);
    const { width, height } = size;
    // Vers l'ouest, par la couture : cinq cases.
    expect(walk(cost, size, { x: 2, y: 100 }, { x: width - 3, y: 100 }, 5)).toEqual({
      x: width - 3,
      y: 100,
    });
    expect(walk(cost, size, { x: width - 2, y: 7 }, { x: 3, y: 9 }, 30)).toEqual({ x: 3, y: 9 });
    // Le long des pôles, sans en sortir.
    expect(walk(cost, size, { x: 10, y: 3 }, { x: 20, y: 0 }, 30)).toEqual({ x: 20, y: 0 });
    expect(walk(cost, size, { x: 0, y: height - 1 }, { x: width - 6, y: height - 1 }, 30)).toEqual({
      x: width - 6,
      y: height - 1,
    });
  });

  it('cueille autour de lui à travers la couture, sans sortir du monde près du pôle', () => {
    const state = flatState('couture');
    const group = spawn(state, { x: 0, y: 1 }, 20);
    group.food = 0;
    const members = groupMembers(state.people).get(group.id) ?? [];
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
    // Toutes les cases du disque, et elles seules, sont entamées : celles d'au-delà de la
    // couture comprises, et aucune au-delà du pôle.
    const expected = disk(state.size, 0, 1, testData.nomads.forage.radius).sort((a, b) => a - b);
    expect(depletedCells(state.food)).toEqual(expected);
    expect(expected).toContain(state.size.width - 1);
    expect(expected.every((cell) => cell >= 0 && cell < state.size.width * 6)).toBe(true);
  });

  it('rapproche le centre de son aire par le plus court chemin, à travers la couture', () => {
    const state = flatState('aire');
    const { width } = state.size;
    const group = spawn(state, { x: 5, y: 100 }, 20);
    // Le groupe ne peut pas bouger : tout est infranchissable autour de lui.
    state.cost.fill(Number.POSITIVE_INFINITY);
    state.cost[100 * width + 5] = 1;
    Object.assign(group, { homeX: width - 15, homeY: 80 });
    const members = groupMembers(state.people).get(group.id) ?? [];
    moveGroup(state, group, members, testData, state.rng.stream('tests'));
    expect({ x: group.x, y: group.y }).toEqual({ x: 5, y: 100 });
    // Vingt cases vers l'est, par la couture, et vingt vers le sud : 5 % du chemin.
    expect({ x: group.homeX, y: group.homeY }).toEqual({ x: width - 14, y: 81 });
  });

  it('reste dans le monde, posé sur la couture ou au bord des pôles', () => {
    const state = flatState('bords');
    const { width, height } = state.size;
    for (const at of [
      { x: 0, y: 50 },
      { x: width - 1, y: 150 },
      { x: 200, y: 0 },
      { x: 300, y: height - 1 },
    ]) {
      spawn(state, at, 12);
    }
    for (let month = 0; month < 36; month++) {
      step(state, [], testData);
      for (const group of state.society.groups.values()) {
        for (const [value, limit] of [
          [group.x, width],
          [group.y, height],
          [group.homeX, width],
          [group.homeY, height],
        ] as const) {
          expect(Number.isInteger(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThan(limit);
        }
      }
    }
  });
});

describe('terres et voisinage, en temps de trajet (MON-16 ; C2, D13)', () => {
  it('relie les cases voisines par un côté, à travers la couture, mais ni par les pôles ni par un coin', () => {
    // Deux lignes d'eau d'un bord à l'autre, sous le pôle nord et au-dessus du pôle sud, et
    // une case isolée qui ne touche la terre que par un coin.
    const state = flatState(
      'terres',
      flooded(
        (x, y) =>
          y === 1 ||
          y === 254 ||
          (Math.abs(x - 50) <= 1 &&
            Math.abs(y - 50) <= 1 &&
            (x !== 50 || y !== 50) &&
            x + y !== 102),
      ),
    );
    const { width } = state.size;
    const at = (x: number, y: number) => state.land[y * width + x];
    // La ligne du pôle nord, celle du pôle sud et le reste du monde : trois terres, chacune
    // d'un seul tenant d'est en ouest, à travers la couture.
    expect(at(0, 0)).toBe(at(width - 1, 0));
    expect(at(0, 100)).toBe(at(width - 1, 100));
    expect(new Set([at(7, 0), at(7, 100), at(7, 255)]).size).toBe(3);
    expect(at(7, 1)).toBe(-1);
    // La case (50, 50) ne touche (51, 51) que par un coin : deux terres, et nulle marche.
    expect(at(50, 50)).not.toBe(at(51, 51));
    expect(walk(state.cost, state.size, { x: 50, y: 50 }, { x: 51, y: 51 }, 30)).toEqual({
      x: 50,
      y: 50,
    });
    expect(at(51, 51)).toBe(at(7, 100));
  });

  it('suit exactement ce que relie la marche, sur le monde des tests', async () => {
    const state = testState();
    const { width, height } = state.size;
    // Le calcul indépendant des tests, et ce que dit la marche, d'une case à l'autre.
    expect(state.land).toEqual(lands(state.cost, state.size));
    const random = state.rng.stream('tests');
    let walks = 0;
    while (walks < 3000) {
      const from = { x: random.nextInt(width), y: random.nextInt(height) };
      const here = state.land[from.y * width + from.x] ?? -1;
      if (here < 0) continue;
      const target = {
        x: (from.x + random.nextRange(-40, 41) + width) % width,
        y: Math.max(0, Math.min(height - 1, from.y + random.nextRange(-40, 41))),
      };
      const reached = walk(state.cost, state.size, from, target, 60);
      expect(state.land[reached.y * width + reached.x]).toBe(here);
      walks++;
    }
    // Elle ne se sauvegarde pas : la relecture la recalcule, la même.
    const restored = restoreState(
      await readSave(await writeSave(saveState(state, GENERATOR_VERSION, testData)), MIGRATIONS),
      testData,
    );
    expect(restored.land).toEqual(state.land);
    expect(terrainLands(state.cost, state.size)).toEqual(state.land);
  });

  it('compte en coût de marche, avec la couture et sans couper de coin (walkCosts)', () => {
    const { size } = testState();
    const { width } = size;
    const cell = (x: number, y: number) => y * width + x;
    const cost = plain(size);
    // En plaine : une case par pas droit, √2 par pas en diagonale, rien au-delà du budget.
    const costs = walkCosts(
      cost,
      size,
      { x: 100, y: 100 },
      [
        cell(100, 100),
        cell(110, 100),
        cell(110, 110),
        cell(130, 100),
        cell(131, 100),
        cell(125, 115),
      ],
      30,
    );
    expect([costs[0], costs[1], costs[3], costs[4], costs[5]]).toEqual([
      0,
      10,
      30,
      Infinity,
      Infinity,
    ]);
    expect(costs[2]).toBeCloseTo(10 * Math.SQRT2, 12);
    // À travers la couture, dans les deux sens.
    expect([...walkCosts(cost, size, { x: 2, y: 100 }, [cell(width - 3, 100)], 30)]).toEqual([5]);
    expect([...walkCosts(cost, size, { x: width - 3, y: 100 }, [cell(2, 100)], 30)]).toEqual([5]);
    // Le coût est celui des cases où l'on entre : une forêt tempérée compte une fois et demie.
    const forest = plain(size).fill(1.5);
    expect([
      ...walkCosts(forest, size, { x: 100, y: 100 }, [cell(120, 100), cell(121, 100)], 30),
    ]).toEqual([30, Infinity]);
    // Un mur d'eau : on passe par sa brèche, s'il en reste le temps, et tout droit, puisqu'on
    // n'y entre ni n'en sort par un coin : quatre diagonales et six pas droits de chaque
    // côté, et les deux pas de la brèche.
    const walled = plain(size);
    for (let y = 80; y <= 120; y++) walled[cell(105, y)] = Number.POSITIVE_INFINITY;
    walled[cell(105, 90)] = 1;
    const around = walkCosts(walled, size, { x: 100, y: 100 }, [cell(110, 100)], 30);
    expect(around[0]).toBeCloseTo(8 * Math.SQRT2 + 14, 9);
    walled[cell(105, 90)] = Number.POSITIVE_INFINITY;
    expect([...walkCosts(walled, size, { x: 100, y: 100 }, [cell(110, 100)], 30)]).toEqual([
      Infinity,
    ]);
    // Deux eaux qui se touchent par un coin ne se passent pas.
    const corner = plain(size);
    corner[cell(41, 40)] = Number.POSITIVE_INFINITY;
    corner[cell(40, 41)] = Number.POSITIVE_INFINITY;
    const diagonal = walkCosts(corner, size, { x: 40, y: 40 }, [cell(41, 41)], 30);
    expect(diagonal[0]).toBeGreaterThan(Math.SQRT2);
  });

  it('trouve le chemin le moins coûteux sur le monde des tests, couture et pôles compris', () => {
    // Des départs sur la terre, tirés au hasard, au bord de la couture, près des pôles ou
    // n'importe où, et des cibles autour : walkCosts redonne les coûts d'un calcul à part.
    const state = testState();
    const { width, height } = state.size;
    const random = state.rng.stream('tests');
    const budget = testData.nomads.marriage;
    const passable = (x: number, y: number) =>
      Number.isFinite(state.cost[y * width + x] ?? Infinity);
    const near = [
      (): [number, number] => [random.nextInt(4) - 2, random.nextInt(height)],
      (): [number, number] => [random.nextInt(width), random.nextInt(4)],
      (): [number, number] => [random.nextInt(width), height - 1 - random.nextInt(4)],
      (): [number, number] => [random.nextInt(width), random.nextInt(height)],
    ];
    let reached = 0;
    let tried = 0;
    for (let found = 0; found < 32; tried++) {
      const [dx, y] = near[found % near.length]?.() ?? [0, 0];
      const from = { x: (dx + width) % width, y };
      if (!passable(from.x, from.y)) continue;
      found++;
      const targets = Array.from({ length: 12 }, () => {
        const x = (from.x + random.nextRange(-20, 21) + width) % width;
        const ty = Math.max(0, Math.min(height - 1, from.y + random.nextRange(-20, 21)));
        return ty * width + x;
      });
      const costs = walkCosts(state.cost, state.size, from, targets, budget);
      const expected = referenceCosts(state.cost, state.size, from, targets, budget);
      expected.forEach((value, index) => {
        if (value === Infinity) expect(costs[index]).toBe(Infinity);
        else expect(costs[index]).toBeCloseTo(value, 9);
      });
      reached += expected.filter((value) => value < Infinity).length;
    }
    expect(tried).toBeLessThan(10_000);
    expect(reached).toBeGreaterThan(100);
  });

  it('ne réunit pas deux groupes que sépare un détroit, même tout proches (3-nomades/P0)', () => {
    // Deux bandes d'eau, du pôle nord au pôle sud, font deux terres sans lien, pas même
    // par la couture ; les deux groupes sont à vingt cases à vol d'oiseau.
    const state = flatState(
      'détroit',
      flooded((x) => (x >= 110 && x <= 115) || (x >= 300 && x <= 305)),
    );
    const { width } = state.size;
    const big = spawn(state, { x: 100, y: 100 }, 20);
    const small = spawn(state, { x: 120, y: 100 }, 3);
    expect(cellDistance(width, big.x, big.y, small.x, small.y)).toBeLessThan(
      testData.nomads.marriage,
    );
    expect(state.land[100 * width + 100]).not.toBe(state.land[100 * width + 120]);
    expect(mergeGroup(state, small, groupMembers(state.people), testData)).toBeUndefined();
    // Un mois : le petit groupe reste seul de son côté, avec ses membres.
    step(state, [], testData);
    expect(state.society.chronicle.filter((fact) => fact.kind === 'groupMerged')).toEqual([]);
    // Sans le détroit, ils se réunissent.
    const open = flatState('détroit');
    spawn(open, { x: 100, y: 100 }, 20);
    const alone = spawn(open, { x: 120, y: 100 }, 3);
    expect(mergeGroup(open, alone, groupMembers(open.people), testData)).toBeDefined();
  });

  it('ne réunit pas deux groupes au bord d’un même lac, à plus d’un mois de marche par le tour', () => {
    // Un lac de 22 cases de large et 121 de haut : une seule terre, et deux rives à 27 cases
    // l'une de l'autre, mais à bien plus d'un mois de marche en le contournant.
    const lake = (x: number, y: number) => x >= 103 && x <= 124 && y >= 40 && y <= 160;
    const state = flatState('lac', flooded(lake));
    const { width } = state.size;
    spawn(state, { x: 127, y: 100 }, 20);
    const small = spawn(state, { x: 100, y: 100 }, 3);
    expect(state.land[100 * width + 100]).toBe(state.land[100 * width + 127]);
    expect(cellDistance(width, 100, 100, 127, 100)).toBeLessThan(testData.nomads.marriage);
    expect([
      ...walkCosts(state.cost, state.size, small, [100 * width + 127], testData.nomads.marriage),
    ]).toEqual([Infinity]);
    expect(mergeGroup(state, small, groupMembers(state.people), testData)).toBeUndefined();
  });
});
