/**
 * Groupes nomades (tâche 2.5 ; CIV-05, MON-16 ; C2, D4 et D13 ; ADR 0011).
 *
 * - Déplacement : chaque mois, le groupe cherche, parmi quelques cases de son aire tirées
 *   au sort, celle où la nourriture abonde le plus, et s'y rend à pied. La marche dépense
 *   un budget d'environ 30 cases de plaine par mois (C2, D13), que l'endurance allonge ;
 *   chaque case coûte selon son biome et son étage d'altitude (C1, D11). L'eau, le lit
 *   des fleuves et les sommets ne se traversent pas à pied.
 * - Aire : le groupe s'écarte peu de son centre, qui le suit lentement : il nomadise au
 *   fil des saisons, et migre sur des générations.
 * - Scission : au-delà d'une trentaine de membres, le groupe se scinde en deux groupes de
 *   même culture (C2, D4) ; les familles restent ensemble, et le nouveau groupe part
 *   fonder son aire plus loin.
 */
import type { Biome, Catalog } from '../core/data';
import type { AltitudeLevel } from '../core/data/schemas';
import { altitudeLevelIndex } from '../core/altitude';
import type { RandomStream } from '../core/rng';
import type { WorldLayers, WorldSize } from '../core/world';
import { totalStock, type ForageContent } from './forage';
import { adaptationOf, MONTHS_PER_YEAR } from './people';
import { NONE, type Population } from './population';
import type { Group } from './society';
import type { SimState } from './state';

export interface GroupsContent extends ForageContent {
  readonly altitudeLevels: Catalog<AltitudeLevel>;
}

/** Candidats à la destination du mois, et rayon où on les tire. */
const CANDIDATES = 10;
const SEARCH = 10;
/** Une destination doit valoir au moins autant de plus que l'endroit où l'on est. */
const MARGIN = 1.15;
/** Part du chemin vers le groupe que le centre de son aire fait chaque mois. */
const HOME_DRIFT = 0.05;
/** Écart, en membres, autour du seuil de scission. */
const SPLIT_SPREAD = 4;

/** Membres de chaque groupe, dans l'ordre des emplacements. */
export function groupMembers(people: Population): Map<number, number[]> {
  const members = new Map<number, number[]>();
  people.forEach((slot) => {
    const group = people.get('group', slot);
    if (group === NONE) return;
    const list = members.get(group);
    if (list === undefined) members.set(group, [slot]);
    else list.push(slot);
  });
  return members;
}

const costs = new WeakMap<Catalog<Biome>, Float64Array>();

/** Coût de marche de chaque case du monde (voir walkCost). */
export function terrainCosts(
  world: WorldLayers,
  content: Pick<GroupsContent, 'biomes' | 'altitudeLevels'>,
): Float32Array<ArrayBuffer> {
  return Float32Array.from(world.biome, (_, cell) => walkCost(world, cell, content));
}

/** Coût de marche d'une case : son biome, fois son étage ; Infinity s'il est infranchissable. */
export function walkCost(
  world: WorldLayers,
  cell: number,
  content: Pick<GroupsContent, 'biomes' | 'altitudeLevels'>,
): number {
  let table = costs.get(content.biomes);
  if (table === undefined) {
    table = Float64Array.from(
      content.biomes.entries,
      (biome) => biome.movementCost ?? Number.POSITIVE_INFINITY,
    );
    costs.set(content.biomes, table);
  }
  const biome = table[world.biome[cell] ?? 0] ?? Number.POSITIVE_INFINITY;
  const levels = content.altitudeLevels.entries;
  const level = levels.at(altitudeLevelIndex(levels, world.elevation[cell] ?? 0));
  const movement = level?.movement ?? null;
  return movement === null ? Number.POSITIVE_INFINITY : biome * movement;
}

