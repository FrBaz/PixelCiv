/**
 * Mouvement des individus (tâche 2b.3, ADR 0014) : chacun a sa position, une variable de la
 * simulation, et s'y déplace pour son compte. Un groupe nomade n'a pas de marche : son guide
 * choisit un camp, et chacun s'y rend à pied, à son jour, à son allure et par son chemin,
 * puis s'y pose à sa place, près de l'ancre de son foyer.
 *
 * - État (colonnes des vivants, population.ts) : position, intention, jour du départ, place
 *   visée, étape en cours. Sauvegarde et empreinte le comptent.
 * - Caches (Movement) : marcheurs, départs par jour, grille des places tenues (repos,
 *   partance, places visées), grille des marcheurs, portés de chaque mère, guide et taille de
 *   chaque groupe, champs de distances des camps. Ils se déduisent de l'état
 *   (rebuildMovement), au chargement, après chaque pas mensuel et après les commandes ; entre
 *   deux, le sous-pas les tient à jour, et ce qu'il en tire ne dépend pas de leur ordre.
 *
 * Tout se calcule en entiers (core/position.ts) et en flottants, par les seules quatre
 * opérations, la racine carrée et les arrondis : aucune trigonométrie, aucun Math.hypot. Les
 * tirages (places et jours de départ) se font sur le flux `sim.camp`, dans un ordre canonique.
 */
import { freshArrays, type Allocator } from '../core/buffers';
import type { Species } from '../core/data';
import { geneRoles } from '../core/data/people';
import type { LegArrays } from '../core/protocol';
import { carriedSide, cellOf, deltaFixedX, FIXED, wrapFixedX } from '../core/position';
import type { RandomStream } from '../core/rng';
import { dayIndex, DAYS_PER_MONTH } from '../core/time';
import { trait } from './genetics';
import { MONTHS_PER_YEAR } from './people';
import {
  ANCESTRY_SLOTS,
  ANCESTRY_TOTAL,
  CARRIED,
  DETOUR,
  GENOME_WORDS,
  INTENTION,
  JOIN,
  LATE,
  LEAVE,
  NEVER,
  NONE,
  PLACE,
  REST,
  RETRY,
  SETTLE,
  WALK,
  type Population,
} from './population';
import type { Group } from './society';
import type { SimState } from './state';
import type { SimContent } from './step';

/** Tolérance de l'arrivée, sur chaque axe, en unités : 1/128 de case. */
const ARRIVE = FIXED / 128;
/** Marge, en unités, qu'une étape garde avant le bord d'une case qu'elle ne peut franchir. */
const EDGE_MARGIN = FIXED / 16;
/** Jours d'une étape, au plus (la sauvegarde en refuse davantage). */
export const MAX_LEG_DAYS = 1000;
/** Pas d'un jour, au plus, sur chaque axe : quatre cases. */
export const MAX_STEP = 4 * FIXED;
/** Un segment qui passe à moins de 2^-16 case d'un coin le franchit en diagonale. */
const CORNER = 1 / FIXED;
/** Ancre d'un guide : le centre du camp. */
const CAMP = -2;
/** Aucun emplacement. */
const NO = -1;
/** Entiers par emplacement dans Movement.rest. */
const REST_STRIDE = 4;
/**
 * Tirages d'une place : six dans son rayon, puis six dans un rayon 1,6 fois plus grand, puis
 * quatre dans un rayon 2,5 fois plus grand.
 */
const PLACE_REACHES = [1, 1, 1, 1, 1, 1, 1.6, 1.6, 1.6, 1.6, 1.6, 1.6, 2.5, 2.5, 2.5, 2.5] as const;

/** Tableau d'entiers agrandi à `length` au moins, contenu gardé, reste rempli de `fill`. */
function grownInt32(
  array: Int32Array<ArrayBuffer>,
  length: number,
  fill: number,
): Int32Array<ArrayBuffer> {
  if (array.length >= length) return array;
  const next = new Int32Array(Math.max(length, array.length * 2)).fill(fill);
  next.set(array);
  return next;
}

/**
 * Étapes commencées, dans l'ordre où elles commencent : le worker les envoie au rendu avec
 * chaque lot de jours (protocole 6). Ce n'est pas l'état : sans hôte, il n'y en a pas.
 */
export class LegJournal {
  count = 0;
  private slots = new Uint32Array(256);
  private days = new Uint32Array(256);
  private start = new Int32Array(512);
  private step = new Int32Array(512);
  private lengths = new Uint16Array(256);

  push(
    slot: number,
    day: number,
    x: number,
    y: number,
    sx: number,
    sy: number,
    days: number,
  ): void {
    if (this.count === this.slots.length) this.grow();
    const at = this.count++;
    this.slots[at] = slot;
    this.days[at] = day;
    this.start[2 * at] = x;
    this.start[2 * at + 1] = y;
    this.step[2 * at] = sx;
    this.step[2 * at + 1] = sy;
    this.lengths[at] = days;
  }

  /** Les étapes notées, dans des tableaux au plus juste, pris de `arrays` ; le journal se vide. */
  take(arrays: Allocator = freshArrays): LegArrays {
    const n = this.count;
    this.count = 0;
    const legs: LegArrays = {
      slots: arrays.uint32(n),
      days: arrays.uint32(n),
      start: arrays.int32(2 * n),
      step: arrays.int32(2 * n),
      count: arrays.uint16(n),
    };
    legs.slots.set(this.slots.subarray(0, n));
    legs.days.set(this.days.subarray(0, n));
    legs.start.set(this.start.subarray(0, 2 * n));
    legs.step.set(this.step.subarray(0, 2 * n));
    legs.count.set(this.lengths.subarray(0, n));
    return legs;
  }

  private grow(): void {
    const size = this.slots.length * 2;
    const slots = new Uint32Array(size);
    const days = new Uint32Array(size);
    const start = new Int32Array(2 * size);
    const step = new Int32Array(2 * size);
    const lengths = new Uint16Array(size);
    slots.set(this.slots);
    days.set(this.days);
    start.set(this.start);
    step.set(this.step);
    lengths.set(this.lengths);
    this.slots = slots;
    this.days = days;
    this.start = start;
    this.step = step;
    this.lengths = lengths;
  }
}

/** Tas binaire de cases, par valeur croissante, pour les champs de distances. */
class FieldHeap {
  private values = new Float64Array(64);
  private cells = new Int32Array(64);
  size = 0;

  push(value: number, cell: number): void {
    if (this.size === this.values.length) {
      const values = new Float64Array(this.size * 2);
      const cells = new Int32Array(this.size * 2);
      values.set(this.values);
      cells.set(this.cells);
      this.values = values;
      this.cells = cells;
    }
    let index = this.size++;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      const above = this.values[parent] ?? 0;
      if (above <= value) break;
      this.values[index] = above;
      this.cells[index] = this.cells[parent] ?? 0;
      index = parent;
    }
    this.values[index] = value;
    this.cells[index] = cell;
  }

  peek(): number {
    return this.values[0];
  }

  pop(): number {
    const cell = this.cells[0];
    const size = --this.size;
    const value = this.values[size] ?? 0;
    const last = this.cells[size] ?? 0;
    let index = 0;
    for (;;) {
      let child = 2 * index + 1;
      if (child >= size) break;
      if (child + 1 < size && (this.values[child + 1] ?? 0) < (this.values[child] ?? 0)) child++;
      const below = this.values[child] ?? 0;
      if (below >= value) break;
      this.values[index] = below;
      this.cells[index] = this.cells[child] ?? 0;
      index = child;
    }
    this.values[index] = value;
    this.cells[index] = last;
    return cell;
  }
}

/** Les huit voisines d'une case : (dx, dy), les côtés d'abord. */
const NEIGHBORS = [1, 0, -1, 0, 0, 1, 0, -1, 1, 1, -1, 1, -1, -1, 1, -1] as const;

/**
 * Champ de distances d'un camp (ADR 0014) : le coût de marche du camp à chaque case d'un
 * carré de `radius` cases autour de lui, par Dijkstra en huit directions, avec la règle du
 * coin et la couture, chaque pas coûtant la case où l'on entre, fois √2 en diagonale, comme
 * walk. Le carré ne dépend que du camp, jamais de l'histoire des requêtes : il ne se prolonge
 * pas. Le calcul est paresseux, mais chaque valeur rendue est la distance exacte dans le carré,
 * la même quel que soit l'instant où on la demande : un champ recalculé après un chargement
 * redonne les mêmes valeurs. Hors du carré, ou d'une case qu'on ne rejoint pas, Infinity.
 */
export class CampField {
  private readonly cost: Float32Array;
  private readonly width: number;
  private readonly left: number;
  private readonly top: number;
  private readonly span: number;
  private readonly rows: number;
  private readonly dist: Float64Array;
  private readonly settled: Uint8Array;
  private readonly heap = new FieldHeap();

  constructor(cost: Float32Array, width: number, height: number, camp: number, radius: number) {
    this.cost = cost;
    this.width = width;
    // Le carré ne montre jamais deux fois une même colonne.
    const reach = Math.max(1, Math.min(radius, Math.floor((width - 1) / 2)));
    const cx = camp % width;
    const cy = (camp - cx) / width;
    this.left = cx - reach;
    this.span = 2 * reach + 1;
    this.top = Math.max(0, cy - reach);
    this.rows = Math.min(height - 1, cy + reach) - this.top + 1;
    this.dist = new Float64Array(this.span * this.rows).fill(Number.POSITIVE_INFINITY);
    this.settled = new Uint8Array(this.span * this.rows);
    const start = this.local(cx, cy);
    if (start >= 0) {
      this.dist[start] = 0;
      this.heap.push(0, start);
    }
  }

  /** Indice dans le carré de la case (x, y), −1 hors du carré. */
  private local(x: number, y: number): number {
    const row = y - this.top;
    if (row < 0 || row >= this.rows) return NO;
    const column = (((x - this.left) % this.width) + this.width) % this.width;
    return column < this.span ? row * this.span + column : NO;
  }

  /** Coût de la case d'indice local `at`. */
  private costAt(at: number): number {
    const row = Math.floor(at / this.span);
    const column = at - row * this.span;
    const x = (((this.left + column) % this.width) + this.width) % this.width;
    return this.cost[(this.top + row) * this.width + x] ?? Number.POSITIVE_INFINITY;
  }

