/**
 * Saisons (C1, D8 ; SAI-02) : la même saison pour la génération, la simulation, le shader
 * et l'interface. Le mois est continu : 0 au début de janvier, 6,5 à la mi-juillet, où
 * l'été culmine au nord ; l'hémisphère sud vit la saison inverse.
 *
 * - Température du mois : T + A × cos(2π (mois − 6,5) / 12), signe inversé au sud ; le
 *   mois le plus chaud culmine à T + A, le plus froid à T − A (D13 les classe ainsi).
 * - Pluie du mois : la pluie annuelle se répartit sur l'année, avec une saison sèche en
 *   hiver et une saison des pluies en été sous les tropiques (C1, D8).
 *
 * Fonctions de dmath : elles servent aussi aux calculs qui influencent l'état.
 */
import { cos, exp, TAU } from './dmath';

/** Latitude de la ligne y d'une carte de `height` lignes : 0 à l'équateur, 1 aux pôles. */
export function latitude(y: number, height: number): number {
  return Math.abs((2 * (y + 0.5)) / height - 1);
}

/** Vrai si la ligne y est dans l'hémisphère sud (moitié basse de la carte). */
export function southern(y: number, height: number): boolean {
  return y >= height / 2;
}

/** Facteur de saison du mois continu `month` au nord : 1 à la mi-juillet, −1 à la mi-janvier. */
export function seasonFactor(month: number): number {
  return cos((TAU * (month - 6.5)) / 12);
}

/** Milieu de chacun des douze mois, en mois continus (0,5 pour janvier). */
export const MONTH_CENTERS: readonly number[] = Array.from(
  { length: 12 },
  (_, month) => month + 0.5,
);

/** Température du mois continu `month` d'une case, selon son hémisphère (D8). */
export function monthlyTemperature(
  annual: number,
  amplitude: number,
  south: boolean,
  month: number,
): number {
  return annual + amplitude * seasonFactor(month) * (south ? -1 : 1);
}

/** Températures du mois le plus chaud et du plus froid d'une case (D13). */
export function extremeMonths(
  annual: number,
  amplitude: number,
): { warmest: number; coldest: number } {
  return { warmest: annual + amplitude, coldest: annual - amplitude };
}

/**
 * Force de la saison des pluies à la latitude `lat` (0 à l'équateur, 1 aux pôles) : nulle
 * sous l'équateur, où il pleut toute l'année, la plus forte sous les tropiques, vers 18°,
 * faible aux latitudes moyennes.
 */
export function rainSeasonality(lat: number): number {
  const tropics = (lat - 0.2) / 0.13;
  return 0.9 * exp(-tropics * tropics);
}

/**
 * Pluie du mois continu `month` (mm, rapportée à un mois), d'une pluie annuelle `annual` :
 * plus en été, moins en hiver, d'autant plus sous les tropiques. Sur l'année, la somme
 * des mois redonne la pluie annuelle.
 */
export function monthlyPrecipitation(
  annual: number,
  lat: number,
  south: boolean,
  month: number,
): number {
  const share = 1 + rainSeasonality(lat) * seasonFactor(month) * (south ? -1 : 1);
  return (annual / 12) * share;
}
