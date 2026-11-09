/**
 * Temps de la partie (MOD-06, SAI-01) : un pas vaut un mois, une année compte douze
 * mois. Le joueur suit un calendrier universel, l'« an du monde », qui commence à
 * l'an 1.
 */

export const MONTHS_PER_YEAR = 12;

export interface GameDate {
  /** Année, à partir de 1. */
  readonly year: number;
  /** Mois, de 0 (janvier) à 11 (décembre). */
  readonly month: number;
}

export function dateOfTick(tick: number): GameDate {
  return { year: Math.floor(tick / MONTHS_PER_YEAR) + 1, month: tick % MONTHS_PER_YEAR };
}

/** Vitesses de la simulation, de la plus lente à la plus rapide. */
export const SPEEDS = ['slow', 'normal', 'fast', 'faster'] as const;

export type SpeedId = (typeof SPEEDS)[number];

/** Multiplicateur de chaque vitesse, par rapport à la vitesse normale. */
export const SPEED_FACTORS: Readonly<Record<SpeedId, number>> = {
  slow: 0.5,
  normal: 1,
  fast: 4,
  faster: 16,
};

/** Durée d'un mois en vitesse normale, en millisecondes : une année dure 10 s. */
export const NORMAL_MONTH_MS = 10_000 / MONTHS_PER_YEAR;

/** Durée réelle d'un mois à une vitesse donnée, en millisecondes. */
export function monthDuration(speed: SpeedId): number {
  return NORMAL_MONTH_MS / SPEED_FACTORS[speed];
}
