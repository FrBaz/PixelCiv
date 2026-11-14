/**
 * Groupes nomades (tâche 2.5 ; CIV-05, MON-16 ; C2, D4 et D13 ; ADR 0011).
 *
 * - Déplacement : chaque mois, le groupe cherche, parmi quelques cases tirées au sort
 *   autour de lui, celle où la nourriture abonde le plus, l'aire pénalisant celles qui
 *   s'en écartent, et s'y rend à pied. La marche dépense un budget d'environ 30 cases de
 *   plaine par mois (C2, D13), que l'endurance allonge ; chaque case coûte selon son
 *   biome et son étage d'altitude (C1, D11). L'eau, le lit des fleuves et les sommets ne
 *   se traversent pas à pied, pas même par un coin : un pas en diagonale n'enjambe pas
 *   une case infranchissable. Une marche ne change donc jamais de terre (`state.land`).
 * - Aire : le groupe s'écarte peu de son centre, qui le suit lentement : il nomadise au
 *   fil des saisons, et migre sur des générations.
 * - Scission : au-delà d'une trentaine de membres, le groupe se scinde en deux groupes de
 *   même culture (C2, D4) ; les familles restent ensemble, frères et sœurs orphelins
 *   compris, le meneur reste dans son groupe, et le nouveau groupe, mené par un autre,
 *   part fonder son aire plus loin, autour d'une case franchissable de sa terre.
 * - Voisinage : deux groupes sont voisins quand l'un atteint l'autre à pied en un mois de
 *   marche au plus, la distance du mariage, comptée en coût de marche comme le budget du
 *   mois, et non à vol d'oiseau (MON-16 ; C2, D13) : ils sont donc sur la même terre. Un
 *   groupe trop petit rejoint un voisin, et les célibataires se marient entre voisins
 *   (lifecycle.ts) ; ni les uns ni les autres ne passent l'eau.
 */
import type { Catalog, Species } from '../core/data';
import type { AltitudeLevel } from '../core/data/schemas';
import { deltaX, wrapNearX, wrapX } from '../core/cylinder';
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

/** Tas binaire de cases, par coût croissant : la file de walkCosts. */
class CostHeap {
  private costs = new Float64Array(256);
  private cells = new Int32Array(256);
  size = 0;

  push(cost: number, cell: number): void {
    if (this.size === this.costs.length) {
      const costs = new Float64Array(this.size * 2);
      const cells = new Int32Array(this.size * 2);
      costs.set(this.costs);
      cells.set(this.cells);
      this.costs = costs;
      this.cells = cells;
    }
    let index = this.size++;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      const above = this.costs[parent] ?? 0;
      if (above <= cost) break;
      this.costs[index] = above;
      this.cells[index] = this.cells[parent] ?? 0;
      index = parent;
    }
    this.costs[index] = cost;
    this.cells[index] = cell;
  }

  /** Coût de la case de tête, la moins coûteuse. */
  peek(): number {
    return this.costs[0];
  }

  /** Retire la case de tête et la renvoie. */
  pop(): number {
    const cell = this.cells[0];
    const size = --this.size;
    const cost = this.costs[size] ?? 0;
    const last = this.cells[size] ?? 0;
    let index = 0;
    for (;;) {
      let child = 2 * index + 1;
      if (child >= size) break;
      if (child + 1 < size && (this.costs[child + 1] ?? 0) < (this.costs[child] ?? 0)) child++;
      const below = this.costs[child] ?? 0;
      if (below >= cost) break;
      this.costs[index] = below;
      this.cells[index] = this.cells[child] ?? 0;
      index = child;
    }
    this.costs[index] = cost;
    this.cells[index] = last;
    return cell;
  }
}

/** File et tampons de walkCosts, repris d'une recherche à l'autre : ils ne gardent rien. */
const heap = new CostHeap();
let windowCost = new Float64Array(0);
let windowSpent = new Float64Array(0);
let windowFlags = new Uint8Array(0);
let windowColumns = new Int32Array(0);
const SETTLED = 1;
const WANTED = 2;

