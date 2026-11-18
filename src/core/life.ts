/**
 * Âges de la vie (D-6, A-10, U-12 ; REN-04, REN-07 ; ESP-03) : la classe d'âge et le
 * grisonnement d'un individu, d'après les âges de son espèce (`maturity` et `ages` de
 * data/species.json). Le code d'apparence des mini-sprites, les fiches et les portraits
 * les tirent tous de ces fonctions : la carte et la fiche disent la même chose, et une
 * espèce qui vit autrement que les humains se dessine selon ses propres âges.
 *
 * Le worker donne à chaque pas leur code d'apparence à tous les membres des groupes : il
 * lit alors ces deux valeurs dans une table par mois d'âge, tirée une fois par espèce de
 * ces mêmes fonctions (lifeTable).
 */
import type { Species } from './data';
import { MONTHS_PER_YEAR } from './time';
import { AGE_CLASSES, AGE_CODE, GREY_LEVELS, type AgeClass } from './visual';

/** Ce que ces fonctions lisent d'une espèce. */
export type LifeAges = Pick<Species, 'maturity' | 'ages'>;

/**
 * Rang dans AGE_CLASSES de la classe d'âge à `years` ans : nourrisson jusqu'à `ages.baby`,
 * enfant jusqu'à la maturité, adulte, puis aîné dès `ages.elder`.
 */
export function ageCode(species: LifeAges, years: number): number {
  const { ages } = species;
  if (years < ages.baby) return AGE_CODE.baby;
  if (years < species.maturity) return AGE_CODE.child;
  return years < ages.elder ? AGE_CODE.adult : AGE_CODE.elder;
}

/** Classe d'âge à `years` ans (ageCode). */
export function ageClass(species: LifeAges, years: number): AgeClass {
  return AGE_CLASSES[ageCode(species, years)];
}

/** Un nourrisson ou un enfant : il en a les traits, et n'a encore ni barbe ni rides. */
export function isMinor(stage: AgeClass): boolean {
  return stage === 'baby' || stage === 'child';
}

/**
 * Grisonnement des cheveux à `years` ans, en crans, de 0 (aucun) à GREY_LEVELS − 1 (tout
 * gris) : la part grise croît d'un trait de `ages.grey[0]` à `ages.grey[1]` ans, et
 * s'arrondit au cran le plus proche. Le mini-sprite et le portrait montrent ce même cran.
 */
export function greyLevel(species: LifeAges, years: number): number {
  const { grey } = species.ages;
  const share = Math.min(1, Math.max(0, (years - grey[0]) / (grey[1] - grey[0])));
  return Math.round(share * (GREY_LEVELS - 1));
}

const tables = new WeakMap<object, Uint8Array>();

/**
 * Classe d'âge et cran de gris de chaque mois d'âge, de 0 à la longévité de l'espèce : le
 * rang de la classe (ageCode) dans les 2 bits faibles, le cran (greyLevel) dans les
 * suivants, pour un âge de `mois / MONTHS_PER_YEAR` ans, comme les calcule la fiche. Tirée
 * une fois par espèce.
 */
export function lifeTable(species: LifeAges & Pick<Species, 'longevity'>): Uint8Array {
  let table = tables.get(species);
  if (table === undefined) {
    table = new Uint8Array(Math.ceil(species.longevity * MONTHS_PER_YEAR) + 1);
    for (let months = 0; months < table.length; months++) {
      const years = months / MONTHS_PER_YEAR;
      table[months] = ageCode(species, years) | (greyLevel(species, years) << 2);
    }
    tables.set(species, table);
  }
  return table;
}