  /** Distance exacte du camp à la case (x, y), dans le carré. */
  valueAt(x: number, y: number): number {
    const at = this.local(x, y);
    if (at < 0) return Number.POSITIVE_INFINITY;
    const { dist, settled, heap, span, rows } = this;
    while (settled[at] === 0 && heap.size > 0) {
      const used = heap.peek();
      const cell = heap.pop();
      if (settled[cell] === 1) continue;
      settled[cell] = 1;
      const row = Math.floor(cell / span);
      const column = cell - row * span;
      for (let k = 0; k < 16; k += 2) {
        const dx = NEIGHBORS[k] ?? 0;
        const dy = NEIGHBORS[k + 1] ?? 0;
        const c = column + dx;
        const r = row + dy;
        if (c < 0 || c >= span || r < 0 || r >= rows) continue;
        const next = r * span + c;
        const enter = this.costAt(next);
        if (!(enter < Number.POSITIVE_INFINITY)) continue;
        let total = used + enter;
        if (dx !== 0 && dy !== 0) {
          // Pas de coin coupé : les deux cases qu'enjambe la diagonale se franchissent.
          if (
            !(this.costAt(row * span + c) < Number.POSITIVE_INFINITY) ||
            !(this.costAt(r * span + column) < Number.POSITIVE_INFINITY)
          ) {
            continue;
          }
          total = used + enter * Math.SQRT2;
        }
        if (total < (dist[next] ?? 0)) {
          dist[next] = total;
          heap.push(total, next);
        }
      }
    }
    return settled[at] === 1 ? (dist[at] ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
  }
}

/**
 * Caches du mouvement (ADR 0014) : tout s'y déduit de l'état (rebuildMovement), et rien n'y
 * entre dans la sauvegarde ni dans l'empreinte. Chaque liste se garde des doubles insertions :
 * un emplacement y est au plus une fois.
 */
export class Movement {
  readonly width: number;
  readonly height: number;
  private capacity = 0;
  /**
   * Marcheurs, par emplacements croissants une fois rangés (sortActive), ce qui rend leur
   * parcours quotidien plus rapide, sans rien changer à l'état. `walking` dit, par
   * emplacement, s'il est dans la liste (1), s'il en est sorti sans qu'elle soit encore
   * resserrée (2), ou s'il n'y est pas (0).
   */
  active = new Int32Array(0);
  activeCount = 0;
  walking = new Uint8Array(0);
  private unsorted = false;
  private stale = 0;
  /** En partance, par jour du départ. */
  readonly leaving: number[][] = Array.from({ length: DAYS_PER_MONTH }, () => []);
  /**
   * Places tenues, par case : celle de qui se repose ou va partir, la place visée de qui
   * marche. Premier de chaque case, puis par emplacement le suivant, le précédent, la case
   * (−1 sans place) et le point.
   */
  readonly restHead: Int32Array<ArrayBuffer>;
  /**
   * Par emplacement, d'un bloc pour qu'une recherche ne lise qu'une ligne de mémoire : x, y,
   * le suivant de sa case, et 1 si la place est celle de qui part ce mois-ci (REST_STRIDE).
   */
  rest = new Int32Array(0);
  restPrev = new Int32Array(0);
  restCell = new Int32Array(0);
  /** Portés : la mère de chacun (−1), et, pour chaque mère, son premier porté et le suivant. */
  carrier = new Int32Array(0);
  childHead = new Int32Array(0);
  childNext = new Int32Array(0);
  /** Guide et nombre de membres de chaque groupe, par identifiant. */
  readonly guides = new Map<number, number>();
  readonly sizes = new Map<number, number>();
  /** Champs de distances, par case du camp ; vidés à chaque pas mensuel et au pinceau. */
  readonly fields = new Map<number, CampField>();
  /** Disques franchissables autour des centres des camps (clearRadius), vidés comme eux. */
  readonly openings = new Map<number, number>();
  /** Étapes commencées, que l'hôte envoie au rendu ; aucune sans hôte. */
  journal: LegJournal | undefined;
  /** Allure propre de chaque emplacement, gardée le temps d'un mois (ownPace). */
  paceValue = new Float64Array(0);
  paceTick = new Int32Array(0);
  paceId = new Uint32Array(0);
  /** Position de la veille de chaque marcheur, et marque de qui arrive ce jour. */
  prevX = new Int32Array(0);
  prevY = new Int32Array(0);
  private arrivingOn = new Int32Array(0);
  /** Comptes, pour les mesures : étapes, arrivées, places reprises, écarts, champs, blocages. */
  readonly counts = {
    legs: 0,
    straight: 0,
    edges: 0,
    sides: 0,
    detours: 0,
    arrivals: 0,
    retaken: 0,
    asides: 0,
    fields: 0,
    stuck: 0,
    places: 0,
    crowded: 0,
    weaned: 0,
    forced: 0,
  };

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.restHead = new Int32Array(width * height).fill(NO);
  }

  /** Assez de place pour `capacity` emplacements. */
  ensure(capacity: number): void {
    if (capacity <= this.capacity) return;
    const size = Math.max(capacity, this.capacity * 2, 64);
    this.active = grownInt32(this.active, size, 0);
    if (this.walking.length < size) {
      const walking = new Uint8Array(size);
      walking.set(this.walking);
      this.walking = walking;
    }
    this.rest = grownInt32(this.rest, size * REST_STRIDE, NO);
    this.restPrev = grownInt32(this.restPrev, size, NO);
    this.restCell = grownInt32(this.restCell, size, NO);
    this.carrier = grownInt32(this.carrier, size, NO);
    this.childHead = grownInt32(this.childHead, size, NO);
    this.childNext = grownInt32(this.childNext, size, NO);
    this.prevX = grownInt32(this.prevX, size, 0);
    this.prevY = grownInt32(this.prevY, size, 0);
    this.arrivingOn = grownInt32(this.arrivingOn, size, -1);
    this.paceTick = grownInt32(this.paceTick, size, 0);
    if (this.paceValue.length < size) {
      const value = new Float64Array(size);
      value.set(this.paceValue);
      this.paceValue = value;
      const id = new Uint32Array(size);
      id.set(this.paceId);
      this.paceId = id;
    }
    this.capacity = size;
  }

  // --- Marcheurs.

  addActive(slot: number): void {
    const flag = this.walking[slot] ?? 0;
    if (flag === 1) return;
    this.walking[slot] = 1;
    if (flag === 2) {
      // Il est encore dans la liste, qui n'a pas été resserrée depuis sa sortie.
      this.stale--;
      return;
    }
    this.active[this.activeCount++] = slot;
    this.unsorted = true;
  }

  removeActive(slot: number): void {
    if (this.walking[slot] !== 1) return;
    this.walking[slot] = 2;
    this.stale++;
  }

  /** Marche-t-il ? */
  isActive(slot: number): boolean {
    return this.walking[slot] === 1;
  }

  /** Resserre la liste des marcheurs, puis la range par emplacements croissants. */
  sortActive(): void {
    if (this.stale > 0) {
      let kept = 0;
      for (let index = 0; index < this.activeCount; index++) {
        const slot = this.active[index] ?? 0;
        if (this.walking[slot] === 1) this.active[kept++] = slot;
        else this.walking[slot] = 0;
      }
      this.activeCount = kept;
      this.stale = 0;
    }
    if (this.unsorted) {
      this.active.subarray(0, this.activeCount).sort();
      this.unsorted = false;
    }
  }

  // --- Places tenues.

  /**
   * Tient la place (x, y) pour `slot`, au lieu de celle qu'il tenait peut-être ; `leaving` :
   * c'est celle de qui part ce mois-ci, qu'une place à venir peut prendre.
   */
  hold(slot: number, x: number, y: number, leaving = false): void {
    this.release(slot);
    const cell = cellOf(x, y, this.width);
    const head = this.restHead[cell] ?? NO;
    const at = slot * REST_STRIDE;
    this.rest[at] = x;
    this.rest[at + 1] = y;
    this.rest[at + 2] = head;
    this.rest[at + 3] = leaving ? 1 : 0;
    this.restCell[slot] = cell;
    this.restPrev[slot] = NO;
    if (head >= 0) this.restPrev[head] = slot;
    this.restHead[cell] = slot;
  }

  /** Libère la place que tient `slot`, s'il en tient une. */
  release(slot: number): void {
    const cell = this.restCell[slot] ?? NO;
    if (cell < 0) return;
    const prev = this.restPrev[slot] ?? NO;
    const next = this.rest[slot * REST_STRIDE + 2] ?? NO;
    if (prev >= 0) this.rest[prev * REST_STRIDE + 2] = next;
    else this.restHead[cell] = next;
    if (next >= 0) this.restPrev[next] = prev;
    this.restCell[slot] = NO;
    this.restPrev[slot] = NO;
    this.rest[slot * REST_STRIDE + 2] = NO;
  }

  /**
   * Distance, en cases, de (x, y) à la place tenue la plus proche, hors de celle de `except`,
   * bornée par `limit` : les places qu'on regarde sont celles des cases que touche le carré
   * de côté 2 × limit autour du point (limit < 1/2 : quatre cases au plus). Avec les
   * intentions `leaving`, la place de qui part ce mois-ci ne compte pas.
   */
  nearestHeld(x: number, y: number, limit: number, except: number, ignoreLeaving = false): number {
    const { restHead: head, rest, width, height } = this;
    const reach = limit * FIXED;
    const top = Math.max(0, Math.floor((y - reach) / FIXED));
    const bottom = Math.min(height - 1, Math.floor((y + reach) / FIXED));
    const left = Math.floor((x - reach) / FIXED);
    const right = Math.floor((x + reach) / FIXED);
    const span = width * FIXED;
    let best = limit * limit;
    for (let row = top; row <= bottom; row++) {
      for (let column = left; column <= right; column++) {
        const wrapped = ((column % width) + width) % width;
        // Sur un monde étroit, deux colonnes du carré ne désignent jamais la même case.
        if (column !== left && wrapped === ((left % width) + width) % width) continue;
        // Une liste se parcourt au plus une fois par élément : aucune ne boucle (hold, release).
        for (let slot = head[row * width + wrapped] ?? NO; slot >= 0;) {
          const at = slot * REST_STRIDE;
          const next = rest[at + 2] ?? NO;
          // Qui part ce mois-ci libère sa place : elle ne compte pas pour une place à venir.
          if (slot === except || (ignoreLeaving && rest[at + 3] === 1)) {
            slot = next;
            continue;
          }
          let dx = ((rest[at] ?? 0) - x) % span;
          if (dx < -span / 2) dx += span;
          else if (dx >= span / 2) dx -= span;
          dx /= FIXED;
          const dy = ((rest[at + 1] ?? 0) - y) / FIXED;
          slot = next;
          const squared = dx * dx + dy * dy;
          if (squared < best) best = squared;
        }
      }
    }
    return Math.sqrt(best);
  }

  // --- Portés.

  carry(child: number, mother: number): void {
    if ((this.carrier[child] ?? NO) >= 0) return;
    this.carrier[child] = mother;
    this.childNext[child] = this.childHead[mother] ?? NO;
    this.childHead[mother] = child;
  }

  /** Le porté `child` quitte les bras de sa mère. */
  uncarry(child: number): void {
    const mother = this.carrier[child] ?? NO;
    if (mother < 0) return;
    let previous = NO;
    let at = this.childHead[mother] ?? NO;
    while (at >= 0 && at !== child) {
      previous = at;
      at = this.childNext[at] ?? NO;
    }
    const next = this.childNext[child] ?? NO;
    if (previous >= 0) this.childNext[previous] = next;
    else this.childHead[mother] = next;
    this.carrier[child] = NO;
    this.childNext[child] = NO;
  }

  /** Arrive-t-il ce jour, au rang de jour `day` ? */
  arriving(slot: number, day: number): boolean {
    return this.arrivingOn[slot] === day;
  }

  markArriving(slot: number, day: number): void {
    this.arrivingOn[slot] = day;
  }

  /** Oublie tout : listes, grilles et portés (rebuildMovement les refait). */
  clear(): void {
    for (let index = 0; index < this.activeCount; index++)
      this.walking[this.active[index] ?? 0] = 0;
    this.activeCount = 0;
    this.stale = 0;
    this.unsorted = false;
    for (const list of this.leaving) list.length = 0;
    for (let slot = 0; slot < this.capacity; slot++) {
      const rest = this.restCell[slot] ?? NO;
      if (rest >= 0) this.restHead[rest] = NO;
    }
    this.restCell.fill(NO);
    for (let at = 2; at < this.rest.length; at += REST_STRIDE) this.rest[at] = NO;
    this.restPrev.fill(NO);
    this.carrier.fill(NO);
    this.childHead.fill(NO);
    this.childNext.fill(NO);
    this.guides.clear();
    this.sizes.clear();
  }
}

