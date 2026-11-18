/**
 * Ce que les systèmes lisent d'un individu (phase 2, ADR 0011) : âge, adaptation de son
 * ascendance, climat de sa case, parenté.
 */
import type { Species } from '../core/data';
import { monthlyTemperature, southern } from '../core/seasons';
import type { WorldLayers, WorldSize } from '../core/world';
import { ANCESTRY_SLOTS, ANCESTRY_TOTAL, NONE, type Population } from './population';

export const MONTHS_PER_YEAR = 12;

/** Âge en années révolues ou non, au pas `tick`. */
export function ageInYears(people: Population, slot: number, tick: number): number {
  return people.age(slot, tick) / MONTHS_PER_YEAR;
}

/** Mois continu du pas `tick` : le milieu du mois, 0,5 pour janvier (core/seasons). */
export function monthOf(tick: number): number {
  return (((tick % MONTHS_PER_YEAR) + MONTHS_PER_YEAR) % MONTHS_PER_YEAR) + 0.5;
}

export interface Adaptation {
  readonly cold: number;
  readonly heat: number;
  readonly endurance: number;
}

/** Adaptation d'un individu : celles des sous-espèces de son ascendance, pondérées. */
export function adaptationOf(people: Population, slot: number, species: Species): Adaptation {
  let cold = 0;
  let heat = 0;
  let endurance = 0;
  for (let index = 0; index < ANCESTRY_SLOTS; index++) {
    const share = (people.columns.ancestry[slot * ANCESTRY_SLOTS + index] ?? 0) / ANCESTRY_TOTAL;
    const subspecies = species.subspecies.at(index);
    if (subspecies === undefined || share === 0) continue;
    cold += share * subspecies.adaptation.cold;
    heat += share * subspecies.adaptation.heat;
    endurance += share * subspecies.adaptation.endurance;
  }
  return { cold, heat, endurance };
}

/** Sous-espèce dominante d'un individu (indice dans son espèce), et sa part, de 0 à 1. */
export function dominantSubspecies(
  people: Population,
  slot: number,
): { readonly index: number; readonly share: number } {
  let index = 0;
  let best = -1;
  for (let part = 0; part < ANCESTRY_SLOTS; part++) {
    const share = people.columns.ancestry[slot * ANCESTRY_SLOTS + part] ?? 0;
    if (share > best) {
      best = share;
      index = part;
    }
  }
  return { index, share: best / ANCESTRY_TOTAL };
}

/** Température du mois sur la case (x, y), en °C (C1, D8). */
export function cellTemperature(
  world: WorldLayers,
  size: WorldSize,
  x: number,
  y: number,
  month: number,
): number {
  const cell = y * size.width + x;
  return monthlyTemperature(
    (world.temperature[cell] ?? 0) / 10,
    (world.amplitude[cell] ?? 0) / 10,
    southern(y, size.height),
    month,
  );
}

/** Mère, père ou conjoint d'un individu, vivant ou mort ; NONE s'il est inconnu. */
function relativeOf(people: Population, id: number, link: 'mother' | 'father' | 'partner'): number {
  if (id === NONE) return NONE;
  const slot = people.slotOf(id);
  if (slot !== undefined) return people.get(link, slot);
  const row = people.archivedRow(id);
  return row === undefined ? NONE : (people.archive.columns[link][row] ?? NONE);
}

/** Les parents (mère, père) de deux individus en ont-ils un en commun ? */
function shareParent(motherA: number, fatherA: number, motherB: number, fatherB: number) {
  return (motherA !== NONE && motherA === motherB) || (fatherA !== NONE && fatherA === fatherB);
}

/**
 * Le parent `parent` de quelqu'un est-il, pour `other` (de parents `motherOther` et
 * `fatherOther`), un enfant (`other` est alors son grand-parent), un frère, une sœur, un
 * demi-frère ou une demi-sœur (`other` est son oncle ou sa tante), ou le conjoint, actuel
 * ou à sa mort (`other` est son beau-parent) ? On lit les morts dans l'archive.
 */
function parentLinked(
  people: Population,
  parent: number,
  other: number,
  motherOther: number,
  fatherOther: number,
): boolean {
  if (parent === NONE) return false;
  const mother = relativeOf(people, parent, 'mother');
  const father = relativeOf(people, parent, 'father');
  if (mother === other || father === other) return true;
  if (shareParent(mother, father, motherOther, fatherOther)) return true;
  return relativeOf(people, parent, 'partner') === other;
}

/**
 * Proches parents, entre qui il n'y a pas de couple : parent et enfant, grand-parent et
 * petit-enfant, frères et sœurs, demi-frères et demi-sœurs, oncle ou tante et neveu ou
 * nièce (demi-oncles et demi-tantes compris), beau-parent et bel-enfant. Les cousins
 * peuvent s'épouser. `a` et `b` sont des emplacements de vivants ; leurs ascendants
 * peuvent être morts.
 */
export function closeKin(people: Population, a: number, b: number): boolean {
  const idA = people.get('id', a);
  const idB = people.get('id', b);
  const motherA = people.get('mother', a);
  const fatherA = people.get('father', a);
  const motherB = people.get('mother', b);
  const fatherB = people.get('father', b);
  if (motherA === idB || fatherA === idB || motherB === idA || fatherB === idA) return true;
  if (shareParent(motherA, fatherA, motherB, fatherB)) return true;
  return (
    parentLinked(people, motherA, idB, motherB, fatherB) ||
    parentLinked(people, fatherA, idB, motherB, fatherB) ||
    parentLinked(people, motherB, idA, motherA, fatherA) ||
    parentLinked(people, fatherB, idA, motherA, fatherA)
  );
}
