/**
 * Hydrologie (tâche 1.4, MON-04, MON-07, MON-11 ; C1, D1 à D3).
 *
 * Un seul niveau de la mer sert partout. N'est mer que l'eau reliée à l'océan mondial
 * (D1) : la plus grande masse d'eau, et toute autre assez vaste. Les autres bassins,
 * même sous le niveau de la mer, relèvent des lacs (D2).
 */
import type { WorldSize } from '../core/world';
import { components, neighborTable } from './grid';

/**
 * Océan mondial (D1) : parmi les cases sous le niveau de la mer, la plus grande masse
 * d'eau connexe, et toute autre qui couvre au moins `minShare` de la carte.
 */
export function findOcean(
  elevation: Float32Array,
  size: WorldSize,
  minShare: number,
  neighbors: Int32Array = neighborTable(size),
): Uint8Array {
  const count = size.width * size.height;
  const water = new Uint8Array(count);
  for (let index = 0; index < count; index++) water[index] = (elevation[index] ?? 0) < 0 ? 1 : 0;
  const { labels, sizes } = components(water, size, neighbors);
  let largest = 0;
  for (let label = 1; label < sizes.length; label++) {
    if ((sizes[label] ?? 0) > (sizes[largest] ?? 0)) largest = label;
  }
  const minimum = minShare * count;
  const ocean = new Uint8Array(count);
  for (let index = 0; index < count; index++) {
    const label = labels[index] ?? 0;
    if (label !== 0 && (label === largest || (sizes[label] ?? 0) >= minimum)) ocean[index] = 1;
  }
  return ocean;
}