// --- Segments.

/** Coût de la case (cx, cy), cx déroulé ; Infinity au-delà des pôles. */
function costAt(cost: Float32Array, width: number, height: number, cx: number, cy: number): number {
  if (cy < 0 || cy >= height) return Infinity;
  return cost[cy * width + (((cx % width) + width) % width)] ?? Infinity;
}

/** Résultat d'un parcours de segment (trace), repris d'un appel à l'autre. */
const traced = { clear: false, cost: 0, blocked: 0, margin: 0 };

/**
 * Parcourt le segment de (ax, ay) à (bx, by), en unités, bx déroulé (ax plus l'écart au plus
 * court) : les cases qu'il traverse, couture comprise. Il est libre si chacune se franchit,
 * jusqu'à celle qui contient son bout, et s'il ne coupe aucun coin : passer à moins de 2^-16
 * case d'un coin, c'est passer en diagonale, ce qui demande que les deux cases qu'il enjambe
 * se franchissent elles aussi. `cost` est le coût moyen du segment, chaque case comptant au
 * prorata du chemin qu'on y fait ; `blocked`, la part du segment faite avant la première case
 * qu'il ne peut franchir ; `margin`, ce qui le sépare au plus près d'un coin, quand il passe
 * d'une case à l'autre : un segment qui ne s'en écarte que de moins traverse les mêmes cases.
 * La case de départ compte pour 1 si elle ne se franchit pas (une partie relue après un
 * changement du contenu).
 */
export function trace(
  cost: Float32Array,
  width: number,
  height: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): typeof traced {
  const x0 = ax / FIXED;
  const y0 = ay / FIXED;
  const dx = (bx - ax) / FIXED;
  const dy = (by - ay) / FIXED;
  const length = Math.sqrt(dx * dx + dy * dy);
  let cx = Math.floor(x0);
  let cy = Math.floor(y0);
  const endX = Math.floor(bx / FIXED);
  const endY = Math.floor(by / FIXED);
  let here = costAt(cost, width, height, cx, cy);
  if (!(here < Number.POSITIVE_INFINITY)) here = 1;
  traced.clear = false;
  traced.blocked = 0;
  traced.cost = here;
  traced.margin = Infinity;
  if (length === 0) {
    traced.clear = true;
    return traced;
  }
  const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const sy = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  let tMaxX = sx > 0 ? (cx + 1 - x0) / dx : sx < 0 ? (x0 - cx) / -dx : Number.POSITIVE_INFINITY;
  let tMaxY = sy > 0 ? (cy + 1 - y0) / dy : sy < 0 ? (y0 - cy) / -dy : Number.POSITIVE_INFINITY;
  const tDeltaX = sx !== 0 ? 1 / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const tDeltaY = sy !== 0 ? 1 / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const epsilon = CORNER / length;
  let t = 0;
  let sum = 0;
  // Au plus une case par colonne et par rangée traversées, plus une marge : jamais de boucle.
  let guard = Math.abs(endX - cx) + Math.abs(endY - cy) + 4;
  while (guard-- > 0 && !(cx === endX && cy === endY)) {
    const next = Math.min(tMaxX, tMaxY);
    if (next > 1) break;
    sum += (next - t) * here;
    t = next;
    // Ce qui le sépare d'un coin à ce bord, en cases, le long du segment.
    const apart = Math.abs(tMaxX - tMaxY) * length;
    if (apart < traced.margin) traced.margin = apart;
    if (Math.abs(tMaxX - tMaxY) <= epsilon) {
      // Passage par un coin : les deux cases qu'il enjambe se franchissent (celle d'en face
      // se vérifie comme toute case où il entre, juste après).
      if (
        !(costAt(cost, width, height, cx + sx, cy) < Infinity) ||
        !(costAt(cost, width, height, cx, cy + sy) < Infinity)
      ) {
        traced.blocked = t;
        return traced;
      }
      cx += sx;
      cy += sy;
      tMaxX += tDeltaX;
      tMaxY += tDeltaY;
    } else if (tMaxX < tMaxY) {
      cx += sx;
      tMaxX += tDeltaX;
    } else {
      cy += sy;
      tMaxY += tDeltaY;
    }
    here = costAt(cost, width, height, cx, cy);
    if (!(here < Infinity)) {
      traced.blocked = t;
      return traced;
    }
  }
  sum += Math.max(0, 1 - t) * here;
  if (!(cx === endX && cy === endY)) {
    // Le bout tombe sur un bord ou un coin de la dernière case parcourue : sa case, voisine,
    // se franchit, et, en diagonale, les deux qu'il enjambe aussi.
    const ox = endX - cx;
    const oy = endY - cy;
    if (
      Math.abs(ox) > 1 ||
      Math.abs(oy) > 1 ||
      !(costAt(cost, width, height, endX, endY) < Infinity)
    ) {
      traced.blocked = 1;
      return traced;
    }
    if (
      ox !== 0 &&
      oy !== 0 &&
      (!(costAt(cost, width, height, cx + ox, cy) < Infinity) ||
        !(costAt(cost, width, height, cx, cy + oy) < Infinity))
    ) {
      traced.blocked = 1;
      return traced;
    }
  }
  traced.clear = true;
  traced.cost = sum;
  return traced;
}

/** Le segment de (ax, ay) à (bx, by), en unités, bx dans le monde, est-il libre ? */
export function segmentClear(state: SimState, ax: number, ay: number, bx: number, by: number) {
  const { width, height } = state.size;
  return trace(state.cost, width, height, ax, ay, ax + deltaFixedX(ax, bx, width), by).clear;
}

/** La case de la position (x, y) se franchit-elle ? */
function passableAt(state: SimState, x: number, y: number): boolean {
  const { width, height } = state.size;
  if (y < 0 || y >= height * FIXED) return false;
  const cell = cellOf(wrapFixedX(x, width), y, width);
  return (state.cost[cell] ?? Number.POSITIVE_INFINITY) < Number.POSITIVE_INFINITY;
}

// --- Allure.

/** Valeur d'une courbe par morceaux à `x` : linéaire entre deux points, constante au-delà. */
export function curveAt(points: readonly (readonly [number, number])[], x: number): number {
  if (points.length === 0) return 1;
  const first = points[0];
  if (x <= first[0]) return first[1];
  for (let index = 1; index < points.length; index++) {
    const point = points[index];
    const previous = points[index - 1];
    if (x <= point[0]) {
      return (
        previous[1] + ((point[1] - previous[1]) * (x - previous[0])) / (point[0] - previous[0])
      );
    }
  }
  return points.at(-1)?.[1] ?? 1;
}

/** Endurance de l'ascendance de `slot`, de 0 à 1. */
function enduranceOf(people: Population, slot: number, species: Species): number {
  let endurance = 0;
  const { ancestry } = people.columns;
  for (let index = 0; index < ANCESTRY_SLOTS; index++) {
    const share = (ancestry[slot * ANCESTRY_SLOTS + index] ?? 0) / ANCESTRY_TOTAL;
    if (share === 0) continue;
    endurance += share * (species.subspecies.at(index)?.adaptation.endurance ?? 0.5);
  }
  return endurance;
}

/**
 * Allure propre de `slot`, en cases de plaine par jour (ADR 0014) : nomads.walk / 30 cases,
 * fois 0,8 + 0,4 × l'endurance de son ascendance, comme le budget de marche d'un groupe ;
 * fois sa rapidité (trait du rôle « speed »), le facteur de son âge, et sa charge (porter un
 * nourrisson, être enceinte), tous tirés de data/species.json.
 */
export function ownPace(state: SimState, content: SimContent, slot: number): number {
  const { people, tick, movement } = state;
  const { columns } = people;
  // Rien n'en change d'ici le prochain pas mensuel : âge, charge, grossesse ne changent qu'à
  // lui. La valeur se garde donc le temps du mois, pour l'identifiant qui l'a demandée.
  if (movement.paceTick[slot] === tick + 1 && movement.paceId[slot] === columns.id[slot]) {
    return movement.paceValue[slot] ?? 0;
  }
  const pace = computePace(state, content, slot);
  movement.paceTick[slot] = tick + 1;
  movement.paceId[slot] = columns.id[slot] ?? 0;
  movement.paceValue[slot] = pace;
  return pace;
}

function computePace(state: SimState, content: SimContent, slot: number): number {
  const { people, tick } = state;
  const { columns } = people;
  const base = content.nomads.walk / DAYS_PER_MONTH;
  const species = content.species.entries.at(columns.species[slot] ?? 0);
  if (species === undefined) return base;
  const { pace } = species;
  const speed = trait(
    columns.genome,
    slot * GENOME_WORDS,
    geneRoles(content.genetics).traits.speed,
  );
  const years = (tick - (columns.birth[slot] ?? 0)) / MONTHS_PER_YEAR;
  const carrying = (state.movement.childHead[slot] ?? NO) >= 0 ? pace.carrying : 1;
  const pregnant = (columns.conceived[slot] ?? NEVER) !== NEVER ? pace.pregnant : 1;
  return (
    base *
    (0.8 + 0.4 * enduranceOf(people, slot, species)) *
    (pace.speed[0] + (pace.speed[1] - pace.speed[0]) * speed) *
    curveAt(pace.age, years) *
    carrying *
    pregnant
  );
}

/** Grégarité effective de `slot`, de 0 à 1 : g' = 1 − (1 − g) × (1 − cohésion). */
export function effectiveGregariousness(state: SimState, content: SimContent, slot: number) {
  const g = (state.people.columns.gregariousness[slot] ?? 0) / 255;
  return 1 - (1 - g) * (1 - content.nomads.camp.cohesion);
}

/**
 * Allure de marche de `slot` : la sienne, rapprochée de celle du guide de son groupe selon
 * sa grégarité effective, g' × celle du guide + (1 − g') × la sienne ; qui marche depuis un
 * mois précédent presse le pas (camp.hurry).
 */
export function walkingPace(state: SimState, content: SimContent, slot: number): number {
  const own = ownPace(state, content, slot);
  const guide = state.movement.guides.get(state.people.columns.group[slot] ?? NONE) ?? NO;
  const g = effectiveGregariousness(state, content, slot);
  const blended =
    guide >= 0 && guide !== slot ? g * ownPace(state, content, guide) + (1 - g) * own : own;
  const late = ((state.people.columns.move[slot] ?? 0) & LATE) !== 0;
  return late ? blended * content.nomads.camp.hurry : blended;
}

// --- Groupes : guide, lieu, ancres.

/**
 * Guide de chaque groupe (ADR 0014) : son meneur s'il y vit, sinon l'aîné de ses membres qui
 * marchent (le plus tôt né, puis le premier dans l'ordre des emplacements). Ce n'est qu'une
 * fonction de l'état.
 */
function findGuides(state: SimState, guides: Map<number, number>, sizes: Map<number, number>) {
  const { people, society } = state;
  const { alive, end } = people;
  const { group: groups, birth, move, id } = people.columns;
  guides.clear();
  sizes.clear();
  const eldest = new Map<number, number>();
  for (let slot = 0; slot < end; slot++) {
    if (alive[slot] !== 1) continue;
    const group = groups[slot] ?? NONE;
    if (group === NONE) continue;
    sizes.set(group, (sizes.get(group) ?? 0) + 1);
    if (((move[slot] ?? 0) & INTENTION) === CARRIED) continue;
    if (society.groups.get(group)?.leader === id[slot]) guides.set(group, slot);
    const best = eldest.get(group);
    if (best === undefined || (birth[slot] ?? 0) < (birth[best] ?? 0)) eldest.set(group, slot);
  }
  for (const [group, slot] of eldest) if (!guides.has(group)) guides.set(group, slot);
}

