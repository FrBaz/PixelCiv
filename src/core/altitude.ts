/**
 * Niveaux d'altitude (MON-05, C1 D11) : de quoi retrouver le niveau d'une altitude en
 * mètres, d'après les bornes de data/altitude-levels.json.
 */
import type { AltitudeLevel } from './data/schemas';

/**
 * Indice du niveau qui contient `elevation`, en mètres, négative sous la mer. Les
 * niveaux sont rangés du plus profond au plus haut et se suivent sans trou : chaque
 * borne inférieure est incluse.
 */
export function altitudeLevelIndex(levels: readonly AltitudeLevel[], elevation: number): number {
  let low = 0;
  let high = levels.length - 1;
  // Dernier niveau dont la borne inférieure ne dépasse pas l'altitude.
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    const min = levels[middle]?.min ?? Number.NEGATIVE_INFINITY;
    if (min <= elevation) low = middle;
    else high = middle - 1;
  }
  return low;
}
