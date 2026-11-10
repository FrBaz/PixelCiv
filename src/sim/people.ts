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

/**
 * Proches parents, entre qui il n'y a pas de couple : parent et enfant, frères et sœurs,
 * demi-frères et demi-sœurs.
 */
export function closeKin(people: Population, a: number, b: number): boolean {
  const idA = people.get('id', a);
  const idB = people.get('id', b);
  const motherA = people.get('mother', a);
  const fatherA = people.get('father', a);
  const motherB = people.get('mother', b);
  const fatherB = people.get('father', b);
  if (motherA === idB || fatherA === idB || motherB === idA || fatherB === idA) return true;
  return (motherA !== NONE && motherA === motherB) || (fatherA !== NONE && fatherA === fatherB);
}