/** Guide du groupe `group`, ou −1 s'il n'a personne qui marche. */
export function guideOf(state: SimState, group: number): number {
  return state.movement.guides.get(group) ?? NO;
}

/**
 * Lieu de chaque groupe, au début du pas mensuel (ADR 0014) : la case du membre le plus proche
 * du barycentre de ses membres qui marchent, les écarts pris au plus court par rapport au
 * premier dans l'ordre des emplacements ; à égalité, le premier l'emporte. Ce lieu se
 * franchit toujours, et il est sur la terre du groupe.
 */
export function locateGroups(state: SimState, members: ReadonlyMap<number, readonly number[]>) {
  for (const group of state.society.groups.values()) {
    const cell = centralMember(state, members.get(group.id) ?? []);
    if (cell < 0) continue;
    const { width } = state.size;
    group.x = cell % width;
    group.y = (cell - group.x) / width;
  }
}

/** Case du membre de `list` le plus proche du barycentre des marcheurs, −1 sans personne. */
export function centralMember(state: SimState, list: readonly number[]): number {
  const { width } = state.size;
  const { x, y, move } = state.people.columns;
  let first = NO;
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (const slot of list) {
    if (((move[slot] ?? 0) & INTENTION) === CARRIED) continue;
    if (first < 0) first = slot;
    sumX += deltaFixedX(x[first] ?? 0, x[slot] ?? 0, width);
    sumY += (y[slot] ?? 0) - (y[first] ?? 0);
    count++;
  }
  if (first < 0) return NO;
  const cx = (x[first] ?? 0) + sumX / count;
  const cy = (y[first] ?? 0) + sumY / count;
  let best = first;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const slot of list) {
    if (((move[slot] ?? 0) & INTENTION) === CARRIED) continue;
    const dx = deltaFixedX(x[slot] ?? 0, cx, width);
    const dy = cy - (y[slot] ?? 0);
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      best = slot;
      bestDistance = distance;
    }
  }
  return cellOf(x[best] ?? 0, y[best] ?? 0, width);
}

/** Âge en années de `slot`. */
function yearsOf(state: SimState, slot: number): number {
  return (state.tick - (state.people.columns.birth[slot] ?? 0)) / MONTHS_PER_YEAR;
}

/** `other` vit-il, dans le groupe `group`, sans être porté ? */
function walksIn(people: Population, other: number | undefined, group: number): other is number {
  return (
    other !== undefined &&
    people.alive[other] === 1 &&
    people.columns.group[other] === group &&
    ((people.columns.move[other] ?? 0) & INTENTION) !== CARRIED
  );
}

/**
 * Ancre du foyer de `slot` (ADR 0014) : le centre du camp pour le guide ; le conjoint qui
 * mène le foyer (le plus petit identifiant des deux), sinon la mère, sinon, pour un enfant,
 * le père, s'ils vivent dans son groupe ; le guide pour le chef d'un foyer.
 */
export function anchorOf(state: SimState, content: SimContent, slot: number): number {
  const { people } = state;
  const { columns } = people;
  const group = columns.group[slot] ?? NONE;
  const guide = state.movement.guides.get(group) ?? NO;
  if (slot === guide) return CAMP;
  const id = columns.id[slot] ?? 0;
  const partner = people.slotOf(columns.partner[slot] ?? NONE);
  if (walksIn(people, partner, group)) {
    return (columns.id[partner] ?? 0) < id ? partner : guide;
  }
  const mother = people.slotOf(columns.mother[slot] ?? NONE);
  if (walksIn(people, mother, group)) return mother;
  const species = content.species.entries.at(columns.species[slot] ?? 0);
  if (species !== undefined && yearsOf(state, slot) < species.maturity) {
    const father = people.slotOf(columns.father[slot] ?? NONE);
    if (walksIn(people, father, group)) return father;
  }
  return guide;
}

// --- Places.

/**
 * Une place autour de (ax, ay), en unités, dans un disque de rayon `radius` cases (ADR 0014) :
 * un point tiré au sort, par rejet dans le disque unité, sur une case franchissable, en vue du
 * centre du camp (cx, cy) par un segment libre, et à `gap` case au moins de toute place tenue,
 * hors de celle de `except` et de celles de qui part ce mois-ci, qui les libérera. Six tirages
 * dans le rayon, puis dans des rayons élargis (PLACE_REACHES) ; à défaut, la meilleure place
 * en vue tirée, la plus éloignée des autres ; à défaut encore, l'ancre elle-même si elle est
 * en vue, sinon le centre du camp. `others` ajoute des points tenus que la grille ne connaît
 * pas encore (une apparition).
 */
export function pickPlace(
  state: SimState,
  ax: number,
  ay: number,
  radius: number,
  cx: number,
  cy: number,
  gap: number,
  except: number,
  random: RandomStream,
  others?: { readonly x: number[]; readonly y: number[] },
): { readonly x: number; readonly y: number } {
  const { width, height } = state.size;
  const movement = state.movement;
  // Ce qui tombe dans le disque de cases franchissables autour du centre est en vue de lui.
  const open = clearRadius(state, cx, cy);
  movement.counts.places++;
  let bestX = 0;
  let bestY = 0;
  let bestRoom = -1;
  for (const scale of PLACE_REACHES) {
    const reach = radius * scale * FIXED;
    let u: number;
    let v: number;
    do {
      u = 2 * random.nextFloat() - 1;
      v = 2 * random.nextFloat() - 1;
    } while (u * u + v * v > 1);
    const x = wrapFixedX(ax + Math.round(u * reach), width);
    const y = ay + Math.round(v * reach);
    if (y < 0 || y >= height * FIXED || !passableAt(state, x, y)) continue;
    const ox = deltaFixedX(cx, x, width) / FIXED;
    const oy = (y - cy) / FIXED;
    if (ox * ox + oy * oy >= open * open && !segmentClear(state, cx, cy, x, y)) continue;
    const room = roomAt(state, x, y, gap, except, others);
    if (room >= gap) return chosen(x, y);
    if (room > bestRoom) {
      bestRoom = room;
      bestX = x;
      bestY = y;
    }
  }
  // Aucun tirage libre : les points d'anneaux autour de l'ancre, de proche en proche, sans
  // tirage ; le premier libre et en vue l'emporte, sinon le plus éloigné des autres.
  for (let ring = 1; ring <= RING_STEPS; ring++) {
    const distance = (gap * ring) / 2;
    for (const [ux, uy] of RING) {
      const x = wrapFixedX(ax + Math.round(ux * distance * FIXED), width);
      const y = ay + Math.round(uy * distance * FIXED);
      if (y < 0 || y >= height * FIXED || !passableAt(state, x, y)) continue;
      if (!segmentClear(state, cx, cy, x, y)) continue;
      const room = roomAt(state, x, y, gap, except, others);
      if (room >= gap) return chosen(x, y);
      if (room > bestRoom) {
        bestRoom = room;
        bestX = x;
        bestY = y;
      }
    }
  }
  movement.counts.crowded++;
  if (bestRoom >= 0) return chosen(bestX, bestY);
  const anchorX = wrapFixedX(ax, width);
  if (passableAt(state, anchorX, ay) && segmentClear(state, cx, cy, anchorX, ay)) {
    return chosen(anchorX, ay);
  }
  return chosen(wrapFixedX(cx, width), cy);
}

/**
 * Directions des anneaux de secours de pickPlace : seize, d'un pas d'un seizième de tour,
 * calculées une fois par les seules racines carrées (cos et sin de π/8 et de π/4).
 */
const RING: readonly (readonly [number, number])[] = (() => {
  const c8 = Math.sqrt(2 + Math.SQRT2) / 2;
  const s8 = Math.sqrt(2 - Math.SQRT2) / 2;
  const h = Math.SQRT1_2;
  const quarter: [number, number][] = [
    [1, 0],
    [c8, s8],
    [h, h],
    [s8, c8],
  ];
  // Les quatre quarts de tour : (x, y), (−y, x), (−x, −y), (y, −x).
  return [0, 1, 2, 3].flatMap((turn) =>
    quarter.map(([x, y]): [number, number] =>
      turn === 0 ? [x, y] : turn === 1 ? [-y, x] : turn === 2 ? [-x, -y] : [y, -x],
    ),
  );
})();
/** Anneaux de secours, de demi-écart en demi-écart du repos, jusqu'à trois écarts. */
const RING_STEPS = 6;

/**
 * Place libre autour de (x, y), en cases, bornée par `gap` : la distance à la plus proche place
 * tenue, hors de celle de `except` et de celles de qui part, et aux points de `others`.
 */
function roomAt(
  state: SimState,
  x: number,
  y: number,
  gap: number,
  except: number,
  others: { readonly x: number[]; readonly y: number[] } | undefined,
): number {
  let room = state.movement.nearestHeld(x, y, gap, except, true);
  if (others === undefined) return room;
  const { width } = state.size;
  for (let index = 0; index < others.x.length && room > 0; index++) {
    const dx = deltaFixedX(x, others.x[index] ?? 0, width) / FIXED;
    const dy = ((others.y[index] ?? 0) - y) / FIXED;
    room = Math.min(room, Math.sqrt(dx * dx + dy * dy));
  }
  return room;
}

/** La place que rend pickPlace, reprise d'un appel à l'autre. */
const place = { x: 0, y: 0 };

function chosen(x: number, y: number): typeof place {
  place.x = x;
  place.y = y;
  return place;
}

/** Rayon, en cases, où l'on cherche un disque franchissable autour du centre d'un camp. */
const CLEAR_REACH = 5;

/**
 * Rayon, en cases, du plus grand disque centré sur (cx, cy), en unités, dont toutes les cases
 * se franchissent, borné à CLEAR_REACH − ½ : un point qui y tombe est en vue du centre, sans
 * parcourir le segment, puisque toutes les cases qu'il touche, coins compris, sont plus près
 * du centre que lui. Il ne dépend que du terrain : gardé le temps d'un mois, par point.
 */
function clearRadius(state: SimState, cx: number, cy: number): number {
  const movement = state.movement;
  const { width, height } = state.size;
  const px = cx / FIXED;
  const py = cy / FIXED;
  const column = Math.floor(px);
  const row = Math.floor(py);
  // Seul le centre d'une case se garde : c'est celui des camps.
  const centered = cx === column * FIXED + FIXED / 2 && cy === row * FIXED + FIXED / 2;
  const key = row * width + (((column % width) + width) % width);
  const known = centered ? movement.openings.get(key) : undefined;
  if (known !== undefined) return known;
  let radius = CLEAR_REACH - 0.5;
  for (let ring = 0; ring < CLEAR_REACH && ring - 1 < radius; ring++) {
    for (let j = -ring; j <= ring; j++) {
      for (let i = -ring; i <= ring; i++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
        if (costAt(state.cost, width, height, column + i, row + j) < Infinity) continue;
        // La distance du centre au plus proche point de la case.
        const dx = Math.max(0, column + i - px, px - (column + i + 1));
        const dy = Math.max(0, row + j - py, py - (row + j + 1));
        radius = Math.min(radius, Math.sqrt(dx * dx + dy * dy));
      }
    }
  }
  if (centered) movement.openings.set(key, radius);
  return radius;
}