/** Distance entre deux cases, au plus court à travers la couture (CLAUDE.md). */
export function cellDistance(width: number, ax: number, ay: number, bx: number, by: number) {
  const raw = Math.abs(ax - bx);
  const dx = Math.min(raw, width - raw);
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Nourriture qu'on trouverait autour d'une case : quelques points de son voisinage. */
function prospect(state: SimState, content: GroupsContent, x: number, y: number): number {
  const { size } = state;
  let total = 0;
  for (const [dx, dy] of [
    [0, 0],
    [2, 1],
    [-2, -1],
  ] as const) {
    const row = y + dy;
    if (row < 0 || row >= size.height) continue;
    const cell = row * size.width + ((((x + dx) % size.width) + size.width) % size.width);
    total += totalStock(state.food, state.world, size, cell, state.tick, content);
  }
  return total;
}

/**
 * Marche vers (tx, ty) avec un budget de coût : à chaque pas, la case voisine franchissable
 * qui rapproche le plus du but, la moins coûteuse à égalité. Renvoie la case atteinte.
 */
export function walk(
  cost: Float32Array,
  size: WorldSize,
  from: { readonly x: number; readonly y: number },
  target: { readonly x: number; readonly y: number },
  budget: number,
): { x: number; y: number } {
  const { width, height } = size;
  let { x, y } = from;
  let left = budget;
  while (x !== target.x || y !== target.y) {
    const here = cellDistance(width, x, y, target.x, target.y);
    let bestX = -1;
    let bestY = -1;
    let bestDistance = here;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = (x + dx + width) % width;
        const step =
          (cost[ny * width + nx] ?? Number.POSITIVE_INFINITY) *
          (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1);
        if (!(step <= left)) continue;
        const distance = cellDistance(width, nx, ny, target.x, target.y);
        if (distance < bestDistance - 1e-9 || (distance < bestDistance + 1e-9 && step < bestCost)) {
          bestX = nx;
          bestY = ny;
          bestDistance = distance;
          bestCost = step;
        }
      }
    }
    // Plus de pas qui rapproche dans le budget : le groupe s'arrête là.
    if (bestX < 0 || bestDistance >= here) break;
    x = bestX;
    y = bestY;
    left -= bestCost;
  }
  return { x, y };
}

/** Une case de terre franchissable, tirée au hasard à moins de `radius` cases de (x, y). */
function randomCell(
  cost: Float32Array,
  size: WorldSize,
  x: number,
  y: number,
  radius: number,
  random: RandomStream,
): { x: number; y: number } | undefined {
  for (let attempt = 0; attempt < 8; attempt++) {
    const dx = random.nextRange(-radius, radius + 1);
    const dy = random.nextRange(-radius, radius + 1);
    const ny = y + dy;
    if (ny < 0 || ny >= size.height) continue;
    const nx = (((x + dx) % size.width) + size.width) % size.width;
    if (Number.isFinite(cost[ny * size.width + nx] ?? Number.POSITIVE_INFINITY)) {
      return { x: nx, y: ny };
    }
  }
  return undefined;
}

/** Endurance moyenne des adultes d'un groupe, de 0 à 1. */
function endurance(
  people: Population,
  members: readonly number[],
  tick: number,
  content: GroupsContent,
): number {
  let sum = 0;
  let count = 0;
  for (const slot of members) {
    const species = content.species.entries.at(people.get('species', slot));
    if (species === undefined || people.age(slot, tick) < species.maturity * MONTHS_PER_YEAR)
      continue;
    sum += adaptationOf(people, slot, species).endurance;
    count++;
  }
  return count === 0 ? 0.5 : sum / count;
}

/** Déplace un groupe pour le mois. */
export function moveGroup(
  state: SimState,
  group: Group,
  members: readonly number[],
  content: GroupsContent,
  random: RandomStream,
): void {
  const { nomads } = content;
  const { size, people, tick, cost } = state;
  const { width } = size;
  // Ce que vaut une case : sa nourriture, moins un malus hors de l'aire.
  const value = (x: number, y: number) => {
    const away = cellDistance(width, x, y, group.homeX, group.homeY) - nomads.range;
    return prospect(state, content, x, y) / (1 + Math.max(0, away) / nomads.range);
  };
  let best = { x: group.x, y: group.y };
  let bestValue = value(group.x, group.y) * MARGIN;
  for (let candidate = 0; candidate < CANDIDATES; candidate++) {
    const cell = randomCell(cost, size, group.x, group.y, SEARCH, random);
    if (cell === undefined) continue;
    const score = value(cell.x, cell.y);
    if (score > bestValue) {
      best = cell;
      bestValue = score;
    }
  }
  const budget = nomads.walk * (0.8 + 0.4 * endurance(people, members, tick, content));
  const reached = walk(cost, size, group, best, budget);
  group.x = reached.x;
  group.y = reached.y;
  group.targetX = best.x;
  group.targetY = best.y;
  // Le centre de l'aire suit lentement le groupe, au plus court à travers la couture.
  let dx = group.x - group.homeX;
  if (dx > width / 2) dx -= width;
  if (dx < -width / 2) dx += width;
  group.homeX = ((Math.round(group.homeX + dx * HOME_DRIFT) % width) + width) % width;
  group.homeY = Math.round(group.homeY + (group.y - group.homeY) * HOME_DRIFT);
}

/**
 * Foyers d'un groupe : un couple et ses enfants encore enfants, ou un adulte seul avec
 * les siens. Un enfant sans parent dans le groupe forme un foyer à lui seul.
 */
