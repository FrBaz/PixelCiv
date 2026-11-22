/**
 * Caches des activités (tâche 2b.8, ADR 0021) : l'agenda des choix, la grille des lieux d'activité
 * occupés, et ce que le jour en garde. Ils se déduisent de l'état (activities.ts,
 * rebuildActivities) : ni la sauvegarde ni l'empreinte n'en tiennent compte, et ce qu'en tire le
 * sous-pas ne dépend pas de l'ordre de leurs listes.
 */
import { FIXED } from '../core/position';

/** Aucun emplacement. */
const NO = -1;

/**
 * Jours de l'anneau de l'agenda : le choix d'un vivant tombe moins de AGENDA_DAYS jours après
 * l'instant de la partie (la sauvegarde le vérifie, MAX_UNTIL_AHEAD).
 */
export const AGENDA_DAYS = 1024;
const AGENDA_MASK = AGENDA_DAYS - 1;

/** Tableau d'entiers agrandi à `length` au moins, contenu gardé, reste rempli de `fill`. */
function grown(
  array: Int32Array<ArrayBuffer>,
  length: number,
  fill: number,
): Int32Array<ArrayBuffer> {
  if (array.length >= length) return array;
  const next = new Int32Array(Math.max(length, array.length * 2, 64)).fill(fill);
  next.set(array);
  return next;
}

/**
 * Agenda des choix : chaque vivant dont le prochain choix est un jour `until` > 0 se range dans
 * la liste de ce jour, sur un anneau de AGENDA_DAYS jours, et dans aucune autre. Le jour venu, on
 * en prend les emplacements (take) ; l'ordre des listes ne compte pas : le sous-pas les range.
 */
export class Agenda {
  private readonly head = new Int32Array(AGENDA_DAYS).fill(NO);
  private next = new Int32Array(0);
  private prev = new Int32Array(0);
  /** Jour du choix de chaque emplacement de l'agenda, NO hors de lui. */
  private day = new Int32Array(0);

  ensure(capacity: number): void {
    this.next = grown(this.next, capacity, NO);
    this.prev = grown(this.prev, capacity, NO);
    this.day = grown(this.day, capacity, NO);
  }

  /**
   * `slot` choisit le jour `until`, s'il est positif ; sinon, il sort de l'agenda. Un emplacement
   * au-delà de la capacité l'agrandit : un vivant apparu avant le prochain ensure (spawnGroup appelé
   * hors d'applyCommands) ne décroche pas la liste de son jour.
   */
  set(slot: number, until: number): void {
    if (slot >= this.day.length) this.ensure(slot + 1);
    this.remove(slot);
    if (until <= 0) return;
    const bucket = until & AGENDA_MASK;
    const head = this.head[bucket] ?? NO;
    this.next[slot] = head;
    this.prev[slot] = NO;
    if (head >= 0) this.prev[head] = slot;
    this.head[bucket] = slot;
    this.day[slot] = until;
  }

  remove(slot: number): void {
    const day = this.day[slot] ?? NO;
    if (day === NO) return;
    const prev = this.prev[slot] ?? NO;
    const next = this.next[slot] ?? NO;
    if (prev >= 0) this.next[prev] = next;
    else this.head[day & AGENDA_MASK] = next;
    if (next >= 0) this.prev[next] = prev;
    this.day[slot] = NO;
    this.next[slot] = NO;
    this.prev[slot] = NO;
  }

  /** Jour du choix de `slot` dans l'agenda, NO s'il n'y est pas. */
  dayOf(slot: number): number {
    return this.day[slot] ?? NO;
  }

  /** Les emplacements qui choisissent le jour `day`, ôtés de l'agenda, ajoutés à `out`. */
  take(day: number, out: number[]): void {
    const bucket = day & AGENDA_MASK;
    for (let slot = this.head[bucket] ?? NO; slot >= 0;) {
      const next = this.next[slot] ?? NO;
      if (this.day[slot] === day) {
        out.push(slot);
        this.remove(slot);
      }
      slot = next;
    }
  }

