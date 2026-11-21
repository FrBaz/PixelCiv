/**
 * Texture de données des saisons (tâche 1.7 ; C1, D10 ; REN-10).
 *
 * Un texel RGBA par case, que le shader de la carte lit avec le mois courant pour
 * poser la neige, la glace et la banquise, sans recuire les blocs (CLAUDE.md,
 * « Saisons ») :
 * - R : température annuelle, par demi-degré, de −64 °C (0) à 63,5 °C (255) ;
 * - G : demi-amplitude saisonnière, par huitième de degré, jusqu'à 31,9 °C ;
 * - B : hémisphère (bit 0, 1 au sud), végétation (bits 1 à 3), couverture (bits 4 et 5 :
 *   rien, neige, glace d'eau douce, banquise), eau (bit 6 : mer ou lac, le lit d'un
 *   fleuve gardant ses rives), forêt (bit 7 : tuile de forêt, qui garde moins de neige) ;
 * - A : indice du biome, qui désigne sa palette de saison.
 *
 * Et une texture de palettes : une ligne par biome, trois texels (ombre, base, lumière)
 * pour la palette de sa couverture.
 *
 * Le décor (tâche 2b.6, ADR 0017) lit ici la part de neige d'une case, depuis les mêmes codes, les
 * mêmes calendriers (src/core/snow.ts) et par la même composition que le shader de la carte
 * (snowShareOn) ; et le shader des objets, le ton d'ombre de chaque case pour l'ombre portée
 * « ground » (shadowTones).
 */
import type { Biome, Seasons } from '../core/data/schemas';
import { SEASON_COVERS, VEGETATION_TYPES } from '../core/data/schemas';
import { coverShare } from '../core/seasons';
import {
  calendarLevel,
  codeAmplitude,
  codeTemperature,
  composeCover,
  DAYS_PER_UNIT,
  encodeAmplitude,
  encodeTemperature,
  phaseDay,
  YEAR_DAYS,
} from '../core/snow';
import type { WorldLayers, WorldSize } from '../core/world';
import { parseColor } from './bake';

/** Codes de la température annuelle (canal R) et de la demi-amplitude (canal G). */
export { encodeAmplitude, encodeTemperature } from '../core/snow';

/** Ce que le canal B dit d'une case. */
export interface CellFlags {
  readonly south: boolean;
  readonly vegetation: number;
  readonly cover: number;
  readonly water: boolean;
  readonly forest: boolean;
}

/** Code du canal B : hémisphère, végétation, couverture, eau, forêt. */
export function encodeFlags(flags: CellFlags): number {
  return (
    (flags.south ? 1 : 0) |
    ((flags.vegetation & 7) << 1) |
    ((flags.cover & 3) << 4) |
    (flags.water ? 64 : 0) |
    (flags.forest ? 128 : 0)
  );
}

/** Codes de chaque biome : végétation, couverture, eau (hors lit des fleuves), forêt. */
export function biomeCodes(biomes: readonly Biome[]): readonly Omit<CellFlags, 'south'>[] {
  return biomes.map((biome) => ({
    vegetation: VEGETATION_TYPES.indexOf(biome.vegetation),
    cover: SEASON_COVERS.indexOf(biome.seasons.cover),
    water: biome.tile === 'water' && biome.id !== 'river',
    forest: biome.tile === 'forest',
  }));
}

/** Les codes d'une case dans la texture des saisons : rouge, vert, bleu (seasonTexels). */
export interface SeasonCodes {
  readonly temperature: number;
  readonly amplitude: number;
  readonly flags: number;
}

