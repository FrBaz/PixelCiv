/**
 * Temps de la partie (MOD-06, SAI-01 ; ADR 0013) : deux horloges. Le pas mensuel fait
 * passer un mois, le sous-pas quotidien un jour. Une année compte douze mois de trente
 * jours, soit 360 jours abstraits, comme l'échelle de la carte est abstraite (MON-16).
 * Le joueur suit un calendrier universel, l'« an du monde », qui commence à l'an 1.
 */

export const MONTHS_PER_YEAR = 12;

/** Jours d'un mois, et d'une année. */
export const DAYS_PER_MONTH = 30;
export const DAYS_PER_YEAR = DAYS_PER_MONTH * MONTHS_PER_YEAR;

export interface GameDate {
  /** Année, à partir de 1. */
  readonly year: number;
  /** Mois, de 0 (janvier) à 11 (décembre). */
  readonly month: number;
}

/** Date d'un pas ; un pas négatif tombe avant l'an 1 (un individu apparu adulte y est né). */
export function dateOfTick(tick: number): GameDate {
  const month = ((tick % MONTHS_PER_YEAR) + MONTHS_PER_YEAR) % MONTHS_PER_YEAR;
  return { year: Math.floor(tick / MONTHS_PER_YEAR) + 1, month };
}

/**
 * Instant de la partie : `tick` pas mensuels faits, donc mois écoulés, et `day` jours
 * écoulés du mois en cours, de 0 à DAYS_PER_MONTH − 1.
 */
export interface GameTime {
  readonly tick: number;
  readonly day: number;
}

/** Rang d'un instant, en jours écoulés depuis le début de la partie : il ordonne les instants. */
export function dayIndex(time: GameTime): number {
  return time.tick * DAYS_PER_MONTH + time.day;
}

/** Instant d'un rang de jour (dayIndex), entier positif ou nul. */
export function timeOfDayIndex(index: number): GameTime {
  const day = index % DAYS_PER_MONTH;
  return { tick: (index - day) / DAYS_PER_MONTH, day };
}

/** Date d'un instant, au jour près. */
export interface GameDay extends GameDate {
  /** Jour en cours du mois, de 1 à DAYS_PER_MONTH : celui qui suit les `day` jours écoulés. */
  readonly day: number;
}

/** Date d'un instant : son mois, et le jour en cours de ce mois. */
export function dateOfTime(time: GameTime): GameDay {
  return { ...dateOfTick(time.tick), day: time.day + 1 };
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