/**
 * Plus petit coût de marche de `from` à chacune des cases `targets` (des indices de cases),
 * au plus `budget`, Infinity au-delà : Dijkstra sur les cases franchissables, en huit
 * directions, avec la règle du coin et la couture de walk, chaque pas coûtant comme dans
 * walk, la case où l'on entre, fois √2 en diagonale. La recherche s'arrête dès que toutes
 * les cibles sont atteintes, ou le budget épuisé.
 *
 * Le coût d'une case vaut au moins 1 : la recherche se tient dans le carré de 2 ⌊budget⌋ + 1
 * cases de côté centré sur `from`. On y recopie les coûts, bordés d'une rangée de cases
 * infranchissables, au-delà du carré comme au-delà des pôles ; ses colonnes bouclent, et
 * s'il est plus large que le monde, il en montre une colonne plusieurs fois : une cible
 * compte alors par la plus proche de ses copies.
 */
export function walkCosts(
  cost: Float32Array,
  size: WorldSize,
  from: { readonly x: number; readonly y: number },
  targets: readonly number[],
  budget: number,
): Float64Array {
  const { width, height } = size;
  const found = new Float64Array(targets.length).fill(Number.POSITIVE_INFINITY);
  const radius = Math.floor(budget);
  if (!(radius >= 0) || targets.length === 0) return found;
  const span = 2 * radius + 1;
  const left = from.x - radius;
  const top = Math.max(0, from.y - radius);
  const rows = Math.min(height - 1, from.y + radius) - top + 1;
  if (rows <= 0) return found;
  const stride = span + 2;
  const cells = stride * (rows + 2);
  if (windowCost.length < cells) {
    windowCost = new Float64Array(cells);
    windowSpent = new Float64Array(cells);
    windowFlags = new Uint8Array(cells);
  }
  if (windowColumns.length < span) windowColumns = new Int32Array(span);
  const local = windowCost;
  const spent = windowSpent;
  const flags = windowFlags;
  const columns = windowColumns;
  local.fill(Number.POSITIVE_INFINITY, 0, cells);
  spent.fill(Number.POSITIVE_INFINITY, 0, cells);
  flags.fill(0, 0, cells);
  for (let column = 0; column < span; column++) columns[column] = wrapX(left + column, width);
  for (let row = 0; row < rows; row++) {
    const world = (top + row) * width;
    const base = (row + 1) * stride + 1;
    for (let column = 0; column < span; column++) {
      local[base + column] = cost[world + (columns[column] ?? 0)] ?? Number.POSITIVE_INFINITY;
    }
  }
  /** Les copies de la case (x, y) dans le carré. */
  const copiesOf = (x: number, y: number): number[] => {
    const row = y - top;
    const copies: number[] = [];
    if (row < 0 || row >= rows) return copies;
    for (let column = wrapX(x - left, width); column < span; column += width) {
      copies.push((row + 1) * stride + 1 + column);
    }
    return copies;
  };
  let wanted = 0;
  for (const target of targets) {
    for (const at of copiesOf(target % width, Math.floor(target / width))) {
      if ((flags[at] ?? 0) & WANTED || !((local[at] ?? Infinity) < Infinity)) continue;
      flags[at] = WANTED;
      wanted++;
    }
  }
  const start = (from.y - top + 1) * stride + 1 + radius;
  if (!((local[start] ?? Infinity) < Infinity)) return found;
  // Les huit pas, et pour chaque diagonale, les deux cases qu'elle enjambe.
  const steps = [-stride - 1, -stride, 1 - stride, -1, 1, stride - 1, stride, stride + 1];
  const besideX = [-1, 0, 1, 0, 0, -1, 0, 1];
  const besideY = [-stride, 0, -stride, 0, 0, stride, 0, stride];
  heap.size = 0;
  spent[start] = 0;
  heap.push(0, start);
  while (heap.size > 0 && wanted > 0) {
    const used = heap.peek();
    const at = heap.pop();
    // Une case revient au tas chaque fois qu'on la rejoint moins cher : seule la première
    // sortie compte.
    if ((flags[at] ?? 0) & SETTLED) continue;
    flags[at] = (flags[at] ?? 0) | SETTLED;
    if ((flags[at] ?? 0) & WANTED) wanted--;
    for (let direction = 0; direction < 8; direction++) {
      const next = at + (steps[direction] ?? 0);
      const enter = local[next] ?? Infinity;
      if (!(enter < Infinity)) continue;
      const dx = besideX[direction] ?? 0;
      let total = used + enter;
      if (dx !== 0) {
        // Pas de coin coupé, comme dans walk.
        const dy = besideY[direction] ?? 0;
        if (
          !((local[at + dx] ?? Infinity) < Infinity) ||
          !((local[at + dy] ?? Infinity) < Infinity)
        ) {
          continue;
        }
        total = used + enter * Math.SQRT2;
      }
      if (!(total <= budget) || !(total < (spent[next] ?? 0))) continue;
      spent[next] = total;
      heap.push(total, next);
    }
  }
  targets.forEach((target, index) => {
    for (const at of copiesOf(target % width, Math.floor(target / width))) {
      if ((flags[at] ?? 0) & SETTLED)
        found[index] = Math.min(found[index] ?? Infinity, spent[at] ?? Infinity);
    }
  });
  return found;
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
  // tirée ou, si son centre y tombe sur une case infranchissable ou sur une autre terre
  // que celle de la scission, que nul ne rejoint à pied, la suivante ; faute de mieux, il
  // garde l'aire du groupe d'origine.
  const angle = random.nextFloat();
  const reach = content.nomads.range;
  const first = Math.floor(angle * SPLIT_DIRECTIONS.length) % SPLIT_DIRECTIONS.length;
  const land = state.land[group.y * size.width + group.x] ?? -1;
  let homeX = group.homeX;
  let homeY = group.homeY;
  for (let turn = 0; turn < SPLIT_DIRECTIONS.length; turn++) {
    const [ox, oy] = SPLIT_DIRECTIONS[(first + turn) % SPLIT_DIRECTIONS.length] ?? [1, 0];
    const y = Math.min(size.height - 1, Math.max(0, group.homeY + Math.round(oy * reach)));
    const x = (((group.homeX + Math.round(ox * reach)) % size.width) + size.width) % size.width;
    if (land >= 0 && state.land[y * size.width + x] === land) {
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
 * Voisinage des groupes le temps d'un mois (MON-16 ; C2, D13) : un groupe est voisin d'un
 * autre s'il l'atteint à pied dans la distance du mariage (nomads.marriage), comptée en
 * coût de marche comme nomads.walk, soit un mois de marche ; il est donc sur sa terre. Les
 * réunions et les mariages entre groupes s'en tiennent à ce voisinage.
 *
 * Les groupes ne bougent qu'à la fin du mois (step) : la recherche (walkCosts) se fait au
 * plus une fois par groupe et par mois, à la première question, vers les groupes de sa
 * terre qui sont, à vol d'oiseau, à la distance du mariage ; elle n'a pas lieu tant qu'on
 * ne demande pas un tel groupe. Le coût d'une case vaut au moins 1 (data/biomes.json,
 * data/altitude-levels.json) : on n'atteint jamais à pied plus loin qu'à vol d'oiseau.
 */
export class Neighborhood {
  private readonly state: SimState;
  private readonly reach: number;
  /** Pour chaque groupe qui a cherché : le coût de marche vers chaque groupe atteint. */
  private readonly found = new Map<number, ReadonlyMap<number, number>>();
  /** Les groupes, rangés en carrés d'au moins `reach` cases de côté, au premier besoin. */
  private squares: Map<number, Group[]> | undefined;
  private readonly across: number;
  private readonly down: number;

  constructor(state: SimState, reach: number) {
    this.state = state;
    this.reach = reach;
    const { width, height } = state.size;
    this.across = Math.max(1, Math.floor(width / Math.max(1, reach)));
    this.down = Math.max(1, Math.floor(height / Math.max(1, reach)));
  }

  /** Coût de marche de `home` à `other`, s'il en est voisin ; Infinity sinon. */
  cost(home: Group, other: Group): number {
    if (other.id === home.id || !this.candidate(home, other)) return Number.POSITIVE_INFINITY;
    return this.search(home).get(other.id) ?? Number.POSITIVE_INFINITY;
  }

  /** `other` est-il sur la terre de `home`, à vol d'oiseau à la distance du mariage ? */
  private candidate(home: Group, other: Group): boolean {
    const { size, land } = this.state;
    if (cellDistance(size.width, home.x, home.y, other.x, other.y) > this.reach) return false;
    const here = land[home.y * size.width + home.x] ?? -1;
    return here >= 0 && land[other.y * size.width + other.x] === here;
  }

  private square(group: Group): number {
    const { width, height } = this.state.size;
    const row = Math.floor((group.y * this.down) / height);
    return row * this.across + Math.floor((group.x * this.across) / width);
  }

  /** Groupes atteints à pied depuis `home`, avec leur coût, cherchés une fois. */
  private search(home: Group): ReadonlyMap<number, number> {
    const known = this.found.get(home.id);
    if (known !== undefined) return known;
    const { state, across, down } = this;
    if (this.squares === undefined) {
      this.squares = new Map();
      for (const group of state.society.groups.values()) {
        const list = this.squares.get(this.square(group));
        if (list === undefined) this.squares.set(this.square(group), [group]);
        else list.push(group);
      }
    }
    // Un groupe à la distance du mariage est dans le carré de `home` ou l'un des huit
    // autour, la dernière colonne touchant la première (couture).
    const targets: Group[] = [];
    const at = this.square(home);
    const row = Math.floor(at / across);
    const column = at - row * across;
    const columns = new Set([column - 1, column, column + 1].map((c) => (c + across) % across));
    for (let r = Math.max(0, row - 1); r <= Math.min(down - 1, row + 1); r++) {
      for (const c of columns) {
        for (const other of this.squares.get(r * across + c) ?? []) {
          if (other.id !== home.id && this.candidate(home, other)) targets.push(other);
        }
      }
    }
    const { width } = state.size;
    const costs = walkCosts(
      state.cost,
      state.size,
      home,
      targets.map((other) => other.y * width + other.x),
      this.reach,
    );
    const reached = new Map<number, number>();
    targets.forEach((other, index) => {
      const spent = costs[index] ?? Number.POSITIVE_INFINITY;
      if (spent <= this.reach) reached.set(other.id, spent);
    });
    this.found.set(home.id, reached);
    return reached;
  }
}

/**
 * Un groupe tombé sous le seuil de data/nomads.json rejoint le groupe voisin le plus proche
 * (Neighborhood), en coût de marche, de sa culture de préférence ; ses membres gardent la
 * leur. Le groupe qui l'accueille n'est pas lui-même sous le seuil : il ne partira pas à
 * son tour. Renvoie le groupe qui l'a accueilli, ou undefined s'il reste seul.
 */
export function mergeGroup(
  state: SimState,
  group: Group,
  membersOf: ReadonlyMap<number, readonly number[]>,
  content: GroupsContent,
  neighbors = new Neighborhood(state, content.nomads.marriage),
): Group | undefined {
  const { nomads } = content;
  const members = membersOf.get(group.id) ?? [];
  if (members.length === 0 || members.length >= nomads.merge) return undefined;
  const { society, people, tick } = state;
  let best: Group | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const other of society.groups.values()) {
    if (other.id === group.id || (membersOf.get(other.id)?.length ?? 0) < nomads.merge) continue;
    const distance = neighbors.cost(group, other);
    if (!(distance <= nomads.marriage)) continue;
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
