/**
 * Outils de grille partagés par les étapes de la génération : voisinage sur le cylindre
 * (ADR 0002), quantiles, lissages. Les cases sont rangées ligne par ligne, du nord au
 * sud ; x boucle d'est en ouest, y non.
 */
import type { WorldSize } from '../core/world';

/**
 * Les huit directions, dans le sens des aiguilles d'une montre depuis l'est. L'indice
 * d'une direction sert de code d'écoulement (couche `drainage`).
 */
export const DIRECTIONS: readonly (readonly [number, number])[] = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

/** Longueur de chaque direction : 1 pour les côtés, √2 pour les diagonales. */
export const DIRECTION_LENGTHS: readonly number[] = DIRECTIONS.map(([dx, dy]) =>
  dx !== 0 && dy !== 0 ? Math.SQRT2 : 1,
);

/** Direction opposée à chacune. */
export function opposite(direction: number): number {
  return (direction + 4) % 8;
}

/**
 * Voisin de la case `index` dans la direction donnée, ou -1 hors du monde (au-delà des
 * pôles). La colonne boucle.
 */
export function neighbor(size: WorldSize, index: number, direction: number): number {
  const { width, height } = size;
  const [dx, dy] = DIRECTIONS[direction] ?? [0, 0];
  const x = index % width;
  const y = (index - x) / width;
  const ny = y + dy;
  if (ny < 0 || ny >= height) return -1;
  let nx = x + dx;
  if (nx < 0) nx += width;
  else if (nx >= width) nx -= width;
  return ny * width + nx;
}

/**
 * Table des voisins de toutes les cases : huit entrées par case, -1 hors du monde. Elle
 * évite de recalculer coordonnées et bouclage dans les boucles chaudes.
 */
export function neighborTable(size: WorldSize): Int32Array {
  const count = size.width * size.height;
  const table = new Int32Array(count * 8);
  for (let index = 0; index < count; index++) {
    for (let direction = 0; direction < 8; direction++) {
      table[index * 8 + direction] = neighbor(size, index, direction);
    }
  }
  return table;
}

/**
 * Quantile q (dans [0, 1]) des valeurs retenues par `keep`, par tri : déterministe.
 * Renvoie NaN si aucune valeur n'est retenue.
 */
export function quantile(
  values: ArrayLike<number>,
  q: number,
  keep: (index: number) => boolean = () => true,
): number {
  let count = 0;
  for (let index = 0; index < values.length; index++) if (keep(index)) count++;
  if (count === 0) return Number.NaN;
  const selected = new Float64Array(count);
  let next = 0;
  for (let index = 0; index < values.length; index++) {
    if (keep(index)) selected[next++] = values[index] ?? 0;
  }
  selected.sort();
  const position = Math.min(count - 1, Math.max(0, Math.round(q * (count - 1))));
  return selected[position] ?? Number.NaN;
}

/** Courbe en S de 0 à 1 entre `edge0` et `edge1` (smoothstep). */
export function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Moyenne glissante sur un carré de (2 × radius + 1) cases de côté, en deux passes
 * séparables. x boucle ; près des pôles, la fenêtre se réduit aux cases du monde.
 */
export function boxBlur(values: Float32Array, size: WorldSize, radius: number): Float32Array {
  const { width, height } = size;
  if (radius <= 0) return values.slice();
  const horizontal = new Float32Array(values.length);
  const span = 2 * radius + 1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let dx = -radius; dx <= radius; dx++) sum += values[row + ((dx + width) % width)] ?? 0;
    for (let x = 0; x < width; x++) {
      horizontal[row + x] = sum / span;
      const leaving = row + ((x - radius + width) % width);
      const entering = row + ((x + radius + 1) % width);
      sum += (values[entering] ?? 0) - (values[leaving] ?? 0);
    }
  }
  const result = new Float32Array(values.length);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let sum = 0;
      let count = 0;
      const top = Math.max(0, y - radius);
      const bottom = Math.min(height - 1, y + radius);
      for (let other = top; other <= bottom; other++) {
        sum += horizontal[other * width + x] ?? 0;
        count++;
      }
      result[y * width + x] = sum / count;
    }
  }
  return result;
}

/**
 * Composantes connexes des cases retenues par `mask`, en 8-connexité sur le cylindre.
 * Renvoie le numéro de composante de chaque case (0 hors du masque, puis 1, 2…, dans
 * l'ordre de leur première case) et la taille de chacune (indice 0 inutilisé).
 */
export function components(
  mask: ArrayLike<number | boolean>,
  size: WorldSize,
  neighbors: Int32Array = neighborTable(size),
): { readonly labels: Int32Array; readonly sizes: number[] } {
  const count = size.width * size.height;
  const labels = new Int32Array(count);
  const sizes = [0];
  const stack = new Int32Array(count);
  for (let start = 0; start < count; start++) {
    if (!mask[start] || labels[start] !== 0) continue;
    const label = sizes.length;
    let members = 0;
    let top = 0;
    stack[top++] = start;
    labels[start] = label;
    while (top > 0) {
      const index = stack[--top] ?? 0;
      members++;
      for (let direction = 0; direction < 8; direction++) {
        const other = neighbors[index * 8 + direction] ?? -1;
        if (other >= 0 && mask[other] && labels[other] === 0) {
          labels[other] = label;
          stack[top++] = other;
        }
      }
    }
    sizes.push(members);
  }
  return { labels, sizes };
}
