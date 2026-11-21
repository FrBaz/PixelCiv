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
import type { Biome, Light, Seasons } from '../core/data/schemas';
import { SEASON_COVERS, SEASON_STATES, VEGETATION_TYPES } from '../core/data/schemas';
import { dryDistance, FOLIAGE_BYTES, FOLIAGE_UNIT, NO_DATE, type DryRule } from '../core/foliage';
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
import { bakeBiomes, parseColor, toneShares, type Rgb } from './bake';
import { MEAN_COLUMN, STATE_COLUMNS } from './seasonShader';

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
 * Les jours de phase (src/core/snow.ts, phaseDay) où la part de neige de snowShareOn atteint
 * `share` : à l'arrivée, au refroidissement (enneigé à partir de ce jour), et au départ, au
 * réchauffement (enneigé jusqu'à ce jour) ; NaN si elle n'y change pas (snowThresholdsOn). Le
 * décor ne réévalue un objet que lorsque le jour franchit l'une de ses dates (DecorSource).
 */
export function snowDaysOn(
  temperature: number,
  amplitude: number,
  flags: number,
  calendars: ArrayLike<number>,
  at: number,
  share: number,
  seasons: Pick<Seasons, 'snow'>,
): readonly [number, number] {
  const [arrival, departure] = snowThresholdsOn(
    temperature,
    amplitude,
    flags,
    calendars,
    at,
    share,
    seasons,
  );
  if (Number.isNaN(arrival)) return [Number.NaN, Number.NaN];
  // g = cos(2π p / an) décroît au refroidissement et croît au réchauffement.
  const day = (factor: number) =>
    (Math.acos(Math.min(1, Math.max(-1, factor))) * YEAR_DAYS) / (2 * Math.PI);
  return [day(arrival), YEAR_DAYS - day(departure)];
}

/**
 * Le ton d'hiver d'un ton : la lumière d'hiver (data/seasons.json, `light` ; ADR 0019, § 3) le
 * rapproche de `toward` de la part `mix`, puis le multiplie par `scale`, en octets arrondis. La
 * même règle donne les palettes d'hiver des biomes de terre et celles des objets du décor.
 */
export function winterTone(color: readonly [number, number, number], light: Light): Rgb {
  const toward = parseColor(light.toward);
  const tone = (value: number, target: number) =>
    Math.min(
      255,
      Math.max(0, Math.round((value * (1 - light.mix) + target * light.mix) * light.scale)),
    );
  return [tone(color[0], toward[0]), tone(color[1], toward[1]), tone(color[2], toward[2])];
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

/**
 * Texture des tons des états (seasonShader.ts, uStates) : une ligne par biome, STATE_COLUMNS
 * texels : l'automne, le bois nu et la saison sèche (data/biomes.json, `seasons.states`), puis la
 * lumière d'hiver (winterTone de sa palette d'été, aux terres seules), chacun ombre, base et
 * lumière ; enfin les tons moyens de l'été et de ces quatre états, chaque rang pesant sa part dans
 * la tuile du biome (toneShares), que la carte prend de loin. Un état sans palette reste noir :
 * le calendrier filtré (foliageTexels) ne le donne jamais.
 */
export function statePalettes(biomes: readonly Biome[], light: Light): Uint8Array<ArrayBuffer> {
  const texels = new Uint8Array(biomes.length * STATE_COLUMNS * 4);
  const baked = bakeBiomes(biomes);
  biomes.forEach((biome, row) => {
    const put = (column: number, color: readonly number[]) => {
      const offset = (row * STATE_COLUMNS + column) * 4;
      texels[offset] = color[0] ?? 0;
      texels[offset + 1] = color[1] ?? 0;
      texels[offset + 2] = color[2] ?? 0;
      texels[offset + 3] = 255;
    };
    const summer = [biome.palette.shadow, biome.palette.base, biome.palette.light].map(parseColor);
    const tones: (readonly Rgb[] | undefined)[] = SEASON_STATES.map((state) => {
      const palette = biome.seasons.states?.[state];
      return palette === undefined
        ? undefined
        : [palette.shadow, palette.base, palette.light].map(parseColor);
    });
    tones.push(
      biome.family === 'water' ? undefined : summer.map((tone) => winterTone(tone, light)),
    );
    tones.forEach((palette, state) => {
      palette?.forEach((tone, rank) => {
        put(state * 3 + rank, tone);
      });
    });
    const style = baked.at(row);
    const weights = style === undefined || style.style === 'water' ? [0, 1, 0] : toneShares(style);
    const mean = (palette: readonly Rgb[]) =>
      [0, 1, 2].map((channel) =>
        Math.round(
          palette.reduce((sum, tone, rank) => sum + (tone[channel] ?? 0) * (weights[rank] ?? 0), 0),
        ),
      );
    put(MEAN_COLUMN, mean(summer));
    tones.forEach((palette, state) => {
      if (palette !== undefined) put(MEAN_COLUMN + 1 + state, mean(palette));
    });
  });
  return texels;
}

/**
 * Le calendrier de la végétation que lit le shader (seasonShader.ts, uFoliage) : celui des cases
 * (src/core/foliage.ts), dont chaque état que le biome de la case ne prend pas (sans palette) est
 * effacé, et la lumière d'hiver aux seules terres. Le décor lit, lui, le calendrier entier : un
 * arbre caduc vire sur une prairie qui ne vire pas.
 */
export function foliageTexels(
  foliage: Uint8Array,
  layers: WorldLayers,
  biomes: readonly Biome[],
): Uint8Array<ArrayBuffer> {
  const keep = biomes.map((biome) => [
    biome.seasons.states?.autumn !== undefined,
    biome.seasons.states?.bare !== undefined,
    biome.seasons.states?.dry !== undefined,
    biome.family !== 'water',
  ]);
  const texels = new Uint8Array(foliage.length);
  for (let cell = 0; cell < layers.biome.length; cell++) {
    const states = keep.at(layers.biome[cell] ?? 0);
    for (let slot = 0; slot < FOLIAGE_BYTES; slot++) {
      const at = cell * FOLIAGE_BYTES + slot;
      texels[at] = states?.[slot] === true ? (foliage[at] ?? NO_DATE) : NO_DATE;
    }
  }
  return texels;
}

/** Côté d'une tuile de l'activité des saisons, en cases : 16 pixels, comme la mer animée. */
export const SEASON_TILE = 4;

/**
 * Activité des saisons d'un bloc (ADR 0019, § 6) : pour chaque tuile de SEASON_TILE × SEASON_TILE
 * cases, et l'anneau d'une case qui l'entoure (les cases qui prêtent leurs tons aux pixels de son
 * bord), la distance au jour le plus chaud (en jours) à partir de laquelle un de leurs états, ou la
 * lumière d'hiver, gagne un premier pixel, par hémisphère et par moitié de l'année (refroidissement,
 * réchauffement : l'automne ne vient qu'au refroidissement) ; Infinity si rien n'y change. La carte
 * ne donne le programme des saisons qu'aux blocs dont la partie visible porte une tuile active.
 */
export interface SeasonActivity {
  /** Par tuile, rangée par rangée : [nord refroidissement, nord réchauffement, sud ×2] × 2. */
  readonly tiles: Float32Array;
  /** Tuiles par côté de bloc. */
  readonly side: number;
}

/**
 * L'activité du bloc (column, row) de `chunkCells` cases de côté, d'après le calendrier filtré
 * `texels` (foliageTexels), avec ou sans la lumière d'hiver : les quatre valeurs sans lumière,
 * puis les quatre avec. La saison sèche gagne son premier pixel quand sa rampe (`dry`) quitte 0.
 */
export function seasonActivity(
  texels: Uint8Array,
  size: WorldSize,
  chunkCells: number,
  column: number,
  row: number,
  transition: number,
  dry: DryRule,
): SeasonActivity {
  const side = chunkCells / SEASON_TILE;
  const tiles = new Float32Array(side * side * 8).fill(Number.POSITIVE_INFINITY);
  const half = transition / 2;
  // Un pixel au bord d'une tuile peut prendre son ton d'une case voisine (la case bilinéaire qui
  // le prête, bake.ts) : chaque tuile compte aussi l'anneau d'une case autour d'elle, jusque dans
  // les blocs voisins, x bouclé et y borné.
  for (let y = -1; y <= chunkCells; y++) {
    const cy = Math.min(size.height - 1, Math.max(0, row * chunkCells + y));
    const south = cy >= size.height / 2;
    for (let x = -1; x <= chunkCells; x++) {
      const cx = (((column * chunkCells + x) % size.width) + size.width) % size.width;
      const at = (cy * size.width + cx) * FOLIAGE_BYTES;
      const day = (slot: number) => {
        const date = texels[at + slot] ?? NO_DATE;
        return date === NO_DATE ? Number.POSITIVE_INFINITY : date * FOLIAGE_UNIT - half;
      };
      const autumn = (texels[at + 1] ?? NO_DATE) === NO_DATE ? Number.POSITIVE_INFINITY : day(0);
      const warming = Math.min(day(1), dryDistance(texels[at + 2] ?? NO_DATE, 0, dry));
      const cooling = Math.min(warming, autumn);
      const values = [cooling, warming, Math.min(cooling, day(3)), Math.min(warming, day(3))];
      // Les tuiles dont cette case touche le carré ou l'anneau.
      const t0 = Math.max(0, Math.floor((y - 1) / SEASON_TILE));
      const t1 = Math.min(side - 1, Math.floor((y + 1) / SEASON_TILE));
      const u0 = Math.max(0, Math.floor((x - 1) / SEASON_TILE));
      const u1 = Math.min(side - 1, Math.floor((x + 1) / SEASON_TILE));
      for (let ty = t0; ty <= t1; ty++) {
        for (let tx = u0; tx <= u1; tx++) {
          const base = (ty * side + tx) * 8 + (south ? 2 : 0);
          tiles[base] = Math.min(tiles[base] ?? Infinity, values[0] ?? Infinity);
          tiles[base + 1] = Math.min(tiles[base + 1] ?? Infinity, values[1] ?? Infinity);
          tiles[base + 4] = Math.min(tiles[base + 4] ?? Infinity, values[2] ?? Infinity);
          tiles[base + 5] = Math.min(tiles[base + 5] ?? Infinity, values[3] ?? Infinity);
        }
      }
    }
  }
  return { tiles, side };
}

/**
 * La partie [left, right[ × [top, bottom[ (pixels du bloc) du bloc d'activité `activity`
 * porte-t-elle une case qui change au jour de phase du nord `north` et du sud `south`, avec ou
 * sans la lumière d'hiver ?
 */
export function seasonInRect(
  activity: SeasonActivity,
  tilePx: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
  north: number,
  south: number,
  light: boolean,
): boolean {
  if (right <= left || bottom <= top) return false;
  const { tiles, side } = activity;
  const distance = (phase: number) => Math.min(phase, YEAR_DAYS - phase);
  const index = (phase: number) => (phase < YEAR_DAYS / 2 ? 0 : 1);
  const northAt = index(north) + (light ? 4 : 0);
  const southAt = 2 + index(south) + (light ? 4 : 0);
  const dNorth = distance(north);
  const dSouth = distance(south);
  const c0 = Math.max(0, Math.floor(left / tilePx));
  const c1 = Math.min(side - 1, Math.floor((right - 1) / tilePx));
  const r0 = Math.max(0, Math.floor(top / tilePx));
  const r1 = Math.min(side - 1, Math.floor((bottom - 1) / tilePx));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const tile = (r * side + c) * 8;
      if (dNorth > (tiles[tile + northAt] ?? Infinity)) return true;
      if (dSouth > (tiles[tile + southAt] ?? Infinity)) return true;
    }
  }
  return false;
}
