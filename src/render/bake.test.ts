import { describe, expect, it } from 'vitest';
import { loadGameData } from '../core/data';
import { CHUNK_SIZE, riverClass, WORLD_SIZES } from '../core/world';
import { defaultWorldParams } from '../core/worldParams';
import { generateWorld } from '../worldgen/generate';
import { bakeBiomes, bakeChunk, bakeRegion, CHUNK_PX, type BakeWorld } from './bake';

const data = loadGameData();
const size = WORLD_SIZES.small;
const layers = generateWorld(
  { ...defaultWorldParams(data.worldgen.parameters, 'cuisson', 'small'), size },
  data,
);
const biomes = bakeBiomes(data.biomes.entries);
const river = biomes.at(data.biomes.indexOf('river') ?? -1);
if (river === undefined) throw new Error('biome « rivière » absent');
const world: BakeWorld = { size, layers, biomes, river };
const columns = size.width / CHUNK_SIZE;

/** Bande de `height` lignes de pixels, de la colonne de pixels `from` à `to` exclue. */
function slice(pixels: Uint8Array, width: number, from: number, to: number, height: number) {
  const result = new Uint8Array((to - from) * height * 4);
  for (let y = 0; y < height; y++) {
    result.set(pixels.subarray((y * width + from) * 4, (y * width + to) * 4), y * (to - from) * 4);
  }
  return result;
}

describe('cuisson des blocs', () => {
  it('raccorde deux blocs voisins au pixel près : la cuisson ne dépend que du monde', () => {
    const left = bakeChunk(world, 2, 1);
    const right = bakeChunk(world, 3, 1);
    const both = bakeRegion(world, 2 * CHUNK_PX, CHUNK_PX, 2 * CHUNK_PX, CHUNK_PX);
    expect(slice(both, 2 * CHUNK_PX, 0, CHUNK_PX, CHUNK_PX)).toEqual(left);
    expect(slice(both, 2 * CHUNK_PX, CHUNK_PX, 2 * CHUNK_PX, CHUNK_PX)).toEqual(right);
  });

  it('se referme sans couture : la région qui chevauche la couture prolonge les deux blocs', () => {
    const last = bakeChunk(world, columns - 1, 2);
    const first = bakeChunk(world, 0, 2);
    // Une région qui commence 128 pixels avant la couture, à l'est du monde.
    const across = bakeRegion(world, size.width * 4 - 128, 2 * CHUNK_PX, 256, CHUNK_PX);
    expect(slice(across, 256, 0, 128, CHUNK_PX)).toEqual(slice(last, CHUNK_PX, 128, 256, CHUNK_PX));
    expect(slice(across, 256, 128, 256, CHUNK_PX)).toEqual(
      slice(first, CHUNK_PX, 0, 128, CHUNK_PX),
    );
    // La même région, décrite à l'ouest de la couture, donne les mêmes pixels.
    expect(bakeRegion(world, -128, 2 * CHUNK_PX, 256, CHUNK_PX)).toEqual(across);
  });

  it("code dans l'alpha la terre et l'ombrage, et l'eau des mers, des lacs et des rivières", () => {
    let land = 0;
    let water = 0;
    for (let row = 0; row < size.height / CHUNK_SIZE; row++) {
      const pixels = bakeChunk(world, 5, row);
      for (let cy = 0; cy < CHUNK_SIZE; cy++) {
        for (let cx = 0; cx < CHUNK_SIZE; cx++) {
          const cell = (row * CHUNK_SIZE + cy) * size.width + 5 * CHUNK_SIZE + cx;
          const family = data.biomes.entries.at(layers.biome[cell] ?? 0)?.family;
          // Une rivière en diagonale coupe le coin des cases d'à côté : on écarte aussi
          // les voisines des rivières.
          let hasRiver = false;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (riverClass(layers.drainage[cell + dy * size.width + dx] ?? 0) > 0)
                hasRiver = true;
            }
          }
          // Le pixel du milieu de la case : ni débordement, ni bord.
          const alpha = pixels[((cy * 4 + 1) * CHUNK_PX + cx * 4 + 1) * 4 + 3] ?? 0;
          if (family === 'water') {
            water++;
            expect(alpha & 128).toBe(0);
            expect(alpha & 127).toBe(64);
          } else if (!hasRiver) {
            land++;
            expect(alpha & 128).toBe(128);
          }
        }
      }
    }
    expect(land).toBeGreaterThan(100);
    expect(water).toBeGreaterThan(100);
  });

  it('fait déborder les terres sur le bord des cases d’eau voisines', () => {
    let edges = 0;
    let overflowed = 0;
    for (let row = 0; row < size.height / CHUNK_SIZE; row++) {
      for (let column = 0; column < columns; column += 3) {
        const pixels = bakeChunk(world, column, row);
        for (let cy = 1; cy < CHUNK_SIZE - 1; cy++) {
          for (let cx = 1; cx < CHUNK_SIZE - 1; cx++) {
            const cell = (row * CHUNK_SIZE + cy) * size.width + column * CHUNK_SIZE + cx;
            const west = cell - 1;
            const isWater = (index: number) =>
              data.biomes.entries.at(layers.biome[index] ?? 0)?.family === 'water';
            if (!isWater(cell) || isWater(west)) continue;
            // Le pixel ouest d'une case d'eau dont la voisine de l'ouest est une terre.
            edges++;
            const alpha = pixels[((cy * 4 + 1) * CHUNK_PX + cx * 4) * 4 + 3] ?? 0;
            if (alpha & 128) overflowed++;
          }
        }
      }
    }
    expect(edges).toBeGreaterThan(50);
    // Une fois sur deux, au hasard du pixel.
    expect(overflowed / edges).toBeGreaterThan(0.35);
    expect(overflowed / edges).toBeLessThan(0.65);
  });

  it('dessine les rivières en eau, au milieu de leurs cases', () => {
    let rivers = 0;
    let wet = 0;
    for (let row = 0; row < size.height / CHUNK_SIZE; row++) {
      for (let column = 0; column < columns; column += 2) {
        const pixels = bakeChunk(world, column, row);
        for (let cy = 0; cy < CHUNK_SIZE; cy++) {
          for (let cx = 0; cx < CHUNK_SIZE; cx++) {
            const cell = (row * CHUNK_SIZE + cy) * size.width + column * CHUNK_SIZE + cx;
            if (riverClass(layers.drainage[cell] ?? 0) === 0) continue;
            if (data.biomes.entries.at(layers.biome[cell] ?? 0)?.family === 'water') continue;
            rivers++;
            // L'un des quatre pixels du centre de la case porte la rivière.
            const center = (
              [
                [1, 1],
                [2, 1],
                [1, 2],
                [2, 2],
              ] as const
            ).some(
              ([dx, dy]) =>
                ((pixels[((cy * 4 + dy) * CHUNK_PX + cx * 4 + dx) * 4 + 3] ?? 0) & 128) === 0,
            );
            if (center) wet++;
          }
        }
      }
    }
    expect(rivers).toBeGreaterThan(50);
    expect(wet).toBe(rivers);
  });
});
