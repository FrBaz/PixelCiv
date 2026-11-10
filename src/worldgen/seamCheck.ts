/**
 * Contrôle de la couture, pour les tests : part des lignes où l'écart entre la dernière
 * colonne et la première dépasse le 95e centile des écarts entre colonnes voisines de la
 * ligne. Un champ continu à la couture en compte environ 5 % ; une marche à la couture,
 * presque toutes.
 */
import type { WorldSize } from '../core/world';

export function seamOutliers(
  field: ArrayLike<number>,
  size: WorldSize,
  same: (a: number, b: number) => number = (a, b) => Math.abs(a - b),
): number {
  const { width, height } = size;
  let outliers = 0;
  let rows = 0;
  const gaps = new Float64Array(width - 1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width - 1; x++) {
      gaps[x] = same(field[y * width + x] ?? 0, field[y * width + x + 1] ?? 0);
    }
    const seam = same(field[y * width + width - 1] ?? 0, field[y * width] ?? 0);
    const sorted = Float64Array.from(gaps).sort();
    const p95 = sorted[Math.floor(0.95 * (sorted.length - 1))] ?? 0;
    // Une ligne uniforme n'apprend rien : seules comptent les lignes qui varient.
    if ((sorted[sorted.length - 1] ?? 0) === 0) continue;
    rows++;
    if (seam > p95) outliers++;
  }
  return rows === 0 ? 0 : outliers / rows;
}