/** Rayon, en cases, où `slot` tire sa place autour de son ancre `anchor`. */
function placeRadius(state: SimState, content: SimContent, slot: number, anchor: number): number {
  const { camp } = content.nomads;
  if (anchor === CAMP) return camp.guide;
  const g = effectiveGregariousness(state, content, slot);
  const group = state.people.columns.group[slot] ?? NONE;
  if (anchor === (state.movement.guides.get(group) ?? NO)) {
    const members = state.movement.sizes.get(group) ?? 1;
    return (camp.band[0] + camp.band[1] * (1 - g)) * Math.max(1, camp.spread * Math.sqrt(members));
  }
  return camp.kin[0] + camp.kin[1] * (1 - g);
}

// --- Le sous-pas quotidien.

/**
 * Un jour de mouvement (ADR 0014, § 2), de l'instant courant au suivant : les départs du
 * jour, la marche, l'espacement un jour sur `walkers.every`, puis les arrivées. advanceDay
 * l'appelle après les commandes, avant de passer au jour suivant ou au pas mensuel.
 */
export function moveDay(state: SimState, content: SimContent): void {
  const movement = state.movement;
  movement.ensure(state.people.columns.id.length);
  const day = dayIndex(state);
  departures(state, content, day);
  const arrivals = walkDay(state, content, day);
  if ((day + 1) % content.nomads.walkers.every === 0) spaceWalkers(state, content, day);
  arrive(state, content, arrivals);
}

/** Les départs du jour, par emplacements croissants : chacun prend sa place et se met en route. */
function departures(state: SimState, content: SimContent, day: number): void {
  const list = state.movement.leaving[state.day] ?? [];
  if (list.length === 0) return;
  const slots = [...list].sort((a, b) => a - b);
  list.length = 0;
  const random = state.rng.stream('sim.camp');
  for (const slot of slots) depart(state, content, slot, random, day);
}

/**
 * Départ de `slot`, s'il part ce jour : son ancre, si elle part aussi ce jour, prend sa place
 * d'abord ; puis il tire la sienne autour d'elle, et se met en marche.
 */
function depart(
  state: SimState,
  content: SimContent,
  slot: number,
  random: RandomStream,
  day: number,
) {
  const { people } = state;
  const { columns } = people;
  const movement = state.movement;
  if (people.alive[slot] !== 1) return;
  const move = columns.move[slot] ?? 0;
  if ((move & INTENTION) !== LEAVE || columns.depart[slot] !== state.day) return;
  // Marqué en marche d'abord : une ancre qui renverrait à lui ne le reprendrait pas.
  columns.move[slot] = (move & ~INTENTION) | WALK;
  const group = state.society.groups.get(columns.group[slot] ?? NONE);
  const cx = group === undefined ? (columns.x[slot] ?? 0) : group.campX * FIXED + FIXED / 2;
  const cy = group === undefined ? (columns.y[slot] ?? 0) : group.campY * FIXED + FIXED / 2;
  const anchor = anchorOf(state, content, slot);
  let ax = cx;
  let ay = cy;
  if (anchor >= 0) {
    const anchorMove = columns.move[anchor] ?? 0;
    if ((anchorMove & INTENTION) === LEAVE && columns.depart[anchor] === state.day) {
      depart(state, content, anchor, random, day);
    }
    const walking = ((columns.move[anchor] ?? 0) & INTENTION) === WALK;
    ax = walking ? columns.goalX[anchor] : columns.x[anchor];
    ay = walking ? columns.goalY[anchor] : columns.y[anchor];
  }
  const radius = placeRadius(state, content, slot, anchor);
  const { x: gx, y: gy } = pickPlace(
    state,
    ax,
    ay,
    radius,
    cx,
    cy,
    content.nomads.camp.gap,
    slot,
    random,
  );
  columns.goalX[slot] = gx;
  columns.goalY[slot] = gy;
  columns.stepDays[slot] = 0;
  movement.hold(slot, gx, gy);
  movement.addActive(slot);
}

/** La marche du jour : chacun avance d'un pas ; renvoie ceux qui arrivent. */
function walkDay(state: SimState, content: SimContent, day: number): number[] {
  const movement = state.movement;
  const { columns } = state.people;
  const { x, y, stepX, stepY, stepDays, goalX, goalY } = columns;
  const { width } = state.size;
  const span = width * FIXED;
  const arrivals: number[] = [];
  const stuck: number[] = [];
  movement.sortActive();
  const { active, walking, childHead } = movement;
  for (let index = 0; index < movement.activeCount; index++) {
    const slot = active[index] ?? 0;
    if (walking[slot] !== 1) continue;
    if ((stepDays[slot] ?? 0) === 0) {
      if (atGoal(state, slot)) {
        movement.prevX[slot] = x[slot] ?? 0;
        movement.prevY[slot] = y[slot] ?? 0;
        movement.markArriving(slot, day);
        arrivals.push(slot);
        continue;
      }
      if (!planLeg(state, content, slot)) {
        stuck.push(slot);
        continue;
      }
      movement.counts.legs++;
      movement.journal?.push(
        slot,
        day,
        x[slot] ?? 0,
        y[slot] ?? 0,
        stepX[slot] ?? 0,
        stepY[slot] ?? 0,
        stepDays[slot] ?? 0,
      );
    }
    const px = x[slot] ?? 0;
    const py = y[slot] ?? 0;
    movement.prevX[slot] = px;
    movement.prevY[slot] = py;
    let nx = px + (stepX[slot] ?? 0);
    if (nx < 0) nx += span;
    else if (nx >= span) nx -= span;
    const ny = py + (stepY[slot] ?? 0);
    x[slot] = nx;
    y[slot] = ny;
    const left = (stepDays[slot] ?? 1) - 1;
    stepDays[slot] = left;
    if ((childHead[slot] ?? NO) >= 0) follow(state, slot);
    if (left === 0 && near(state, nx, ny, goalX[slot] ?? 0, goalY[slot] ?? 0)) {
      movement.markArriving(slot, day);
      arrivals.push(slot);
    }
  }
  for (const slot of stuck) settle(state, slot);
  return arrivals.sort((a, b) => a - b);
}

/** Les portés de `slot` prennent sa position. */
function follow(state: SimState, slot: number): void {
  const movement = state.movement;
  const { x, y } = state.people.columns;
  for (
    let child = movement.childHead[slot] ?? NO;
    child >= 0;
    child = movement.childNext[child] ?? NO
  ) {
    x[child] = x[slot] ?? 0;
    y[child] = y[slot] ?? 0;
  }
}

/** Les points (ax, ay) et (bx, by) sont-ils à moins de 1/128 case l'un de l'autre, par axe ? */
function near(state: SimState, ax: number, ay: number, bx: number, by: number): boolean {
  return Math.abs(deltaFixedX(ax, bx, state.size.width)) <= ARRIVE && Math.abs(by - ay) <= ARRIVE;
}

function atGoal(state: SimState, slot: number): boolean {
  const { x, y, goalX, goalY } = state.people.columns;
  return near(state, x[slot] ?? 0, y[slot] ?? 0, goalX[slot] ?? 0, goalY[slot] ?? 0);
}

/**
 * Pose `slot` là où il se tient, au repos : à son arrivée, ou faute de chemin. Sa place tenue
 * devient sa position ; ses bits de marche s'effacent.
 */
function settle(state: SimState, slot: number): void {
  const movement = state.movement;
  const { columns } = state.people;
  const x = columns.x[slot] ?? 0;
  const y = columns.y[slot] ?? 0;
  if (!atGoal(state, slot)) movement.counts.stuck++;
  columns.move[slot] = REST;
  columns.goalX[slot] = x;
  columns.goalY[slot] = y;
  columns.stepX[slot] = 0;
  columns.stepY[slot] = 0;
  columns.stepDays[slot] = 0;
  movement.hold(slot, x, y);
  movement.removeActive(slot);
}

/**
 * Étape droite de `slot` vers (bx, by), en unités, bx déroulé, si le segment est libre :
 * sa vitesse est son allure divisée par le coût moyen du segment, et l'étape dure le nombre
 * entier de jours qui la tient sous cette vitesse. Le pas est entier : la fin de l'étape,
 * position plus jours × pas, tombe à quelques unités de (bx, by), et ce segment-là, entre
 * les deux bouts exacts de l'étape, est vérifié lui aussi.
 */
function legTo(
  state: SimState,
  content: SimContent,
  slot: number,
  bx: number,
  by: number,
): boolean {
  const { columns } = state.people;
  const { width, height } = state.size;
  const ax = columns.x[slot] ?? 0;
  const ay = columns.y[slot] ?? 0;
  const path = trace(state.cost, width, height, ax, ay, bx, by);
  if (!path.clear) return false;
  const { margin } = path;
  const dx = (bx - ax) / FIXED;
  const dy = (by - ay) / FIXED;
  const length = Math.sqrt(dx * dx + dy * dy);
  const speed = walkingPace(state, content, slot) / Math.max(1, path.cost);
  const days = Math.min(MAX_LEG_DAYS, Math.max(1, Math.ceil(length / speed - 1e-9)));
  const sx = Math.round((bx - ax) / days);
  const sy = Math.round((by - ay) / days);
  if (Math.abs(sx) > MAX_STEP || Math.abs(sy) > MAX_STEP) return false;
  const ex = ax + days * sx;
  const ey = ay + days * sy;
  if (ey < 0 || ey >= height * FIXED) return false;
  if (ex !== bx || ey !== by) {
    // Le bout exact de l'étape s'écarte à peine du but : s'il tombe dans la même case, et que
    // le segment ne frôle aucun coin de plus près, l'étape traverse les mêmes cases.
    const shift = (Math.abs(ex - bx) + Math.abs(ey - by)) / FIXED;
    const same =
      Math.floor(ex / FIXED) === Math.floor(bx / FIXED) &&
      Math.floor(ey / FIXED) === Math.floor(by / FIXED) &&
      margin > shift;
    if (!same && !trace(state.cost, width, height, ax, ay, ex, ey).clear) return false;
  }
  columns.stepX[slot] = sx;
  columns.stepY[slot] = sy;
  columns.stepDays[slot] = days;
  return true;
}

/** Centre de la case (cx, cy), en unités, cx déroulé. */
const centerOf = (c: number) => c * FIXED + FIXED / 2;

/**
 * Étape de `slot` vers le centre de la case voisine (nx, ny), nx déroulé : droit si le segment
 * est libre, sinon d'abord jusqu'au centre de sa propre case, d'où le segment l'est.
 */
function legToward(state: SimState, content: SimContent, slot: number, nx: number, ny: number) {
  const { columns } = state.people;
  const ax = columns.x[slot] ?? 0;
  const ay = columns.y[slot] ?? 0;
  if (legTo(state, content, slot, centerOf(nx), centerOf(ny))) return true;
  const cx = Math.floor(ax / FIXED);
  const cy = Math.floor(ay / FIXED);
  if (ax === centerOf(cx) && ay === centerOf(cy)) return false;
  return legTo(state, content, slot, centerOf(cx), centerOf(cy));
}

/**
 * Étape suivante de `slot` vers sa place (ADR 0014) : en ligne droite si la voie est libre ;
 * sinon jusqu'au bord de l'obstacle, si cela le rapproche d'une case ; sinon vers la case
 * voisine qui le rapproche le plus, selon la règle de walk ; sinon, en détour, il descend le
 * champ de distances du camp de son groupe, jusqu'à ce que la voie redevienne libre. Chaque
 * changement de case rapproche ainsi strictement de la place, ou descend strictement le
 * champ : il n'y a pas de cycle. Faux s'il n'a plus de chemin.
 */
