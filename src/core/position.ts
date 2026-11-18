/**
 * Positions des individus (ADR 0014), partagées par le worker et le rendu.
 *
 * Une position se compte en 1/65 536 de case, en virgule fixe 16.16, dans des entiers : la
 * case (i, j) couvre [i, i + 1[ × [j, j + 1[, et x ∈ [0, largeur × FIXED[, y ∈ [0, hauteur
 * × FIXED[. Le monde est un cylindre : toute abscisse revient dans le monde après chaque
 * addition, et tout écart horizontal se prend au plus court, à travers la couture.
 *
 * Un individu en marche suit des étapes droites : une étape part d'un point, à un jour donné,
 * et avance d'un pas entier par jour pendant un nombre de jours. Aux jours entiers, sa
 * position est un entier exact, le même dans le worker, qui l'ajoute jour après jour, et
 * dans le rendu, qui la calcule d'un coup (legAt) ; entre deux jours, le rendu l'interpole
 * sur le segment du jour, que le worker a vérifié.
 */

/** Unités d'une case. */
export const FIXED = 65_536;

/** Position en unités d'une coordonnée en cases, arrondie à l'unité. */
export function toFixed(cells: number): number {
  return Math.round(cells * FIXED);
}

/** Coordonnée en cases d'une position en unités. */
export function fromFixed(units: number): number {
  return units / FIXED;
}

/** Abscisse ramenée dans [0, width × FIXED[, sur un monde de `width` colonnes. */
export function wrapFixedX(x: number, width: number): number {
  const span = width * FIXED;
  const wrapped = x % span;
  return wrapped < 0 ? wrapped + span : wrapped;
}

/**
 * Écart horizontal le plus court de `from` à `to`, à travers la couture, dans
 * [−width × FIXED / 2, width × FIXED / 2[.
 */
export function deltaFixedX(from: number, to: number, width: number): number {
  const span = width * FIXED;
  let delta = (to - from) % span;
  if (delta < -span / 2) delta += span;
  else if (delta >= span / 2) delta -= span;
  return delta;
}

/** Case d'une position du monde, en indice de case : rangée × largeur + colonne. */
export function cellOf(x: number, y: number, width: number): number {
  return Math.floor(y / FIXED) * width + Math.floor(x / FIXED);
}

/**
 * Coordonnée, à l'instant `t` (en jours depuis le départ de l'étape, fractionnaire pour le
 * rendu), d'une étape partie de `start` qui avance de `step` par jour pendant `days` jours :
 * start + step × t, borné au départ et à la fin de l'étape. Aux jours entiers, c'est l'entier
 * exact que tient le worker ; une abscisse se ramène ensuite dans le monde (wrapFixedX).
 */
export function legAt(start: number, step: number, days: number, t: number): number {
  return start + step * Math.min(days, Math.max(0, t));
}

/**
 * Côté où se porte un nourrisson contre sa mère, et où il se pose à son sevrage : +1 à l'est,
 * −1 à l'ouest. Il ne dépend que de son identifiant, et non de son rang parmi les portés :
 * il ne change ni à la naissance d'un frère, ni au sevrage d'un autre.
 */
export function carriedSide(id: number): 1 | -1 {
  return Math.imul(id, 0x9e3779b1) >>> 31 === 0 ? 1 : -1;
}
