/**
 * Groupes nomades (tâche 2.5 ; CIV-05, MON-16 ; C2, D4 et D13 ; ADR 0011).
 *
 * - Déplacement : chaque mois, le groupe cherche, parmi quelques cases tirées au sort
 *   autour de lui, celle où la nourriture abonde le plus, l'aire pénalisant celles qui
 *   s'en écartent, et s'y rend à pied. La marche dépense un budget d'environ 30 cases de
 *   plaine par mois (C2, D13), que l'endurance allonge ; chaque case coûte selon son
 *   biome et son étage d'altitude (C1, D11). L'eau, le lit des fleuves et les sommets ne
 *   se traversent pas à pied, pas même par un coin : un pas en diagonale n'enjambe pas
 *   une case infranchissable.
 * - Aire : le groupe s'écarte peu de son centre, qui le suit lentement : il nomadise au
 *   fil des saisons, et migre sur des générations.
 * - Scission : au-delà d'une trentaine de membres, le groupe se scinde en deux groupes de
 *   même culture (C2, D4) ; les familles restent ensemble, frères et sœurs orphelins
 *   compris, le meneur reste dans son groupe, et le nouveau groupe, mené par un autre,
 *   part fonder son aire plus loin, autour d'une case franchissable.
 */
import type { Catalog, Species } from '../core/data';
import type { AltitudeLevel } from '../core/data/schemas';
import { deltaX, wrapNearX } from '../core/cylinder';
import type { RandomStream } from '../core/rng';
import type { WorldSize } from '../core/world';
import { totalStock, type ForageContent } from './forage';
import { MONTHS_PER_YEAR } from './people';
import { ANCESTRY_SLOTS, ANCESTRY_TOTAL, NONE, type Population } from './population';
import type { Group } from './society';
import type { SimState } from './state';

export interface GroupsContent extends ForageContent {
  readonly altitudeLevels: Catalog<AltitudeLevel>;
}

/** Candidats à la destination du mois, et rayon où on les tire, autour du groupe. */
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
  const { alive, end } = people;
  const groups = people.columns.group;
  for (let slot = 0; slot < end; slot++) {
    if (alive[slot] !== 1) continue;
    const group = groups[slot] ?? NONE;
    if (group === NONE) continue;
    const list = members.get(group);
    if (list === undefined) members.set(group, [slot]);
    else list.push(slot);
  }
  return members;
}

/**
 * Distance entre deux cases, au plus court à travers la couture (CLAUDE.md), quelles que
 * soient leurs colonnes : deltaX les ramène d'abord dans le monde.
 */
export function cellDistance(width: number, ax: number, ay: number, bx: number, by: number) {
  const dx = deltaX(ax, bx, width);
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Points du voisinage d'une case qu'on regarde pour juger de sa nourriture : (dx, dy). */
const PROSPECT = [0, 0, 2, 1, -2, -1] as const;

/** Nourriture qu'on trouverait autour d'une case : quelques points de son voisinage. */
function prospect(state: SimState, content: GroupsContent, x: number, y: number): number {
  const { size } = state;
  let total = 0;
  for (let index = 0; index < PROSPECT.length; index += 2) {
    const row = y + (PROSPECT[index + 1] ?? 0);
    if (row < 0 || row >= size.height) continue;
    const column = wrapNearX(x + (PROSPECT[index] ?? 0), size.width);
    total += totalStock(
      state.food,
      state.world,
      size,
      row * size.width + column,
      state.tick,
      content,
    );
  }
  return total;
}

/**
 * Marche vers (tx, ty) avec un budget de coût : à chaque pas, la case voisine franchissable
 * qui rapproche le plus du but, la moins coûteuse à égalité. Un pas en diagonale demande
 * que les deux cases qu'il enjambe soient franchissables : les eaux se touchent par les
 * coins (elles se rangent en 8-connexité), et on ne passe pas entre deux d'entre elles.
 * Renvoie la case atteinte.
 */
export function walk(
  cost: Float32Array,
  size: WorldSize,
  from: { readonly x: number; readonly y: number },
  target: { readonly x: number; readonly y: number },
  budget: number,
): { x: number; y: number } {
  const { width, height } = size;
  const blocked = (cell: number) => !Number.isFinite(cost[cell] ?? Number.POSITIVE_INFINITY);
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
        const nx = wrapNearX(x + dx, width);
        const diagonal = dx !== 0 && dy !== 0;
        // Pas de coin coupé : les deux cases qu'enjambe un pas en diagonale se franchissent.
        if (diagonal && (blocked(y * width + nx) || blocked(ny * width + x))) continue;
        const step =
          (cost[ny * width + nx] ?? Number.POSITIVE_INFINITY) * (diagonal ? Math.SQRT2 : 1);
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
    const nx = wrapNearX(x + dx, size.width);
    if (Number.isFinite(cost[ny * size.width + nx] ?? Number.POSITIVE_INFINITY)) {
      return { x: nx, y: ny };
    }
  }
  return undefined;
}