function planLeg(state: SimState, content: SimContent, slot: number): boolean {
  const { columns } = state.people;
  const { width, height } = state.size;
  const ax = columns.x[slot] ?? 0;
  const ay = columns.y[slot] ?? 0;
  const gx = ax + deltaFixedX(ax, columns.goalX[slot] ?? 0, width);
  const gy = columns.goalY[slot] ?? 0;
  const move = columns.move[slot] ?? 0;
  const counts = state.movement.counts;
  if (legTo(state, content, slot, gx, gy)) {
    columns.move[slot] = move & ~DETOUR;
    counts.straight++;
    return true;
  }
  const cx = Math.floor(ax / FIXED);
  const cy = Math.floor(ay / FIXED);
  // Distance du centre d'une case à la place, au carré.
  const remaining = (x: number, y: number) => {
    const dx = (gx - centerOf(x)) / FIXED;
    const dy = (gy - centerOf(y)) / FIXED;
    return dx * dx + dy * dy;
  };
  const here = remaining(cx, cy);
  const passable = (x: number, y: number) =>
    y >= 0 &&
    y < height &&
    (state.cost[y * width + (((x % width) + width) % width)] ?? Number.POSITIVE_INFINITY) <
      Number.POSITIVE_INFINITY;
  if ((move & DETOUR) === 0) {
    // Jusqu'au bord, si la dernière case libre de la ligne est plus proche de la place.
    const path = trace(state.cost, width, height, ax, ay, gx, gy);
    const dx = (gx - ax) / FIXED;
    const dy = (gy - ay) / FIXED;
    const length = Math.sqrt(dx * dx + dy * dy);
    const share = path.blocked - EDGE_MARGIN / FIXED / Math.max(length, 1e-9);
    if (share > 0) {
      const ex = ax + Math.round((gx - ax) * share);
      const ey = ay + Math.round((gy - ay) * share);
      const ecx = Math.floor(ex / FIXED);
      const ecy = Math.floor(ey / FIXED);
      if (
        (ecx !== cx || ecy !== cy) &&
        remaining(ecx, ecy) < here - 1e-9 &&
        legTo(state, content, slot, ex, ey)
      ) {
        counts.edges++;
        return true;
      }
    }
    // La case voisine qui rapproche le plus, la moins coûteuse à égalité.
    let best = -1;
    let bestDistance = here - 1e-9;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let k = 0; k < 16; k += 2) {
      const ox = NEIGHBORS[k] ?? 0;
      const oy = NEIGHBORS[k + 1] ?? 0;
      const nx = cx + ox;
      const ny = cy + oy;
      if (!passable(nx, ny)) continue;
      if (ox !== 0 && oy !== 0 && (!passable(cx + ox, cy) || !passable(cx, cy + oy))) continue;
      const distance = remaining(nx, ny);
      const cost = state.cost[ny * width + (((nx % width) + width) % width)] ?? 0;
      if (distance < bestDistance - 1e-9 || (distance < bestDistance + 1e-9 && cost < bestCost)) {
        best = k;
        bestDistance = distance;
        bestCost = cost;
      }
    }
    if (best >= 0) {
      counts.sides++;
      return legToward(
        state,
        content,
        slot,
        cx + (NEIGHBORS[best] ?? 0),
        cy + (NEIGHBORS[best + 1] ?? 0),
      );
    }
    columns.move[slot] = move | DETOUR;
  }
  // En détour : le champ de distances du camp de son groupe.
  counts.detours++;
  const group = state.society.groups.get(columns.group[slot] ?? NONE);
  if (group === undefined) return false;
  const field = campField(state, content, group);
  const value = field.valueAt(((cx % width) + width) % width, cy);
  if (value === 0) {
    // Au camp, d'où la place est en vue du centre : il gagne le centre, si ce n'est fait.
    if (ax === centerOf(cx) && ay === centerOf(cy)) return false;
    return legTo(state, content, slot, centerOf(cx), centerOf(cy));
  }
  let best = -1;
  let bestValue = value;
  for (let k = 0; k < 16; k += 2) {
    const ox = NEIGHBORS[k] ?? 0;
    const oy = NEIGHBORS[k + 1] ?? 0;
    const nx = cx + ox;
    const ny = cy + oy;
    if (!passable(nx, ny)) continue;
    if (ox !== 0 && oy !== 0 && (!passable(cx + ox, cy) || !passable(cx, cy + oy))) continue;
    const next = field.valueAt(((nx % width) + width) % width, ny);
    if (next < bestValue) {
      best = k;
      bestValue = next;
    }
  }
  if (best < 0) return false;
  return legToward(
    state,
    content,
    slot,
    cx + (NEIGHBORS[best] ?? 0),
    cy + (NEIGHBORS[best + 1] ?? 0),
  );
}

/** Champ de distances du camp de `group`, calculé à la première demande du mois. */
function campField(state: SimState, content: SimContent, group: Group): CampField {
  const movement = state.movement;
  const { width, height } = state.size;
  const camp = group.campY * width + group.campX;
  let field = movement.fields.get(camp);
  if (field === undefined) {
    field = new CampField(state.cost, width, height, camp, content.nomads.camp.field);
    movement.fields.set(camp, field);
    movement.counts.fields++;
  }
  return field;
}

/** Tampons de l'espacement, repris d'un jour à l'autre : ils ne gardent rien. */
let spaceSlots = new Int32Array(0);
let spaceX = new Float64Array(0);
let spaceY = new Float64Array(0);
let spaceStepX = new Float64Array(0);
let spaceStepY = new Float64Array(0);
let spaceOrder = new Int32Array(0);
let spaceBest = new Float64Array(0);
let spaceNeighbor = new Int32Array(0);
let groupStarts = new Int32Array(0);

/**
 * Espacement des marcheurs (ADR 0014), un jour sur `walkers.every` : dans chaque groupe, le
 * second d'une paire de marcheurs à moins de `walkers.gap` case, par emplacements, qui le
 * seraient encore le lendemain à leurs pas du jour, s'écarte de côté de son plus proche voisin
 * qui le précède, perpendiculairement à son pas, si le segment du jour, depuis sa position de
 * la veille, reste libre ; il recalcule son étape le lendemain. Deux marcheurs qui se croisent
 * s'éloignent d'eux-mêmes, et ne s'écartent pas. Les marcheurs d'un groupe se rangent par
 * abscisse, déroulée depuis le premier d'entre eux, et ne se comparent qu'à ceux qui en sont à
 * moins de `gap` : les marches qui durent côte à côte sont celles d'un même groupe, et deux
 * groupes ne font que se croiser.
 * Tous décident d'après les positions du jour, puis s'écartent ensemble : l'ordre des
 * marcheurs n'y change rien.
 */
function spaceWalkers(state: SimState, content: SimContent, day: number): void {
  const movement = state.movement;
  const { columns } = state.people;
  const { x, y, stepX, stepY, id, group } = columns;
  const { width, height } = state.size;
  const { gap, aside } = content.nomads.walkers;
  const { active, walking } = movement;
  // Les marcheurs de chaque groupe, rangés ensemble, par emplacements croissants.
  const groups = state.society.nextGroupId + 1;
  if (groupStarts.length < groups + 1) groupStarts = new Int32Array(2 * groups + 1);
  groupStarts.fill(0, 0, groups + 1);
  let count = 0;
  for (let index = 0; index < movement.activeCount; index++) {
    const slot = active[index] ?? 0;
    if (walking[slot] !== 1 || movement.arriving(slot, day)) continue;
    groupStarts[(group[slot] ?? 0) + 1] = (groupStarts[(group[slot] ?? 0) + 1] ?? 0) + 1;
    count++;
  }
  if (count < 2) return;
  if (spaceSlots.length < count) {
    spaceSlots = new Int32Array(2 * count);
    spaceX = new Float64Array(2 * count);
    spaceY = new Float64Array(2 * count);
    spaceStepX = new Float64Array(2 * count);
    spaceStepY = new Float64Array(2 * count);
    spaceOrder = new Int32Array(2 * count);
    spaceBest = new Float64Array(2 * count);
    spaceNeighbor = new Int32Array(2 * count);
  }
  for (let g = 1; g <= groups; g++)
    groupStarts[g] = (groupStarts[g] ?? 0) + (groupStarts[g - 1] ?? 0);
  const fill = groupStarts.slice(0, groups + 1);
  for (let index = 0; index < movement.activeCount; index++) {
    const slot = active[index] ?? 0;
    if (walking[slot] !== 1 || movement.arriving(slot, day)) continue;
    const at = fill[group[slot] ?? 0] ?? 0;
    fill[group[slot] ?? 0] = at + 1;
    spaceSlots[at] = slot;
  }
  const reach = gap * gap;
  const span = width * FIXED;
  const moves: number[] = [];
  for (let g = 0; g < groups; g++) {
    const first = groupStarts[g] ?? 0;
    const last = groupStarts[g + 1] ?? 0;
    if (last - first < 2) continue;
    // Abscisses déroulées depuis le premier du groupe, en cases ; tri par insertion.
    const x0 = x[spaceSlots[first] ?? 0] ?? 0;
    for (let at = first; at < last; at++) {
      const slot = spaceSlots[at] ?? 0;
      let dx = ((x[slot] ?? 0) - x0) % span;
      if (dx < -span / 2) dx += span;
      else if (dx >= span / 2) dx -= span;
      spaceX[at] = dx / FIXED;
      spaceY[at] = (y[slot] ?? 0) / FIXED;
      spaceStepX[at] = (stepX[slot] ?? 0) / FIXED;
      spaceStepY[at] = (stepY[slot] ?? 0) / FIXED;
      spaceBest[at] = reach;
      spaceNeighbor[at] = NO;
      let k = at;
      while (k > first && (spaceX[spaceOrder[k - 1] ?? 0] ?? 0) > (spaceX[at] ?? 0)) {
        spaceOrder[k] = spaceOrder[k - 1] ?? 0;
        k--;
      }
      spaceOrder[k] = at;
    }
    // Les paires à moins de `gap` : le plus proche voisin qui précède chacun.
    for (let i = first; i < last; i++) {
      const a = spaceOrder[i] ?? 0;
      const ax = spaceX[a] ?? 0;
      const ay = spaceY[a] ?? 0;
      for (let j = i + 1; j < last; j++) {
        const b = spaceOrder[j] ?? 0;
        const dx = (spaceX[b] ?? 0) - ax;
        if (dx >= gap) break;
        const dy = (spaceY[b] ?? 0) - ay;
        const squared = dx * dx + dy * dy;
        if (squared >= reach) continue;
        // Deux marcheurs qui se croisent s'éloignent d'eux-mêmes : seuls ceux qui seraient
        // encore trop près le lendemain, à leurs pas du jour, s'écartent.
        const tx = dx + (spaceStepX[b] ?? 0) - (spaceStepX[a] ?? 0);
        const ty = dy + (spaceStepY[b] ?? 0) - (spaceStepY[a] ?? 0);
        if (tx * tx + ty * ty >= reach) continue;
        // Le second de la paire, par emplacements, garde le plus proche ; à égalité, le
        // premier par emplacements.
        const sa = spaceSlots[a] ?? 0;
        const sb = spaceSlots[b] ?? 0;
        const later = sa < sb ? b : a;
        const earlier = sa < sb ? sa : sb;
        const best = spaceBest[later] ?? reach;
        const known = spaceNeighbor[later] ?? NO;
        if (
          squared < best ||
          (squared === best && known >= 0 && earlier < (spaceSlots[known] ?? 0))
        ) {
          spaceBest[later] = squared;
          spaceNeighbor[later] = sa < sb ? a : b;
        }
      }
    }
    for (let at = first; at < last; at++) {
      const neighbor = spaceNeighbor[at] ?? NO;
      if (neighbor < 0) continue;
      const slot = spaceSlots[at] ?? 0;
      // De côté, perpendiculairement au pas, à l'opposé du voisin.
      const sx = (stepX[slot] ?? 0) / FIXED;
      const sy = (stepY[slot] ?? 0) / FIXED;
      const norm = Math.sqrt(sx * sx + sy * sy);
      if (norm === 0) continue;
      const ox = (spaceX[at] ?? 0) - (spaceX[neighbor] ?? 0);
      const oy = (spaceY[at] ?? 0) - (spaceY[neighbor] ?? 0);
      const cross = sx * oy - sy * ox;
      const side = cross > 0 ? 1 : cross < 0 ? -1 : carriedSide(id[slot] ?? 0);
      const lateral = Math.abs(cross) / norm;
      const distance = Math.min(aside, Math.max(0.05, gap - lateral));
      // La perpendiculaire (−sy, sx), orientée du côté choisi.
      const px = x[slot] ?? 0;
      const py = y[slot] ?? 0;
      const qx = wrapFixedX(px + Math.round((-sy / norm) * side * distance * FIXED), width);
      const qy = py + Math.round((sx / norm) * side * distance * FIXED);
      moves.push(slot, qx, qy);
    }
  }
  for (let index = 0; index < moves.length; index += 3) {
    const slot = moves[index] ?? 0;
    const qx = moves[index + 1] ?? 0;
    const qy = moves[index + 2] ?? 0;
    const fromX = movement.prevX[slot] ?? 0;
    const fromY = movement.prevY[slot] ?? 0;
    if (qy < 0 || qy >= height * FIXED || !segmentClear(state, fromX, fromY, qx, qy)) continue;
    x[slot] = qx;
    y[slot] = qy;
    columns.stepDays[slot] = 0;
    follow(state, slot);
    movement.counts.asides++;
    movement.counts.legs++;
    // Un écart de côté est une étape d'un jour, partie de la position de la veille.
    movement.journal?.push(slot, day, fromX, fromY, deltaFixedX(fromX, qx, width), qy - fromY, 1);
  }
}

