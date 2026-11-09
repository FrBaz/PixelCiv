/**
 * Cuisson d'un bloc de carte en pixels (REN-01, REN-02) : chaque case occupe 4 × 4
 * pixels, colorés selon son biome. Fonction pure, sans PixiJS : elle tourne aussi bien
 * dans un worker (tâche 1.7).
 */
import type { Biome } from '../core/data/schemas';
import { CHUNK_SIZE, type WorldLayers, type WorldSize } from '../core/world';
import { TILE_PX } from './camera';

/** Côté d'un bloc, en pixels de carte. */
export const CHUNK_PX = CHUNK_SIZE * TILE_PX;

export type Rgb = readonly [number, number, number];

/** Couleur #rrggbb en composantes. */
export function parseColor(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** Palettes des biomes, dans l'ordre de data/biomes.json. */
export interface BiomePalette {
  readonly shadow: Rgb;
  readonly base: Rgb;
  readonly light: Rgb;
}

export function biomePalettes(biomes: readonly Biome[]): BiomePalette[] {
  return biomes.map((biome) => ({
    shadow: parseColor(biome.palette.shadow),
    base: parseColor(biome.palette.base),
    light: parseColor(biome.palette.light),
  }));
}

/** Ce que la cuisson lit du monde. */
export interface BakeWorld {
  readonly size: WorldSize;
  readonly layers: WorldLayers;
  readonly palettes: readonly BiomePalette[];
}

/** Pixels RGBA du bloc (column, row). */
export function bakeChunk(world: BakeWorld, column: number, row: number): Uint8Array<ArrayBuffer> {
  const { size, layers, palettes } = world;
  const pixels = new Uint8Array(CHUNK_PX * CHUNK_PX * 4);
  for (let cy = 0; cy < CHUNK_SIZE; cy++) {
    const y = row * CHUNK_SIZE + cy;
    for (let cx = 0; cx < CHUNK_SIZE; cx++) {
      const x = column * CHUNK_SIZE + cx;
      const palette = palettes.at(layers.biome[y * size.width + x] ?? 0);
      const color = palette?.base ?? [0, 0, 0];
      for (let dy = 0; dy < TILE_PX; dy++) {
        for (let dx = 0; dx < TILE_PX; dx++) {
          const offset = ((cy * TILE_PX + dy) * CHUNK_PX + cx * TILE_PX + dx) * 4;
          pixels[offset] = color[0];
          pixels[offset + 1] = color[1];
          pixels[offset + 2] = color[2];
          pixels[offset + 3] = 255;
        }
      }
    }
  }
  return pixels;
}