/** Endurance de chaque sous-espèce d'une espèce, dans l'ordre de l'ascendance. */
const enduranceTables = new WeakMap<Species, Float64Array>();

function endurances(species: Species): Float64Array {
  let table = enduranceTables.get(species);
  if (table === undefined) {
    const count = Math.min(ANCESTRY_SLOTS, species.subspecies.length);
    table = Float64Array.from(
      species.subspecies.slice(0, count),
      (entry) => entry.adaptation.endurance,
    );
    enduranceTables.set(species, table);
  }
  return table;
}

/** Endurance moyenne des adultes, de 0 à 1, parmi les emplacements `members`. */
function endurance(
  people: Population,
  members: readonly number[],
  tick: number,
  content: GroupsContent,
): number {
  let sum = 0;
  let count = 0;
  const { birth, species: kinds, ancestry } = people.columns;
  const entries = content.species.entries;
  for (const slot of members) {
    const species = entries.at(kinds[slot] ?? 0);
    if (species === undefined || tick - (birth[slot] ?? 0) < species.maturity * MONTHS_PER_YEAR) {
      continue;
    }
    // Endurance de l'ascendance (voir adaptationOf), sans objet par membre.
    const table = endurances(species);
    let endurance = 0;
    for (let index = 0; index < table.length; index++) {
      const share = (ancestry[slot * ANCESTRY_SLOTS + index] ?? 0) / ANCESTRY_TOTAL;
      if (share === 0) continue;
      endurance += share * (table[index] ?? 0);
    }
    sum += endurance;
    count++;
  }
  return count === 0 ? 0.5 : sum / count;
}

/**
 * Budget de marche d'un mois, en coût : environ 30 cases de plaine (C2, D13), de 0,8 à
 * 1,2 fois selon l'endurance moyenne des adultes `members`.
 */
