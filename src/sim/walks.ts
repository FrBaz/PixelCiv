/**
 * Marches des groupes, parcourues jour après jour (ADR 0013).
 *
 * - État : le pas mensuel décide la marche de chaque groupe (moveGroup, et splitGroup pour
 *   le nouveau groupe d'une scission), et walk la note case par case, avec le coût cumulé
 *   (Walks). Les marches du mois et le jour sont l'état : sauvegardés, et couverts par
 *   l'empreinte. Le mois suivant les parcourt à allure constante (src/core/walk.ts).
 * - Cache : la position du jour de chaque groupe s'en déduit exactement (DayPositions). Le
 *   worker la tient pour ses propres besoins, comme la fiche d'un groupe ; elle n'est ni
 *   sauvegardée ni dans l'empreinte, et le sous-pas n'y avance que les marches en cours.
 *
 * Une marche ne change pas l'état mensuel : group.x et group.y donnent toujours la case où
 * le groupe se tient au pas mensuel, au bout de sa marche, et aucun calcul mensuel ne lit
 * la position du jour.
 */
import { walking, walkPosition, type WalkData } from '../core/walk';
import type { Group } from './society';

/** Ce que walk note de sa marche : chaque pas, sa case et le coût dépensé depuis le départ. */
export interface WalkRecorder {
  step(cell: number, spent: number): void;
}

/** Tableau agrandi au double s'il ne tient pas `needed` éléments, contenu gardé. */
function grownUint32(array: Uint32Array<ArrayBuffer>, needed: number): Uint32Array<ArrayBuffer> {
  if (needed <= array.length) return array;
  const next = new Uint32Array(Math.max(needed, array.length * 2));
  next.set(array);
  return next;
}

function grownFloat64(array: Float64Array<ArrayBuffer>, needed: number): Float64Array<ArrayBuffer> {
  if (needed <= array.length) return array;
  const next = new Float64Array(Math.max(needed, array.length * 2));
  next.set(array);
  return next;
}

/** Copies au plus juste des marches, prêtes à sauvegarder, à comparer ou à transférer. */
export interface WalkArrays extends WalkData {
  readonly groups: Uint32Array<ArrayBuffer>;
  readonly ends: Uint32Array<ArrayBuffer>;
  readonly cells: Uint32Array<ArrayBuffer>;
  readonly costs: Float64Array<ArrayBuffer>;
  readonly budgets: Float64Array<ArrayBuffer>;
}

/**
 * Marches du mois en cours, en tableaux typés qui grandissent au besoin : `count` marches,
 * `length` cases de chemin. Une marche se note par begin, les pas de walk (step), puis
 * end ; une marche sans pas, d'un groupe resté sur sa case, ne se garde pas.
 */
export class Walks implements WalkData, WalkRecorder {
  groups = new Uint32Array(64);
  ends = new Uint32Array(64);
  budgets = new Float64Array(64);
  cells = new Uint32Array(512);
  costs = new Float64Array(512);
  /** Nombre de marches gardées, et de cases de leurs chemins. */
  count = 0;
  length = 0;
  /** Marche en cours de notation : son groupe, son budget et le début de son chemin. */
  private group = -1;
  private budget = 0;
  private start = 0;

  /** Oublie toutes les marches : celles du mois passé sont finies. */
  clear(): void {
    this.count = 0;
    this.length = 0;
    this.group = -1;
  }

  /** Commence la marche du groupe `group`, partie de la case `cell`, de budget `budget`. */
  begin(group: number, cell: number, budget: number): void {
    this.group = group;
    this.budget = budget;
    this.start = this.length;
    this.point(cell, 0);
  }

  /** Un pas de walk : la case atteinte, et le coût dépensé depuis le départ. */
  step(cell: number, spent: number): void {
    if (this.group >= 0) this.point(cell, spent);
  }

  /** Clôt la marche commencée ; sans pas, elle s'oublie. */
  end(): void {
    if (this.group < 0) return;
    if (this.length - this.start < 2) {
      this.length = this.start;
    } else {
      const index = this.count++;
      this.groups = grownUint32(this.groups, this.count);
      this.ends = grownUint32(this.ends, this.count);
      this.budgets = grownFloat64(this.budgets, this.count);
      this.groups[index] = this.group;
      this.ends[index] = this.length;
      this.budgets[index] = this.budget;
    }
    this.group = -1;
  }

