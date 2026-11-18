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

/** Durée d'une année en vitesse normale, en millisecondes (consigne de l'auteur, 2b.2). */
export const NORMAL_YEAR_MS = 40_000;

/** Durées d'un mois et d'un jour en vitesse normale, en millisecondes. */
export const NORMAL_MONTH_MS = NORMAL_YEAR_MS / MONTHS_PER_YEAR;
export const NORMAL_DAY_MS = NORMAL_YEAR_MS / DAYS_PER_YEAR;

/** Durée réelle d'un mois à une vitesse donnée, en millisecondes. */
export function monthDuration(speed: SpeedId): number {
  return NORMAL_MONTH_MS / SPEED_FACTORS[speed];
}

/** Durée réelle d'un jour à une vitesse donnée, en millisecondes. */
export function dayDuration(speed: SpeedId): number {
  return NORMAL_DAY_MS / SPEED_FACTORS[speed];
}

/**
 * Durée réelle de `days` jours, fractionnaires, à une vitesse donnée, en millisecondes.
 * Elle se calcule d'un bloc, et non jour par jour : 360 jours durent une année pile, sans
 * erreur d'arrondi.
 */
export function daysDuration(days: number, speed: SpeedId): number {
  return (days * NORMAL_YEAR_MS) / (DAYS_PER_YEAR * SPEED_FACTORS[speed]);
}

/** Jours, fractionnaires, qui passent en `milliseconds` à une vitesse donnée. */
export function daysIn(milliseconds: number, speed: SpeedId): number {
  return (milliseconds * DAYS_PER_YEAR * SPEED_FACTORS[speed]) / NORMAL_YEAR_MS;
}

/**
 * Cadence des lots de l'hôte (ADR 0013) : il ne se réveille pas plus d'une fois toutes les
 * MIN_BATCH_MS millisecondes, une image, et fait au plus MAX_BATCH_DAYS jours par réveil.
 */
export const MIN_BATCH_MS = 16;
export const MAX_BATCH_DAYS = 8;

/**
 * Jours d'un lot quand l'hôte suit son horaire : le moins de jours qui durent au moins
 * MIN_BATCH_MS, un à ×½, ×1 et ×4, trois à ×16.
 */
export function batchDays(speed: SpeedId): number {
  return Math.max(1, Math.ceil(MIN_BATCH_MS / dayDuration(speed)));
}