  clear(): void {
    this.head.fill(NO);
    this.day.fill(NO);
    this.next.fill(NO);
    this.prev.fill(NO);
  }

  /** Les emplacements de l'agenda et leur jour, par emplacements croissants (pour les tests). */
  entries(): [slot: number, day: number][] {
    const list: [number, number][] = [];
    for (let slot = 0; slot < this.day.length; slot++) {
      const day = this.day[slot] ?? NO;
      if (day !== NO) list.push([slot, day]);
    }
    return list;
  }
}

/**
 * Lieux d'activité occupés : celui de chaque vivant parti à une activité hors de sa place au camp,
 * le but de qui y marche, la position de qui y est (activities.ts, spotOf). Une liste par case,
 * comme la grille des places tenues (movement.ts).
 */
export class SpotGrid {
  private readonly head: Int32Array;
  private x = new Int32Array(0);
  private y = new Int32Array(0);
  private next = new Int32Array(0);
  private prev = new Int32Array(0);
  /** Case du lieu de chaque emplacement, NO sans lieu. */
  private cell = new Int32Array(0);

  private readonly width: number;
  private readonly height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.head = new Int32Array(width * height).fill(NO);
  }

  ensure(capacity: number): void {
    this.x = grown(this.x, capacity, 0);
    this.y = grown(this.y, capacity, 0);
    this.next = grown(this.next, capacity, NO);
    this.prev = grown(this.prev, capacity, NO);
    this.cell = grown(this.cell, capacity, NO);
  }

  /**
   * Le lieu de `slot` est (x, y), en unités, x dans le monde. Un emplacement au-delà de la capacité
   * l'agrandit, comme Agenda.set.
   */
  set(slot: number, x: number, y: number): void {
    if (slot >= this.cell.length) this.ensure(slot + 1);
    this.release(slot);
    const row = Math.min(this.height - 1, Math.max(0, Math.floor(y / FIXED)));
    const column = Math.min(this.width - 1, Math.max(0, Math.floor(x / FIXED)));
    const cell = row * this.width + column;
    const head = this.head[cell] ?? NO;
    this.x[slot] = x;
    this.y[slot] = y;
    this.next[slot] = head;
    this.prev[slot] = NO;
    if (head >= 0) this.prev[head] = slot;
    this.head[cell] = slot;
    this.cell[slot] = cell;
  }

  release(slot: number): void {
    const cell = this.cell[slot] ?? NO;
    if (cell === NO) return;
    const prev = this.prev[slot] ?? NO;
    const next = this.next[slot] ?? NO;
    if (prev >= 0) this.next[prev] = next;
    else this.head[cell] = next;
    if (next >= 0) this.prev[next] = prev;
    this.cell[slot] = NO;
    this.next[slot] = NO;
    this.prev[slot] = NO;
  }

  has(slot: number): boolean {
    return (this.cell[slot] ?? NO) !== NO;
  }

  xOf(slot: number): number {
    return this.x[slot] ?? 0;
  }

  yOf(slot: number): number {
    return this.y[slot] ?? 0;
  }

  /**
   * Distance, en cases, de (x, y) au plus proche lieu occupé, hors de celui de `except`, bornée
   * par `limit` (< 1/2 : quatre cases au plus à lire), au plus court à travers la couture. Avec
   * `below`, la recherche s'arrête au premier lieu à moins de `below` case.
   */
  nearest(x: number, y: number, limit: number, except: number, below = 0): number {
    const { width, height } = this;
    const span = width * FIXED;
    const reach = limit * FIXED;
    const top = Math.max(0, Math.floor((y - reach) / FIXED));
    const bottom = Math.min(height - 1, Math.floor((y + reach) / FIXED));
    const left = Math.floor((x - reach) / FIXED);
    const right = Math.floor((x + reach) / FIXED);
    let best = limit * limit;
    for (let row = top; row <= bottom; row++) {
      for (let column = left; column <= right; column++) {
        const wrapped = ((column % width) + width) % width;
        if (column !== left && wrapped === ((left % width) + width) % width) continue;
        for (let slot = this.head[row * width + wrapped] ?? NO; slot >= 0;) {
          const next = this.next[slot] ?? NO;
          if (slot !== except) {
            let dx = ((this.x[slot] ?? 0) - x) % span;
            if (dx > span / 2) dx -= span;
            else if (dx < -span / 2) dx += span;
            const ex = dx / FIXED;
            const ey = ((this.y[slot] ?? 0) - y) / FIXED;
            const squared = ex * ex + ey * ey;
            if (squared < best) {
              best = squared;
              if (below > 0 && Math.sqrt(best) < below) return Math.sqrt(best);
            }
          }
          slot = next;
        }
      }
    }
    return Math.sqrt(best);
  }

  clear(): void {
    for (const cell of this.cell) if (cell !== NO) this.head[cell] = NO;
    this.cell.fill(NO);
    this.next.fill(NO);
    this.prev.fill(NO);
  }

  /** Les lieux occupés, par emplacements croissants (pour les tests). */
  entries(): [slot: number, x: number, y: number][] {
    const list: [number, number, number][] = [];
    for (let slot = 0; slot < this.cell.length; slot++) {
      if ((this.cell[slot] ?? NO) !== NO) list.push([slot, this.x[slot] ?? 0, this.y[slot] ?? 0]);
    }
    return list;
  }
}