/**
 * Les arrivées du jour, par emplacements croissants (ADR 0014) : chacun se pose à sa place si
 * personne n'en tient une à moins de `camp.gap` case ; sinon, il en tire une autre autour
 * d'elle, et s'y rend, pour s'y poser quoi qu'il trouve.
 */
function arrive(state: SimState, content: SimContent, arrivals: readonly number[]): void {
  if (arrivals.length === 0) return;
  const movement = state.movement;
  const { columns } = state.people;
  const { gap } = content.nomads.camp;
  let random: RandomStream | undefined;
  for (const slot of arrivals) {
    const x = columns.x[slot] ?? 0;
    const y = columns.y[slot] ?? 0;
    const move = columns.move[slot] ?? 0;
    movement.counts.arrivals++;
    const room = movement.nearestHeld(x, y, gap, slot);
    if ((move & SETTLE) !== 0 || room >= gap) {
      if (room < gap) movement.counts.forced++;
      settle(state, slot);
      continue;
    }
    // Sa place est prise : une autre, autour d'elle. Deux reprises au plus : la première
    // (RETRY), puis la dernière, où il se pose quoi qu'il trouve (SETTLE).
    movement.counts.retaken++;
    random ??= state.rng.stream('sim.camp');
    const group = state.society.groups.get(columns.group[slot] ?? NONE);
    const cx = group === undefined ? x : group.campX * FIXED + FIXED / 2;
    const cy = group === undefined ? y : group.campY * FIXED + FIXED / 2;
    const { x: gx, y: gy } = pickPlace(
      state,
      columns.goalX[slot] ?? x,
      columns.goalY[slot] ?? y,
      content.nomads.camp.kin[0] + content.nomads.camp.kin[1] / 2,
      cx,
      cy,
      gap,
      slot,
      random,
    );
    columns.goalX[slot] = gx;
    columns.goalY[slot] = gy;
    columns.move[slot] = (move & RETRY) !== 0 ? move | SETTLE : move | RETRY;
    columns.stepDays[slot] = 0;
    movement.hold(slot, gx, gy);
    if (near(state, x, y, gx, gy)) settle(state, slot);
  }
}

// --- Caches.

/**
 * Refait tous les caches du mouvement d'après l'état (ADR 0014) : au chargement, après chaque
 * pas mensuel et après les commandes, ou après une exception. Les champs de distances restent,
 * leurs valeurs ne dépendant que du terrain : seul le pinceau les vide (clearFields).
 */
export function rebuildMovement(state: SimState): void {
  const movement = state.movement;
  const { people } = state;
  movement.ensure(people.columns.id.length);
  movement.clear();
  findGuides(state, movement.guides, movement.sizes);
  const { alive, end } = people;
  const { move, x, y, goalX, goalY, depart, group, mother } = people.columns;
  for (let slot = 0; slot < end; slot++) {
    if (alive[slot] !== 1) continue;
    const intention = (move[slot] ?? 0) & INTENTION;
    switch (intention) {
      case REST:
        movement.hold(slot, x[slot] ?? 0, y[slot] ?? 0);
        break;
      case LEAVE:
        movement.hold(slot, x[slot] ?? 0, y[slot] ?? 0, true);
        movement.leaving[depart[slot] ?? 0]?.push(slot);
        break;
      case WALK:
        movement.hold(slot, goalX[slot] ?? 0, goalY[slot] ?? 0);
        movement.addActive(slot);
        break;
      case CARRIED: {
        const carrier = people.slotOf(mother[slot] ?? NONE);
        if (walksIn(people, carrier, group[slot] ?? NONE)) movement.carry(slot, carrier);
        break;
      }
    }
  }
}

/** Vide les champs de distances : le coût d'une case a changé (pinceau). */
export function clearFields(state: SimState): void {
  state.movement.fields.clear();
  state.movement.openings.clear();
}

/**
 * Description des caches, pour les tests : chacun dans une liste au plus, aucune place tenue
 * sans raison. Deux caches égaux donnent la même description, quel que soit l'ordre de leurs
 * listes. Renvoie aussi les défauts de structure trouvés (listes qui bouclent, doublons).
 */
export function describeMovement(state: SimState): {
  readonly text: string;
  readonly problems: string[];
} {
  const movement = state.movement;
  const { end } = state.people;
  const problems: string[] = [];
  const active = new Set<number>();
  const listed = new Set<number>();
  for (let index = 0; index < movement.activeCount; index++) {
    const slot = movement.active[index] ?? 0;
    if (listed.has(slot)) problems.push(`marcheur ${String(slot)} en double`);
    listed.add(slot);
    if (movement.walking[slot] === 1) active.add(slot);
    else if (movement.walking[slot] !== 2) problems.push(`marcheur ${String(slot)} sans marque`);
  }
  for (let slot = 0; slot < movement.walking.length; slot++) {
    if (movement.walking[slot] !== 0 && !listed.has(slot)) {
      problems.push(`marcheur ${String(slot)} marqué hors de la liste`);
    }
  }
  const lists = (head: Int32Array, next: Int32Array, cellOfSlot: Int32Array, name: string) => {
    const seen = new Map<number, number>();
    for (let cell = 0; cell < head.length; cell++) {
      let steps = 0;
      for (let slot = head[cell] ?? NO; slot >= 0; slot = next[slot] ?? NO) {
        if (++steps > end + 1) {
          problems.push(`${name} : la case ${String(cell)} boucle`);
          break;
        }
        if (seen.has(slot)) problems.push(`${name} : ${String(slot)} en double`);
        if (cellOfSlot[slot] !== cell) problems.push(`${name} : case de ${String(slot)}`);
        seen.set(slot, cell);
      }
    }
    return seen;
  };
  const next = new Int32Array(movement.restCell.length);
  for (let slot = 0; slot < next.length; slot++)
    next[slot] = movement.rest[slot * REST_STRIDE + 2] ?? NO;
  const rest = lists(movement.restHead, next, movement.restCell, 'places');
  const parts: string[] = [];
  parts.push(`actifs ${[...active].sort((a, b) => a - b).join(',')}`);
  movement.leaving.forEach((list, day) => {
    if (list.length > 0)
      parts.push(`jour ${String(day)} : ${[...list].sort((a, b) => a - b).join(',')}`);
  });
  parts.push(
    `places ${[...rest]
      .sort((a, b) => a[0] - b[0])
      .map(
        ([slot, cell]) =>
          `${String(slot)}@${String(cell)}:${String(movement.rest[slot * REST_STRIDE])},${String(movement.rest[slot * REST_STRIDE + 1])}/${String(movement.rest[slot * REST_STRIDE + 3])}`,
      )
      .join(' ')}`,
  );
  const carried: string[] = [];
  for (let slot = 0; slot < end; slot++) {
    const mother = movement.carrier[slot] ?? NO;
    if (mother >= 0) carried.push(`${String(slot)}<${String(mother)}`);
  }
  parts.push(`portés ${carried.join(' ')}`);
  parts.push(
    `guides ${[...movement.guides]
      .sort((a, b) => a[0] - b[0])
      .map(([g, s]) => `${String(g)}:${String(s)}`)
      .join(' ')}`,
  );
  return { text: parts.join('\n'), problems };
}

// --- Le pas mensuel.

/**
 * Relevé des groupes au début du pas mensuel (ADR 0014) : l'identifiant et le groupe de chaque
 * emplacement, et le camp de chaque groupe. Il ne sert que le temps du pas : le plan du mois
 * y voit qui a changé de groupe, et quel camp a changé, sans rien garder dans l'état. Un
 * emplacement qu'une naissance a repris d'un mort porte un autre identifiant : ce n'est pas un
 * changement de groupe.
 */
export interface GroupRecord {
  readonly ids: Uint32Array;
  readonly groups: Uint32Array;
  readonly camps: ReadonlyMap<number, number>;
}

export function recordGroups(state: SimState): GroupRecord {
  const { people, society } = state;
  const { alive, end } = people;
  const { id, group } = people.columns;
  const ids = new Uint32Array(end);
  const groups = new Uint32Array(end);
  for (let slot = 0; slot < end; slot++) {
    if (alive[slot] !== 1) continue;
    ids[slot] = id[slot] ?? 0;
    groups[slot] = group[slot] ?? NONE;
  }
  const camps = new Map<number, number>();
  for (const entry of society.groups.values()) {
    camps.set(entry.id, entry.campY * state.size.width + entry.campX);
  }
  return { ids, groups, camps };
}

/** `slot` a-t-il changé de groupe depuis le relevé ? */
function changedGroup(state: SimState, record: GroupRecord, slot: number): boolean {
  const { id, group } = state.people.columns;
  return (
    slot < record.ids.length && record.ids[slot] === id[slot] && record.groups[slot] !== group[slot]
  );
}

/**
 * Le guide de `group` attend-il, ce mois-ci, plutôt que de lever le camp (ADR 0014) ? Oui
 * tant qu'un membre venu d'un autre groupe, ce mois-ci ou en marche depuis, se tient à plus
 * de `camp.wait` cases du camp : le groupe l'attend.
 */