export function walkBudget(
  people: Population,
  members: readonly number[],
  tick: number,
  content: GroupsContent,
): number {
  return content.nomads.walk * (0.8 + 0.4 * endurance(people, members, tick, content));
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
  const reached = walk(cost, size, group, best, walkBudget(people, members, tick, content));
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
 * les siens. Les enfants sans parent dans le groupe forment avec leurs frères et sœurs un
 * foyer, celui de leur mère, ou de leur père sans mère connue, même morts ou partis ; un
 * enfant dont on ne connaît aucun parent forme un foyer à lui seul.
 */
export function households(
  people: Population,
  members: readonly number[],
  tick: number,
  content: GroupsContent,
): number[][] {
  const inGroup = new Set(members);
  // Clés : l'emplacement du chef de foyer, ou, pour une fratrie orpheline, -1 - l'identifiant
  // de sa mère (de son père) : une mère et un père sont deux personnes différentes.
  const home = new Map<number, number[]>();
  const head = (slot: number): number => {
    const species = content.species.entries.at(people.get('species', slot));
    const child =
      species !== undefined && people.age(slot, tick) < species.maturity * MONTHS_PER_YEAR;
    if (child) {
      const motherId = people.get('mother', slot);
      const fatherId = people.get('father', slot);
      const mother = people.slotOf(motherId);
      if (mother !== undefined && inGroup.has(mother)) return head(mother);
      const father = people.slotOf(fatherId);
      if (father !== undefined && inGroup.has(father)) return head(father);
      if (motherId !== NONE) return -1 - motherId;
      if (fatherId !== NONE) return -1 - fatherId;
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

/** Directions où le nouveau groupe d'une scission cherche son aire, dans l'ordre du tirage. */
const SPLIT_DIRECTIONS = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
] as const;

/**
 * Scinde un groupe trop grand ; renvoie le nouveau groupe, ou undefined. Le foyer du
 * meneur reste ; le nouveau groupe a pour meneur l'aîné de ceux qui partent, hors de qui
 * mène déjà un groupe vivant (un meneur parti rejoindre son conjoint, par exemple) : deux
 * groupes vivants n'ont jamais le même meneur.
 */
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
  // Les foyers partent un sur deux, en ordre, jusqu'à la moitié des membres ; celui du
  // meneur reste.
  const leader = people.slotOf(group.leader);
  const leaving: number[] = [];
  homes.forEach((home, index) => {
    if (leader !== undefined && home.includes(leader)) return;
    if (index % 2 === 1 && leaving.length + home.length <= members.length / 2 + 2) {
      leaving.push(...home);
    }
  });
  if (leaving.length === 0 || leaving.length === members.length) return undefined;
  // Le meneur du nouveau groupe : l'aîné de ceux qui partent, qui ne mène aucun groupe.
  const leaders = new Set<number>();
  for (const other of society.groups.values()) leaders.add(other.leader);
  let eldest = -1;
  for (const slot of leaving) {
    if (leaders.has(people.get('id', slot))) continue;
    if (eldest < 0 || people.get('birth', slot) < people.get('birth', eldest)) eldest = slot;
  }
  if (eldest < 0) return undefined;
  // Le nouveau groupe vise une aire voisine, à une aire de distance, dans la direction
  // tirée ou, si son centre y tombe sur une case infranchissable, la suivante ; faute de
  // mieux, il garde l'aire du groupe d'origine.
  const angle = random.nextFloat();
  const reach = content.nomads.range;
  const first = Math.floor(angle * SPLIT_DIRECTIONS.length) % SPLIT_DIRECTIONS.length;
  let homeX = group.homeX;
  let homeY = group.homeY;
  for (let turn = 0; turn < SPLIT_DIRECTIONS.length; turn++) {
    const [ox, oy] = SPLIT_DIRECTIONS[(first + turn) % SPLIT_DIRECTIONS.length] ?? [1, 0];
    const y = Math.min(size.height - 1, Math.max(0, group.homeY + Math.round(oy * reach)));
    const x = (((group.homeX + Math.round(ox * reach)) % size.width) + size.width) % size.width;
    if (Number.isFinite(cost[y * size.width + x] ?? Number.POSITIVE_INFINITY)) {
      homeX = x;
      homeY = y;
      break;
    }
  }
  const share = leaving.length / members.length;
  const child: Group = {
    id: society.nextGroupId++,
    culture: group.culture,
    founded: tick,
    parent: group.id,
    leader: people.get('id', eldest),
    x: group.x,
    y: group.y,
    homeX,
    homeY,
    targetX: homeX,
    targetY: homeY,
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
    leader: group.leader,
    otherLeader: child.leader,
    count: leaving.length,
  });
  // Le nouveau groupe se met en route aussitôt : c'est sa marche du mois (step ne le
  // déplace plus), avec le budget de ses adultes.
  const start = walk(
    cost,
    size,
    group,
    { x: homeX, y: homeY },
    walkBudget(people, leaving, tick, content),
  );
  child.x = start.x;
  child.y = start.y;
  return child;
}

/**
 * Un groupe tombé sous le seuil de data/nomads.json rejoint le groupe le plus proche, à la
 * distance du mariage au plus, de sa culture de préférence ; ses membres gardent la leur.
 * Le groupe qui l'accueille n'est pas lui-même sous le seuil : il ne partira pas à son
 * tour. Renvoie le groupe qui l'a accueilli, ou undefined s'il reste seul.
 */
export function mergeGroup(
  state: SimState,
  group: Group,
  membersOf: ReadonlyMap<number, readonly number[]>,
  content: GroupsContent,
): Group | undefined {
  const { nomads } = content;
  const members = membersOf.get(group.id) ?? [];
  if (members.length === 0 || members.length >= nomads.merge) return undefined;
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
  if (best === undefined) return undefined;
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
    leader: group.leader,
    otherLeader: best.leader,
    count: members.length,
  });
  return best;
}