/** Entiers par rive dans CampSupplies.shores : x et y en unités, axe du bord, case de l'eau. */
export const SHORE_STRIDE = 4;

/**
 * Saisons et rives d'un camp pour un mois : une fonction du monde, du contenu, de la case du camp
 * et du mois (activities.ts, campSupplies).
 */
export interface CampSupplies {
  /** Facteur de saison de chaque activité, par rang, à ce camp ce mois-ci ; 1 sans saison. */
  readonly factor: Float64Array;
  /**
   * Rives de chaque activité au bord de l'eau, par rang (undefined pour les autres) : SHORE_STRIDE
   * entiers par rive, le milieu du bord commun d'une eau et d'une case de terre, rentré dans la
   * terre ; l'axe du bord (0 : nord-sud, la rive se tire en y ; 1 : est-ouest, en x) ; la case de
   * l'eau. Des plus proches du centre du camp aux plus lointaines.
   */
  readonly shores: readonly (Int32Array | undefined)[];
}

/** Comptes des activités, pour les mesures et les tests : ils ne sont pas l'état. */
export interface ActivityCounts {
  decisions: number;
  trips: number;
  /** Choix de chaque rang d'activité. */
  readonly chosen: number[];
  /** Choix sans lieu libre, ou sans animal à portée, qui finissent au repos. */
  nospot: number;
  noprey: number;
  strikes: number;
  hits: number;
  misses: number;
  kills: number;
  /** Viande des prises, en besoins mensuels d'un adulte, versée aux réserves. */
  meat: number;
  lost: number;
  stops: number;
  /** Arrivées au camp au bout du suivi du groupe, qui choisissent ensuite. */
  arrivals: number;
}

/**
 * Caches des activités (ADR 0021) : l'agenda, les lieux occupés, les saisons et les rives de
 * chaque camp pour le mois, les goûts de chaque culture, le gibier du jour par tuiles et la proie
 * de chaque chasseur ce jour, les chasseurs qui frappent ce jour, les coups manqués que le gibier
 * entend le jour même. Tout se déduit de l'état, du monde, du contenu et de l'instant.
 */