export function waiting(
  state: SimState,
  content: SimContent,
  group: Group,
  members: readonly number[],
  record: GroupRecord,
): boolean {
  const { width } = state.size;
  const { move, x, y } = state.people.columns;
  const limit = content.nomads.camp.wait;
  const cx = group.campX * FIXED + FIXED / 2;
  const cy = group.campY * FIXED + FIXED / 2;
  for (const slot of members) {
    const intention = (move[slot] ?? 0) & INTENTION;
    if (intention === CARRIED) continue;
    const joining =
      changedGroup(state, record, slot) ||
      (((move[slot] ?? 0) & JOIN) !== 0 && (intention === WALK || intention === LEAVE));
    if (!joining) continue;
    const dx = deltaFixedX(cx, x[slot] ?? 0, width) / FIXED;
    const dy = ((y[slot] ?? 0) - cy) / FIXED;
    if (dx * dx + dy * dy > limit * limit) return true;
  }
  return false;
}

/** Les mouvements du mois qui vient : qui part, et pourquoi. */
const STAY = 0;
const MOVE = 1;
const JOINS = 2;

/**
 * Plan du mois (ADR 0014), à la fin du pas mensuel, sur `sim.camp` : les sevrages, puis qui
 * part (le groupe a changé de camp, ou le membre a changé de groupe), et le jour où il part.
 * Le guide part le jour 0, comme qui rejoint un autre groupe ou marchait déjà ; les autres, le
 * jour ⌊lag × (1 − g') × u⌋, et jamais avant leur ancre. Les places se tirent au départ.
 * Qui marche encore, dans un groupe resté sur place, continue, et presse le pas.
 */
export function planMonth(
  state: SimState,
  content: SimContent,
  record: GroupRecord,
  members: ReadonlyMap<number, readonly number[]>,
): void {
  rebuildMovement(state);
  clearFields(state);
  const movement = state.movement;
  const { people, society } = state;
  const { end } = people;
  const { columns } = people;
  const { move, x, y, id } = columns;
  const { width } = state.size;
  const plan = new Uint8Array(end);
  // Qui part.
  for (const group of society.groups.values()) {
    const moved = record.camps.get(group.id) !== group.campY * width + group.campX;
    for (const slot of members.get(group.id) ?? []) {
      const intention = (move[slot] ?? 0) & INTENTION;
      if (intention === CARRIED) continue;
      if (changedGroup(state, record, slot)) plan[slot] = JOINS;
      else if (moved) plan[slot] = MOVE;
      else if (intention === WALK) move[slot] = (move[slot] ?? 0) | LATE;
    }
  }
  // Les sevrages : le nourrisson trop grand, ou sans sa mère dans son groupe.
  const { wean } = content.nomads.camp;
  for (let slot = 0; slot < end; slot++) {
    if (people.alive[slot] !== 1 || ((move[slot] ?? 0) & INTENTION) !== CARRIED) continue;
    const species = content.species.entries.at(columns.species[slot] ?? 0);
    const mother = movement.carrier[slot] ?? NO;
    if (mother >= 0 && species !== undefined && yearsOf(state, slot) < species.ages.baby) continue;
    movement.uncarry(slot);
    const sx = x[slot] ?? 0;
    const sy = y[slot] ?? 0;
    move[slot] = REST;
    columns.goalX[slot] = sx;
    columns.goalY[slot] = sy;
    columns.stepDays[slot] = 0;
    if (mother < 0) {
      // Orphelin : il se pose là où sa mère se tenait, et part avec son groupe.
      movement.hold(slot, sx, sy);
      const group = society.groups.get(columns.group[slot] ?? NONE);
      if (group !== undefined && record.camps.get(group.id) !== group.campY * width + group.campX) {
        plan[slot] = MOVE;
      }
      continue;
    }
    // La position où on le dessinait, contre sa mère, du côté que dit son identifiant.
    const side = carriedSide(id[slot] ?? 0);
    const reach = (species?.display.carry ?? 0) * FIXED;
    const mx = x[mother] ?? 0;
    const my = y[mother] ?? 0;
    const drawnX = wrapFixedX(mx + Math.round(side * reach), width);
    const fromDrawn = passableAt(state, drawnX, my) && segmentClear(state, mx, my, drawnX, my);
    const startX = fromDrawn ? drawnX : mx;
    x[slot] = startX;
    y[slot] = my;
    columns.goalX[slot] = startX;
    columns.goalY[slot] = my;
    const motherWalks = ((move[mother] ?? 0) & INTENTION) === WALK;
    if (plan[mother] !== STAY || motherWalks || plan[slot] !== STAY) {
      // Sa mère part, ou marche : il part avec elle, et prendra sa place près de la sienne.
      movement.hold(slot, startX, my);
      plan[slot] = MOVE;
      continue;
    }
    // Sa mère se repose : une étape d'un jour, le jour 0, jusqu'à sa place, près d'elle.
    movement.counts.weaned++;
    const targetX = wrapFixedX(mx + Math.round(side * wean * FIXED), width);
    if (passableAt(state, targetX, my) && segmentClear(state, startX, my, targetX, my)) {
      move[slot] = WALK | SETTLE;
      columns.goalX[slot] = targetX;
      movement.hold(slot, targetX, my);
      movement.addActive(slot);
    } else {
      movement.hold(slot, startX, my);
    }
  }
  // Les jours de départ : un tirage par partant, dans l'ordre des emplacements.
  const random = state.rng.stream('sim.camp');
  const { lag } = content.nomads.camp;
  const days = new Int8Array(end).fill(-1);
  const lags = new Uint8Array(end);
  for (let slot = 0; slot < end; slot++) {
    if (plan[slot] === STAY) continue;
    const u = random.nextFloat();
    const group = columns.group[slot] ?? NONE;
    const walking = ((move[slot] ?? 0) & INTENTION) === WALK;
    const late = plan[slot] === JOINS || walking || movement.guides.get(group) === slot;
    lags[slot] = late
      ? 0
      : Math.floor(lag * (1 - effectiveGregariousness(state, content, slot)) * u);
  }
  const dayOf = (slot: number): number => {
    const known = days[slot] ?? -1;
    if (known >= 0) return known;
    days[slot] = lags[slot] ?? 0;
    const anchor = anchorOf(state, content, slot);
    const after = anchor >= 0 && plan[anchor] !== STAY ? dayOf(anchor) : 0;
    const day = Math.min(DAYS_PER_MONTH - 1, Math.max(lags[slot] ?? 0, after));
    days[slot] = day;
    return day;
  };
  for (let slot = 0; slot < end; slot++) {
    if (plan[slot] === STAY) continue;
    const day = dayOf(slot);
    const before = move[slot] ?? 0;
    if ((before & INTENTION) === WALK) movement.removeActive(slot);
    const late = (before & INTENTION) === WALK ? LATE : 0;
    const join = plan[slot] === JOINS ? JOIN : before & JOIN;
    move[slot] = LEAVE | late | join;
    columns.depart[slot] = day;
    columns.goalX[slot] = x[slot] ?? 0;
    columns.goalY[slot] = y[slot] ?? 0;
    columns.stepDays[slot] = 0;
    movement.hold(slot, x[slot] ?? 0, y[slot] ?? 0, true);
    movement.leaving[day]?.push(slot);
  }
}

// --- Apparitions et relectures.

/** Ce que l'on sait d'un membre d'un groupe qui apparaît, avant son entrée dans la population. */
export interface PlannedMember {
  readonly birth: number;
  readonly species: number;
  /** Conjoint et mère, par leur rang dans le plan ; −1 s'il n'y en a pas. */
  readonly partner: number;
  readonly mother: number;
  readonly gregariousness: number;
}

/**
 * Places d'un groupe qui apparaît sur la case `camp` (ADR 0014), sur `random` : le guide, l'aîné,
 * près du centre de la case ; chaque chef de foyer autour de lui ; les autres autour de leur
 * conjoint ou de leur mère ; un nourrisson, porté, à la position de sa mère. Rien ne change
 * dans l'état : l'apparition pose ensuite ses membres d'un bloc.
 */
export function placeGroup(
  state: SimState,
  content: SimContent,
  planned: readonly PlannedMember[],
  camp: { readonly x: number; readonly y: number },
  random: RandomStream,
): { readonly x: number[]; readonly y: number[]; readonly carried: boolean[] } {
  const { camp: settings } = content.nomads;
  const cx = camp.x * FIXED + FIXED / 2;
  const cy = camp.y * FIXED + FIXED / 2;
  let guide = 0;
  planned.forEach((member, index) => {
    if (member.birth < (planned[guide]?.birth ?? 0)) guide = index;
  });
  const placed = { x: [] as number[], y: [] as number[] };
  const xs = new Array<number>(planned.length).fill(cx);
  const ys = new Array<number>(planned.length).fill(cy);
  const carried = planned.map((member) => {
    const species = content.species.entries.at(member.species);
    const years = (state.tick - member.birth) / MONTHS_PER_YEAR;
    return member.mother >= 0 && species !== undefined && years < species.ages.baby;
  });
  const done = new Uint8Array(planned.length);
  const place = (index: number): void => {
    if (done[index] === 1) return;
    done[index] = 1;
    const member = planned[index];
    if (carried[index]) {
      place(member.mother);
      xs[index] = xs[member.mother] ?? cx;
      ys[index] = ys[member.mother] ?? cy;
      return;
    }
    const g = 1 - (1 - member.gregariousness / 255) * (1 - settings.cohesion);
    let anchor = guide;
    let radius =
      (settings.band[0] + settings.band[1] * (1 - g)) *
      Math.max(1, settings.spread * Math.sqrt(planned.length));
    if (index === guide) {
      anchor = CAMP;
      radius = settings.guide;
    } else if (member.partner >= 0 && member.partner < index) {
      anchor = member.partner;
      radius = settings.kin[0] + settings.kin[1] * (1 - g);
    } else if (member.mother >= 0) {
      anchor = member.mother;
      radius = settings.kin[0] + settings.kin[1] * (1 - g);
    }
    if (anchor >= 0) place(anchor);
    const ax = anchor >= 0 ? (xs[anchor] ?? cx) : cx;
    const ay = anchor >= 0 ? (ys[anchor] ?? cy) : cy;
    const { x: px, y: py } = pickPlace(
      state,
      ax,
      ay,
      radius,
      cx,
      cy,
      settings.gap,
      NO,
      random,
      placed,
    );
    xs[index] = px;
    ys[index] = py;
    placed.x.push(px);
    placed.y.push(py);
  };
  place(guide);
  for (let index = 0; index < planned.length; index++) place(index);
  return { x: xs, y: ys, carried };
}

/**
 * Pose les membres d'une partie de la version 6, que la migration a mis « à poser » (PLACE) à
 * la position du jour de leur groupe (ADR 0014) : un nourrisson dont la mère vit dans son
 * groupe est porté ; les autres partent le jour même vers une place au camp de leur groupe.
 */
export function placeMigrated(state: SimState, content: Pick<SimContent, 'species'>): void {
  const { people } = state;
  const { move, mother, group, species, depart } = people.columns;
  for (let slot = 0; slot < people.end; slot++) {
    if (people.alive[slot] !== 1 || ((move[slot] ?? 0) & INTENTION) !== PLACE) continue;
    const kind = content.species.entries.at(species[slot] ?? 0);
    const parent = people.slotOf(mother[slot] ?? NONE);
    const baby = kind !== undefined && yearsOf(state, slot) < kind.ages.baby;
    const withMother =
      parent !== undefined && people.alive[parent] === 1 && group[parent] === group[slot];
    if (
      baby &&
      withMother &&
      (people.columns.birth[parent] ?? 0) < (people.columns.birth[slot] ?? 0)
    ) {
      move[slot] = CARRIED;
    } else {
      move[slot] = LEAVE;
      depart[slot] = state.day;
    }
  }
  rebuildMovement(state);
}