/** Les codes de la case `cell`, au sud ou non, d'après les codes de son biome (biomeCodes). */
export function cellSeasonCodes(
  layers: WorldLayers,
  codes: readonly Omit<CellFlags, 'south'>[],
  cell: number,
  south: boolean,
): SeasonCodes {
  const code = codes.at(layers.biome[cell]);
  return {
    temperature: encodeTemperature(layers.temperature[cell] / 10),
    amplitude: encodeAmplitude(layers.amplitude[cell] / 10),
    flags: encodeFlags({
      south,
      vegetation: code?.vegetation ?? 0,
      cover: code?.cover ?? 0,
      water: code?.water ?? false,
      forest: code?.forest ?? false,
    }),
  };
}

/** Code de la neige, dans la couverture du canal B. */
const SNOW_COVER = SEASON_COVERS.indexOf('snow');

/** La case est-elle une terre couverte de neige (ni eau, ni biome sans neige) ? */
function snowyLand(flags: number): boolean {
  return ((flags >> 6) & 1) === 0 && ((flags >> 4) & 3) === SNOW_COVER;
}

/**
 * Part de neige d'une case de terre, de 0 à 1, telle que la pose le shader de la carte avant sa
 * trame (mapShader.ts, COVER_GLSL : share × la part des forêts) : depuis les codes de la case
 * dans la texture des saisons et son calendrier de neige (aux octets `at` de `calendars`), au
 * facteur de saison `season` (seasonFactor du mois, au nord) et au jour continu `day` de l'année.
 * Une case d'eau, ou d'un biome sans neige, n'en a pas. Le décor s'enneige d'après elle
 * (src/gen/decor.ts, decorSeason).
 */
export function snowShareOn(
  temperature: number,
  amplitude: number,
  flags: number,
  calendars: ArrayLike<number>,
  at: number,
  season: number,
  day: number,
  seasons: Pick<Seasons, 'snow'>,
): number {
  if (!snowyLand(flags)) return 0;
  const south = (flags & 1) === 1;
  const annual = codeTemperature(temperature);
  const swing = codeAmplitude(amplitude);
  const daily = annual + swing * season * (south ? -1 : 1);
  const phase = phaseDay(day, south);
  const { ramp, forest } = seasons.snow;
  const share = composeCover(
    ramp,
    annual,
    swing,
    daily,
    phase,
    calendarLevel(calendars, at, phase),
  );
  return share * (flags >> 7 === 1 ? forest : 1);
}

/** Facteur de saison du jour de phase `phase`, comme le donne le mois (seasonFactor, signé). */
function phaseFactor(phase: number): number {
  return Math.cos((2 * Math.PI * phase) / YEAR_DAYS);
}

/**
 * Les seuils de neige d'une case pour le décor : les valeurs de g (le facteur de saison, signé
 * par l'hémisphère : seasonFactor du mois au nord, son opposé au sud) où la part de neige de
 * snowShareOn atteint `share` (decorSeason : enneigé), à l'arrivée, au refroidissement, et au
 * départ, au réchauffement ; NaN si elle n'y change pas (une case d'eau, sans neige, sans
 * amplitude, ou toujours, ou jamais, au-dessus). La part croît au refroidissement et décroît au
 * réchauffement (src/core/snow.ts) : chaque moitié de l'année la franchit une fois au plus. Le
 * décor ne réévalue un objet que lorsque g franchit l'un de ses seuils, ou que le refroidissement
 * change (DecorSource.refreshStates).
 */