  private point(cell: number, cost: number): void {
    const index = this.length++;
    this.cells = grownUint32(this.cells, this.length);
    this.costs = grownFloat64(this.costs, this.length);
    this.cells[index] = cell;
    this.costs[index] = cost;
  }

  /** Copies au plus juste des marches gardées. */
  arrays(): WalkArrays {
    return {
      groups: this.groups.slice(0, this.count),
      ends: this.ends.slice(0, this.count),
      cells: this.cells.slice(0, this.length),
      costs: this.costs.slice(0, this.length),
      budgets: this.budgets.slice(0, this.count),
    };
  }

  /** Marches relues d'une sauvegarde, déjà vérifiées : elles remplacent les marches gardées. */
  restore(data: WalkData): void {
    this.clear();
    this.groups = Uint32Array.from(data.groups);
    this.ends = Uint32Array.from(data.ends);
    this.budgets = Float64Array.from(data.budgets);
    this.cells = Uint32Array.from(data.cells);
    this.costs = Float64Array.from(data.costs);
    this.count = data.groups.length;
    this.length = data.cells.length;
  }
}

/**
 * Positions du jour (ADR 0013) : x et y de chaque groupe, en cases, dans l'ordre de
 * society.groups, au soir du jour courant. Elles se déduisent des marches et du jour : ce
 * cache n'est ni sauvegardé ni dans l'empreinte. Il se reconstruit au chargement, au pas
 * mensuel et après une commande ; le sous-pas n'y avance que les marches en cours, dont
 * les groupes sont les seuls à changer de place.
 */
export class DayPositions {
  /** x et y de chaque groupe, dans l'ordre de society.groups. */
  positions = new Float64Array(0);
  /** Rang de chaque groupe dans cet ordre, par identifiant. */
  private readonly ranks = new Map<number, number>();
  /** Marches en cours : leur indice, et le rang de leur groupe. */
  private active: number[] = [];
  private activeRanks: number[] = [];

  /** Nombre de marches en cours au soir du jour courant. */
  get walking(): number {
    return this.active.length;
  }

  /**
   * Recalcule tout, au soir du jour `day` : les groupes au repos au centre de leur case,
   * ceux qui marchent sur leur chemin. Une marche dont le groupe n'existe plus ne compte pas.
   */
  rebuild(groups: Iterable<Group>, walks: Walks, day: number, width: number): void {
    this.ranks.clear();
    const list = [...groups];
    if (this.positions.length !== list.length * 2) {
      this.positions = new Float64Array(list.length * 2);
    }
    list.forEach((group, rank) => {
      this.ranks.set(group.id, rank);
      this.positions[rank * 2] = group.x + 0.5;
      this.positions[rank * 2 + 1] = group.y + 0.5;
    });
    this.active = [];
    this.activeRanks = [];
    for (let index = 0; index < walks.count; index++) {
      const rank = this.ranks.get(walks.groups[index] ?? 0);
      if (rank === undefined) continue;
      walkPosition(walks, index, day, width, this.positions, rank * 2);
      if (walking(walks, index, day)) {
        this.active.push(index);
        this.activeRanks.push(rank);
      }
    }
  }

  /** Avance au soir du jour `day` les seules marches en cours ; celles qui arrivent sortent. */
  advance(walks: Walks, day: number, width: number): void {
    let kept = 0;
    for (let at = 0; at < this.active.length; at++) {
      const index = this.active[at] ?? 0;
      const rank = this.activeRanks[at] ?? 0;
      walkPosition(walks, index, day, width, this.positions, rank * 2);
      if (!walking(walks, index, day)) continue;
      this.active[kept] = index;
      this.activeRanks[kept] = rank;
      kept++;
    }
    this.active.length = kept;
    this.activeRanks.length = kept;
  }

  /** Position du jour du groupe `group`, ou undefined s'il n'existe pas. */
  positionOf(group: number): { readonly x: number; readonly y: number } | undefined {
    const rank = this.ranks.get(group);
    if (rank === undefined) return undefined;
    return { x: this.positions[rank * 2] ?? 0, y: this.positions[rank * 2 + 1] ?? 0 };
  }
}
