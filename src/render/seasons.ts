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
 */
import type { Biome } from '../core/data/schemas';
import { SEASON_COVERS, VEGETATION_TYPES } from '../core/data/schemas';
import type { WorldLayers, WorldSize } from '../core/world';
import { parseColor } from './bake';

/** Code de la température annuelle (°C) dans le canal R. */
export function encodeTemperature(celsius: number): number {
  return Math.min(255, Math.max(0, Math.round((celsius + 64) * 2)));
}

/** Code de la demi-amplitude (°C) dans le canal G. */
export function encodeAmplitude(celsius: number): number {
  return Math.min(255, Math.max(0, Math.round(celsius * 8)));
}

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
function biomeCodes(biomes: readonly Biome[]) {
  return biomes.map((biome) => ({
    vegetation: VEGETATION_TYPES.indexOf(biome.vegetation),
    cover: SEASON_COVERS.indexOf(biome.seasons.cover),
    water: biome.tile === 'water' && biome.id !== 'river',
    forest: biome.tile === 'forest',
  }));
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
      const biome = layers.biome[cell] ?? 0;
      const offset = (line * columns + column) * 4;
      texels[offset] = encodeTemperature((layers.temperature[cell] ?? 0) / 10);
      texels[offset + 1] = encodeAmplitude((layers.amplitude[cell] ?? 0) / 10);
      const code = codes.at(biome);
      texels[offset + 2] = encodeFlags({
        south,
        vegetation: code?.vegetation ?? 0,
        cover: code?.cover ?? 0,
        water: code?.water ?? false,
        forest: code?.forest ?? false,
      });
      texels[offset + 3] = biome;
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