function households(
  people: Population,
  members: readonly number[],
  tick: number,
  content: GroupsContent,
): number[][] {
  const inGroup = new Set(members);
  const home = new Map<number, number[]>();
  const head = (slot: number): number => {
    const species = content.species.entries.at(people.get('species', slot));
    const child =
      species !== undefined && people.age(slot, tick) < species.maturity * MONTHS_PER_YEAR;
    if (child) {
      const mother = people.slotOf(people.get('mother', slot));
      if (mother !== undefined && inGroup.has(mother)) return head(mother);
      const father = people.slotOf(people.get('father', slot));
      if (father !== undefined && inGroup.has(father)) return head(father);
      return slot;
    }
    const partner = people.slotOf(people.get('partner', slot));
    return partner !== undefined && inGroup.has(partner) ? Math.min(slot, partner) : slot;
  };
  for (const slot of members) {
    const key = head(slot);
    const list = home.get(key);
    if (list === undefined) home.set(key, [slot]);
    else list.push(slot);
  }
  return [...home.values()];
}

/** Scinde un groupe trop grand ; renvoie le nouveau groupe, ou undefined. */
export function splitGroup(
  state: SimState,
  group: Group,
  members: readonly number[],
  content: GroupsContent,
  random: RandomStream,
): Group | undefined {
  const { society, people, size, tick, cost } = state;
  const threshold = content.nomads.split + random.nextRange(-SPLIT_SPREAD, SPLIT_SPREAD + 1);
  if (members.length <= threshold) return undefined;
  const homes = households(people, members, tick, content);
  if (homes.length < 2) return undefined;
  // Les foyers partent un sur deux, en ordre, jusqu'à la moitié des membres.
  const leaving: number[] = [];
  homes.forEach((home, index) => {
    if (index % 2 === 1 && leaving.length + home.length <= members.length / 2 + 2) {
      leaving.push(...home);
    }
  });
  if (leaving.length === 0 || leaving.length === members.length) return undefined;
  // Le nouveau groupe vise une aire voisine, à une aire de distance.
  const angle = random.nextFloat();
  const reach = content.nomads.range;
  const offsets = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
  ] as const;
  const [ox, oy] = offsets[Math.floor(angle * offsets.length) % offsets.length] ?? [1, 0];
  const homeY = Math.min(size.height - 1, Math.max(0, group.homeY + Math.round(oy * reach)));
  const homeX = (((group.homeX + Math.round(ox * reach)) % size.width) + size.width) % size.width;
  const share = leaving.length / members.length;
  const child: Group = {
    id: society.nextGroupId++,
    culture: group.culture,
    founded: tick,
    parent: group.id,
    x: group.x,
    y: group.y,
    homeX,
    homeY,
    targetX: -1,
    targetY: -1,
    food: group.food * share,
  };
  group.food -= child.food;
  society.groups.set(child.id, child);
  for (const slot of leaving) people.set('group', slot, child.id);
  society.chronicle.push({
    tick,
    kind: 'groupSplit',
    x: group.x,
    y: group.y,
    group: group.id,
    other: child.id,
    count: leaving.length,
  });
  // Le nouveau groupe se met en route aussitôt.
  const start = walk(cost, size, group, { x: homeX, y: homeY }, content.nomads.walk);
  child.x = start.x;
  child.y = start.y;
  return child;
}

/**
 * Un groupe tombé sous le seuil de data/nomads.json rejoint le groupe le plus proche, à la
 * distance du mariage au plus, de sa culture de préférence ; ses membres gardent la leur.
 * Le groupe qui l'accueille n'est pas lui-même sous le seuil : il ne partira pas à son
 * tour. Renvoie vrai si le groupe a disparu.
 */
export function mergeGroup(
  state: SimState,
  group: Group,
  membersOf: ReadonlyMap<number, readonly number[]>,
  content: GroupsContent,
): boolean {
  const { nomads } = content;
  const members = membersOf.get(group.id) ?? [];
  if (members.length === 0 || members.length >= nomads.merge) return false;
  const { society, people, size, tick } = state;
  let best: Group | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const other of society.groups.values()) {
    if (other.id === group.id || (membersOf.get(other.id)?.length ?? 0) < nomads.merge) continue;
    const distance = cellDistance(size.width, group.x, group.y, other.x, other.y);
    if (distance > nomads.marriage) continue;
    // Une culture étrangère compte comme une marche de plus.
    const score = distance + (other.culture === group.culture ? 0 : nomads.marriage);
    if (score < bestScore) {
      best = other;
      bestScore = score;
    }
  }
  if (best === undefined) return false;
  for (const slot of members) people.set('group', slot, best.id);
  best.food += group.food;
  society.groups.delete(group.id);
  society.chronicle.push({
    tick,
    kind: 'groupMerged',
    x: group.x,
    y: group.y,
    group: group.id,
    other: best.id,
    count: members.length,
  });
  return true;
}