export function snowThresholdsOn(
  temperature: number,
  amplitude: number,
  flags: number,
  calendars: ArrayLike<number>,
  at: number,
  share: number,
  seasons: Pick<Seasons, 'snow'>,
): readonly [number, number] {
  const none = [Number.NaN, Number.NaN] as const;
  if (!snowyLand(flags) || share <= 0) return none;
  const keep = flags >> 7 === 1 ? seasons.snow.forest : 1;
  const { ramp } = seasons.snow;
  const annual = codeTemperature(temperature);
  const swing = codeAmplitude(amplitude);
  const most = coverShare(ramp, annual - swing);
  const summer = coverShare(ramp, annual + swing);
  const level = share / keep;
  if (keep <= 0 || swing <= 0 || level <= summer || level > most) return none;
  // La rampe atteint `level` au facteur gamma ; la montée du calendrier, au jour rise ; sa
  // descente le quitte au jour fall.
  const below = ramp.onset - (ramp.span * level) / ramp.full;
  const gamma = Math.min(1, Math.max(-1, (below - annual) / swing));
  const fraction = level / most;
  const rise = (calendars[at] ?? 0) * DAYS_PER_UNIT + fraction * (calendars[at + 2] ?? 1);
  const fall = (calendars[at + 1] ?? 0) * DAYS_PER_UNIT - fraction * (calendars[at + 3] ?? 1);
  // Au refroidissement, g décroît : enneigé sous la rampe et sous la montée.
  const arrival = Math.min(gamma, phaseFactor(rise));
  // Au réchauffement, g croît : enneigé tant que la rampe ou la descente le tient.
  const departure = fall >= YEAR_DAYS / 2 ? Math.max(gamma, phaseFactor(fall)) : gamma;
  return [arrival, departure];
}

/**
 * Tons d'ombre de chaque biome, pour l'ombre portée « ground » des objets (ADR 0017, § 4) : une
 * ligne par biome, deux texels, le ton d'ombre de sa palette, puis celui de la palette de sa
 * couverture (le premier, faute de couverture).
 */
export function shadowTones(biomes: readonly Biome[]): Uint8Array<ArrayBuffer> {
  const texels = new Uint8Array(biomes.length * 2 * 4);
  biomes.forEach((biome, row) => {
    const tones = [biome.palette.shadow, biome.seasons.palette?.shadow ?? biome.palette.shadow];
    tones.forEach((hex, column) => {
      const [red, green, blue] = parseColor(hex);
      const offset = (row * 2 + column) * 4;
      texels[offset] = red;
      texels[offset + 1] = green;
      texels[offset + 2] = blue;
      texels[offset + 3] = 255;
    });
  });
  return texels;
}

/**
 * Texels du rectangle de cases de `columns` × `rows` dont le coin nord-ouest est
 * (left, top), ligne par ligne.
 */
export function seasonTexels(
  size: WorldSize,
  layers: WorldLayers,
  biomes: readonly Biome[],
  left = 0,
  top = 0,
  columns = size.width,
  rows = size.height,
): Uint8Array<ArrayBuffer> {
  const codes = biomeCodes(biomes);
  const texels = new Uint8Array(columns * rows * 4);
  for (let line = 0; line < rows; line++) {
    const y = top + line;
    // L'hémisphère nord occupe la moitié haute de la carte (C1, D8).
    const south = y >= size.height / 2;
    for (let column = 0; column < columns; column++) {
      const cell = y * size.width + left + column;
      const offset = (line * columns + column) * 4;
      const cellCodes = cellSeasonCodes(layers, codes, cell, south);
      texels[offset] = cellCodes.temperature;
      texels[offset + 1] = cellCodes.amplitude;
      texels[offset + 2] = cellCodes.flags;
      texels[offset + 3] = layers.biome[cell];
    }
  }
  return texels;
}

/** Texture des palettes de saison : une ligne par biome, ombre, base et lumière. */
export function seasonPalettes(biomes: readonly Biome[]): Uint8Array<ArrayBuffer> {
  const texels = new Uint8Array(biomes.length * 3 * 4);
  biomes.forEach((biome, row) => {
    const palette = biome.seasons.palette;
    const colors = palette === undefined ? [] : [palette.shadow, palette.base, palette.light];
    colors.forEach((hex, column) => {
      const [red, green, blue] = parseColor(hex);
      const offset = (row * 3 + column) * 4;
      texels[offset] = red;
      texels[offset + 1] = green;
      texels[offset + 2] = blue;
      texels[offset + 3] = 255;
    });
  });
  return texels;
}
