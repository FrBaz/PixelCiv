/**
 * Caractère acquis (IND-07, ADR 0014) : la grégarité. Ce n'est pas un gène : elle ne
 * prend aucune place dans le génome, et se tire à la naissance et à l'apparition sur un
 * flux propre, `sim.temper`, qui ne décale aucun autre tirage. Chaque sous-espèce en donne
 * la répartition (data/species.json) ; un métis tire dans la moyenne de celles de son
 * ascendance, et l'enfant tient en partie de sa mère (`upbringing`), par l'éducation.
 */
import type { Species } from '../core/data';
import type { RandomStream } from '../core/rng';
import { gaussian } from './genetics';
import { ANCESTRY_SLOTS, ANCESTRY_TOTAL } from './population';

/** Valeur la plus haute d'un trait de caractère, stocké sur un octet. */
export const TEMPER_MAX = 255;

/** Moyenne et écart type de la grégarité d'une ascendance, pondérés par ses parts. */
function distribution(
  species: Species,
  ancestry: ArrayLike<number>,
  offset: number,
): { mean: number; sd: number } {
  let mean = 0;
  let sd = 0;
  let total = 0;
  for (let index = 0; index < ANCESTRY_SLOTS; index++) {
    const share = (ancestry[offset + index] ?? 0) / ANCESTRY_TOTAL;
    const subspecies = species.subspecies.at(index);
    if (subspecies === undefined || share === 0) continue;
    const { gregariousness } = subspecies.temperament;
    mean += share * gregariousness.mean;
    sd += share * gregariousness.sd;
    total += share;
  }
  // Une ascendance sans part connue (données abîmées) : la première sous-espèce.
  if (total === 0) return species.subspecies[0]?.temperament.gregariousness ?? { mean: 0.5, sd: 0 };
  return { mean: mean / total, sd: sd / total };
}

const toByte = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * TEMPER_MAX);

/**
 * Grégarité moyenne d'une ascendance, de 0 à 255 : celle que reçoit à la relecture un
 * individu d'une sauvegarde qui ne la connaissait pas (populationSave.ts).
 */
export function meanGregariousness(
  species: Species,
  ancestry: ArrayLike<number>,
  offset = 0,
): number {
  return toByte(distribution(species, ancestry, offset).mean);
}

/**
 * Grégarité d'un individu qui naît ou apparaît, de 0 à 255 : un tirage dans la répartition
 * de son ascendance, rapproché de celle de sa mère (`mother`, de 0 à 255) s'il en a une.
 * Deux tirages uniformes de `random`, toujours.
 */
export function drawGregariousness(
  species: Species,
  ancestry: ArrayLike<number>,
  offset: number,
  mother: number | undefined,
  random: RandomStream,
): number {
  const { mean, sd } = distribution(species, ancestry, offset);
  const own = mean + sd * gaussian(random);
  if (mother === undefined) return toByte(own);
  const share = species.upbringing;
  return toByte(share * (mother / TEMPER_MAX) + (1 - share) * own);
}