export class ActivityCache {
  readonly agenda = new Agenda();
  readonly spots: SpotGrid;
  /**
   * Saisons et rives de chaque camp, par case du camp et mois de l'année, pour le contenu
   * `campsFor` : elles ne suivent que le monde, le contenu et le mois.
   */
  readonly camps = new Map<number, CampSupplies>();
  campsFor: object | undefined;
  /**
   * Eaux et cases où se tenir, une fois pour toutes (activities.ts, masksOf) : un bit par activité
   * au bord de l'eau pour chaque case qui est l'une de ses eaux, et 1 pour chaque case franchissable
   * sans rivière, dont aucune rivière ne coupe un coin. Le pinceau ne change ni l'eau, ni la
   * franchissabilité, ni les rivières : ils valent toute la partie, pour le contenu `masksFor`.
   */
  waterMask: Uint16Array | undefined;
  standMask: Uint8Array | undefined;
  masksFor: object | undefined;
  /**
   * Rives de chaque camp, par case du camp et rang de l'activité : elles ne suivent que le monde et
   * les réglages `shoresFor` (activités, camp).
   */
  readonly shores = new Map<number, Int32Array>();
  shoresFor: readonly [object, object] | undefined;
  /** Goûts et partages de chaque culture (fonctions pures de la graine et de la culture). */
  readonly tastes = new Map<number, Float64Array>();
  /** Liste des activités pour laquelle les goûts sont tirés. */
  tastesList: object | undefined;
  /** Le gibier du jour par tuiles de 8 × 8 cases, refait à la première demande d'un jour. */
  preyDay = NO;
  preyHead = new Int32Array(0);
  preyNext = new Int32Array(0);
  /** Proie de chaque chasseur ce jour : emplacement d'un humain → emplacement d'un animal. */
  readonly prey = new Map<number, number>();
  /** Chasseurs qui frappent ce jour (ACT_STRIKE de leurs étapes du jour). */
  readonly struck = new Set<number>();
  /**
   * Coups manqués du jour : l'animal visé et la position du chasseur, trois entiers par coup, par
   * emplacements croissants des chasseurs ; le gibier les entend le jour même (fauna.ts, faunaDay).
   */
  readonly misses: number[] = [];
  /** Emplacements qui choisissent ce jour, repris d'un jour à l'autre. */
  readonly due: number[] = [];
  /**
   * Arrivés au camp ce soir, que l'arrivée fait passer du suivi du groupe au repos : leur étape
   * part à la fin du jour (eveningLegs), après toutes celles du jour, pour que le fil principal
   * ait leur activité aux jours entiers. Tenu seulement quand un hôte lit les étapes (journal).
   */
  readonly settled: number[] = [];
  /**
   * Arrivés ce soir au lieu d'une activité au bord de l'eau : une étape de zéro jour, à l'instant
   * qui suit (activities.ts, shoreLegs), les tourne vers l'eau, pour le seul fil principal. Tenu
   * seulement quand un hôte lit les étapes ; vidé par shoreLegs, à la fin du jour, et non par
   * clear(), que le pas mensuel appelle avant elle.
   */
  readonly shoreArrivals: number[] = [];
  readonly counts: ActivityCounts = {
    decisions: 0,
    trips: 0,
    chosen: Array.from({ length: 16 }, () => 0),
    nospot: 0,
    noprey: 0,
    strikes: 0,
    hits: 0,
    misses: 0,
    kills: 0,
    meat: 0,
    lost: 0,
    stops: 0,
    arrivals: 0,
  };

  constructor(width: number, height: number) {
    this.spots = new SpotGrid(width, height);
  }

  ensure(capacity: number): void {
    this.agenda.ensure(capacity);
    this.spots.ensure(capacity);
  }

  /** Oublie l'agenda, les lieux et ce que le jour gardait (rebuildActivities les refait). */
  clear(): void {
    this.agenda.clear();
    this.spots.clear();
    this.prey.clear();
    this.struck.clear();
    this.misses.length = 0;
    this.settled.length = 0;
    this.preyDay = NO;
  }
}
