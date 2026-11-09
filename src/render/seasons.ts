/**
 * Texture de données des saisons (tâche 1.7 ; C1, D10 ; REN-10).
 *
 * Un texel RGBA par case, que le shader de la carte lit avec le mois courant pour
 * poser la neige, la glace et la banquise, sans recuire les blocs (CLAUDE.md,
 * « Saisons ») :
 * - R : température annuelle, par demi-degré, de −64 °C (0) à 63,5 °C (255) ;
 * - G : demi-amplitude saisonnière, par huitième de degré, jusqu'à 31,9 °C ;
 * - B : hémisphère (bit 0, 1 au sud), végétation (bits 1 à 3), couverture (bits 4 et 5 :
 *   rien, neige, glace d'eau douce, banquise) ;
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

/** Code du canal B : hémisphère, végétation, couverture. */
export function encodeFlags(south: boolean, vegetation: number, cover: number): number {
  return (south ? 1 : 0) | ((vegetation & 7) << 1) | ((cover & 3) << 4);
}

/** Codes de végétation et de couverture de chaque biome. */
function biomeCodes(biomes: readonly Biome[]): { vegetation: number[]; cover: number[] } {
  return {
    vegetation: biomes.map((biome) => VEGETATION_TYPES.indexOf(biome.vegetation)),
    cover: biomes.map((biome) => SEASON_COVERS.indexOf(biome.seasons.cover)),
  };
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
  const { vegetation, cover } = biomeCodes(biomes);
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
      texels[offset + 2] = encodeFlags(south, vegetation.at(biome) ?? 0, cover.at(biome) ?? 0);
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
