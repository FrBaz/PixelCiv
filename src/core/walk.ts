/**
 * Marche des groupes jour après jour (ADR 0013), partagée par le worker et le rendu.
 *
 * Le pas mensuel décide la marche de chaque groupe et la note case par case, avec le coût
 * cumulé à chaque case (src/sim/walks.ts) ; le mois suivant la parcourt à allure
 * constante, un trentième du budget par jour, soit environ une case de plaine (C2, D13).
 * Le chemin coûtant au plus le budget, le groupe arrive au plus tard le trentième jour,
 * puis campe sur sa case.
 *
 * Une position se compte en cases et fractions de case : la case (x, y) couvre
 * [x, x + 1[ × [y, y + 1[, et un groupe au repos se tient en son centre, (x + ½, y + ½).
 * La position d'un jour est une fonction pure de la marche et du jour : le worker la tient
 * pour les jours entiers, le rendu la calcule aux instants fractionnaires qu'il montre.
 * Elle ne fait que des additions, des multiplications et des divisions : elle est la même
 * dans tous les navigateurs.
 */
import { DAYS_PER_MONTH } from './time';

/**
 * Marches d'un mois, en tableaux typés, l'une après l'autre. La marche i occupe, dans
 * `cells` et `costs`, les indices de ends[i − 1] (0 pour la première) à ends[i], exclu ;
 * elle compte au moins deux cases voisines, départ compris, et finit sur la case de son
 * groupe.
 */
export interface WalkData {
  /** Groupe de chaque marche. */
  readonly groups: Uint32Array;
  /** Fin de chaque marche, exclue, dans `cells` et `costs`. */
  readonly ends: Uint32Array;
  /** Cases des chemins (indices de cases), départ compris. */
  readonly cells: Uint32Array;
  /** Coût de marche cumulé à chaque case de son chemin : 0 au départ, puis croissant. */
  readonly costs: Float64Array;
  /** Budget de chaque marche : le coût d'un mois de marche, que son chemin ne dépasse pas. */
  readonly budgets: Float64Array;
}

/** Ce qui reçoit une position : x en [offset], y en [offset + 1]. */
export type Coordinates = Record<number, number>;

/** Début de la marche `index` dans `cells` et `costs`. */
function walkStart(walks: WalkData, index: number): number {
  return index === 0 ? 0 : (walks.ends[index - 1] ?? 0);
}

/**
 * Coût parcouru au soir du jour `k` (de 0 à DAYS_PER_MONTH, fractionnaire pour le rendu)
 * par la marche `index`, avant d'atteindre le bout de son chemin : k × budget / 30.
 */
function spentAt(walks: WalkData, index: number, k: number): number {
  const days = Math.min(DAYS_PER_MONTH, Math.max(0, k));
  return (days * (walks.budgets[index] ?? 0)) / DAYS_PER_MONTH;
}

/** Coût total du chemin de la marche `index`. */
export function walkTotal(walks: WalkData, index: number): number {
  return walks.costs[(walks.ends[index] ?? 1) - 1] ?? 0;
}

/**
 * Le groupe de la marche `index` marche-t-il encore au soir du jour `k`, fractionnaire ?
 * Il n'a pas encore atteint le bout de son chemin.
 */
export function walking(walks: WalkData, index: number, k: number): boolean {
  return spentAt(walks, index, k) < walkTotal(walks, index);
}

/**
 * Jour d'arrivée de la marche `index`, de 1 à DAYS_PER_MONTH : le premier jour au soir
 * duquel son groupe se tient au bout de son chemin (walking le dit faux).
 */
export function walkArrival(walks: WalkData, index: number): number {
  let day = 1;
  while (day < DAYS_PER_MONTH && walking(walks, index, day)) day++;
  return day;
}

/**
 * Position, au soir du jour `k` (de 0 à DAYS_PER_MONTH, fractionnaire pour le rendu), du
 * groupe de la marche `index` sur un monde de `width` colonnes : le point de son chemin
 * de coût cumulé min(total, k × budget / 30), entre les centres de deux cases voisines,
 * au plus court à travers la couture. x est ramené dans [0, width[. La position s'écrit
 * dans out[offset] et out[offset + 1].
 */
export function walkPosition(
  walks: WalkData,
  index: number,
  k: number,
  width: number,
  out: Coordinates,
  offset = 0,
): void {
  const start = walkStart(walks, index);
  const end = walks.ends[index] ?? start;
  const { cells, costs } = walks;
  const spent = Math.min(spentAt(walks, index, k), walkTotal(walks, index));
  // Le segment du chemin où tombe ce coût : costs[segment] ≤ spent ≤ costs[segment + 1].
  let low = start;
  let high = end - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if ((costs[middle] ?? 0) <= spent) low = middle;
    else high = middle;
  }
  const from = cells[low] ?? 0;
  const fromX = from % width;
  const fromY = (from - fromX) / width;
  if (high <= low) {
    out[offset] = fromX + 0.5;
    out[offset + 1] = fromY + 0.5;
    return;
  }
  const to = cells[high] ?? 0;
  const toX = to % width;
  const toY = (to - toX) / width;
  const low0 = costs[low] ?? 0;
  const span = (costs[high] ?? 0) - low0;
  const share = span > 0 ? Math.min(1, Math.max(0, (spent - low0) / span)) : 1;
  // Deux cases voisines : un pas d'une colonne au plus, au plus court à travers la couture.
  let dx = toX - fromX;
  if (dx > 1) dx -= width;
  else if (dx < -1) dx += width;
  let x = fromX + 0.5 + dx * share;
  if (x < 0) x += width;
  else if (x >= width) x -= width;
  out[offset] = x;
  out[offset + 1] = fromY + 0.5 + (toY - fromY) * share;
}
