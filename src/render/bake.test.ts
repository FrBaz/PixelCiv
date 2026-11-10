import { describe, expect, it } from 'vitest';
import { loadGameData } from '../core/data';
import { CHUNK_SIZE, riverClass, WORLD_SIZES } from '../core/world';
import { defaultWorldParams } from '../core/worldParams';
import { generateWorld } from '../worldgen/generate';
import { bakeBiomes, bakeChunk, bakeRegion, CHUNK_PX, pixelData, type BakeWorld } from './bake';

const data = loadGameData();
const size = WORLD_SIZES.small;
const layers = generateWorld(
  { ...defaultWorldParams(data.worldgen.parameters, 'cuisson', 'small'), size },
  data,
);
const biomes = bakeBiomes(data.biomes.entries);
const riverBiome = data.biomes.indexOf('river') ?? -1;
const world: BakeWorld = { size, layers, biomes, riverBiome };
const columns = size.width / CHUNK_SIZE;

/** Biome de la case, en données. */
const biomeOf = (cell: number) => data.biomes.entries.at(layers.biome[cell] ?? 0);
/** Une case de mer ou de lac (le lit d'un fleuve garde ses rives de terre). */
const isWater = (cell: number) =>
  biomeOf(cell)?.family === 'water' && layers.biome[cell] !== riverBiome;

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

  it("code la terre dans le rouge, les ruisseaux dans le vert et l'ombrage dans l'alpha", () => {
    let land = 0;
    let landOk = 0;
    let water = 0;
    let waterOk = 0;
    for (let row = 0; row < size.height / CHUNK_SIZE; row++) {
      const pixels = bakeChunk(world, 5, row);
      for (let cy = 0; cy < CHUNK_SIZE; cy++) {
        for (let cx = 0; cx < CHUNK_SIZE; cx++) {
          const cell = (row * CHUNK_SIZE + cy) * size.width + 5 * CHUNK_SIZE + cx;
          let nearRiver = false;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (riverClass(layers.drainage[cell + dy * size.width + dx] ?? 0) > 0)
                nearRiver = true;
            }
          }
          // Un pixel intérieur de la case : seules les plus hautes falaises y débordent.
          const pixel = pixelData(pixels, (cy * 4 + 1) * CHUNK_PX + cx * 4 + 1);
          if (isWater(cell)) {
            water++;
            if (!pixel.land && !pixel.stream && Math.abs(pixel.shade - 1) < 0.01) waterOk++;
          } else if (!nearRiver && layers.biome[cell] !== riverBiome) {
            land++;
            if (pixel.land && !pixel.stream) landOk++;
          }
        }
      }
    }
    expect(land).toBeGreaterThan(100);
    expect(water).toBeGreaterThan(100);
    expect(landOk / land).toBeGreaterThan(0.98);
    expect(waterOk / water).toBeGreaterThan(0.98);
  });

  it('fait déborder les terres sur le bord des cases d’eau, et les hautes terres plus loin', () => {
    let edges = 0;
    let overflowed = 0;
    let inner = 0;
    let innerOverflowed = 0;
    for (let row = 0; row < size.height / CHUNK_SIZE; row++) {
      for (let column = 0; column < columns; column += 3) {
        const pixels = bakeChunk(world, column, row);
        for (let cy = 1; cy < CHUNK_SIZE - 1; cy++) {
          for (let cx = 1; cx < CHUNK_SIZE - 1; cx++) {
            const cell = (row * CHUNK_SIZE + cy) * size.width + column * CHUNK_SIZE + cx;
            const west = cell - 1;
            if (!isWater(cell) || isWater(west)) continue;
            // Le pixel ouest d'une case d'eau dont la voisine de l'ouest est une terre.
            edges++;
            if (pixelData(pixels, (cy * 4 + 1) * CHUNK_PX + cx * 4).land) overflowed++;
            if ((layers.elevation[west] ?? 0) > 1200) {
              inner++;
              if (pixelData(pixels, (cy * 4 + 1) * CHUNK_PX + cx * 4 + 1).land) innerOverflowed++;
            }
          }
        }
      }
    }
    expect(edges).toBeGreaterThan(50);
    // Le bord d'une côte se découpe : un pixel sur trois environ prend la terre.
    expect(overflowed / edges).toBeGreaterThan(0.2);
    expect(overflowed / edges).toBeLessThan(0.65);
    // Une côte de plus de 1 200 m déborde parfois d'un second pixel.
    if (inner > 0) expect(innerOverflowed).toBeGreaterThan(0);
  });

  it('arrondit les limites : une case isolée perd ses coins au profit de ses voisines', () => {
    // Des cases de forêt isolées, une toutes les quatre, sur une prairie plate.
    const tiny = { width: 64, height: 32 };
    const count = tiny.width * tiny.height;
    const grassland = data.biomes.indexOf('grassland') ?? 0;
    const forest = data.biomes.indexOf('temperate-forest') ?? 0;
    const flat = {
      ...layers,
      biome: new Uint8Array(count).fill(grassland),
      elevation: new Int16Array(count).fill(100),
      waterDepth: new Uint16Array(count),
      drainage: new Uint8Array(count).fill(8),
      temperature: new Int16Array(count).fill(150),
      amplitude: new Uint8Array(count),
      precipitation: new Uint16Array(count),
      deposit: new Uint8Array(count),
      trees: new Uint8Array(count),
      shrubs: new Uint8Array(count),
    };
    const spots: [number, number][] = [];
    for (let y = 4; y < 28; y += 4) {
      for (let x = 4; x < 60; x += 4) {
        flat.biome[y * tiny.width + x] = forest;
        spots.push([x, y]);
      }
    }
    const bake = (biome: Uint8Array<ArrayBuffer>) =>
      bakeRegion({ size: tiny, layers: { ...flat, biome }, biomes, riverBiome }, 0, 0, 256, 128);
    const pixels = bake(flat.biome);
    const plain = bake(new Uint8Array(count).fill(grassland));
    const differs = (x: number, y: number) => {
      const offset = (y * 256 + x) * 4;
      return [0, 1, 2].some((k) => pixels[offset + k] !== plain[offset + k]);
    };
    let core = 0;
    let corners = 0;
    for (const [cx, cy] of spots) {
      for (let y = 1; y <= 2; y++)
        for (let x = 1; x <= 2; x++) if (differs(cx * 4 + x, cy * 4 + y)) core++;
      for (const [x, y] of [
        [0, 0],
        [3, 0],
        [0, 3],
        [3, 3],
      ] as const)
        if (!differs(cx * 4 + x, cy * 4 + y)) corners++;
    }
    // Le cœur de la case reste à la forêt ; ses coins passent presque tous à la prairie.
    expect(core).toBe(spots.length * 4);
    expect(corners / (spots.length * 4)).toBeGreaterThan(0.8);
  });

  it('trace les rivières dans leurs cases, et marque les ruisseaux sans les peindre', () => {
    let rivers = 0;
    let wet = 0;
    let streams = 0;
    let marked = 0;
    let wrongStream = 0;
    for (let row = 0; row < size.height / CHUNK_SIZE; row++) {
      for (let column = 0; column < columns; column += 2) {
        const pixels = bakeChunk(world, column, row);
        for (let cy = 0; cy < CHUNK_SIZE; cy++) {
          for (let cx = 0; cx < CHUNK_SIZE; cx++) {
            const cell = (row * CHUNK_SIZE + cy) * size.width + column * CHUNK_SIZE + cx;
            const river = riverClass(layers.drainage[cell] ?? 0);
            if (river === 0 || isWater(cell)) continue;
            let water = false;
            let stream = false;
            for (let dy = 0; dy < 4; dy++) {
              for (let dx = 0; dx < 4; dx++) {
                const pixel = pixelData(pixels, (cy * 4 + dy) * CHUNK_PX + cx * 4 + dx);
                if (!pixel.land) water = true;
                if (pixel.stream) {
                  stream = true;
                  // Un ruisseau reste un pixel de terre : le shader le peint de près.
                  if (!pixel.land) wrongStream++;
                }
              }
            }
            if (river >= 2) {
              rivers++;
              if (water) wet++;
            } else {
              streams++;
              if (stream || water) marked++;
            }
          }
        }
      }
    }
    expect(rivers).toBeGreaterThan(50);
    expect(streams).toBeGreaterThan(50);
    expect(wet / rivers).toBeGreaterThan(0.99);
    expect(marked / streams).toBeGreaterThan(0.99);
    expect(wrongStream).toBe(0);
  });

  it("garde les terres des rives dans le lit d'un fleuve, l'eau au milieu", () => {
    let beds = 0;
    let mixed = 0;
    for (let row = 0; row < size.height / CHUNK_SIZE; row++) {
      for (let column = 0; column < columns; column++) {
        const pixels = bakeChunk(world, column, row);
        for (let cy = 0; cy < CHUNK_SIZE; cy++) {
          for (let cx = 0; cx < CHUNK_SIZE; cx++) {
            const cell = (row * CHUNK_SIZE + cy) * size.width + column * CHUNK_SIZE + cx;
            if (layers.biome[cell] !== riverBiome) continue;
            beds++;
            let landPixels = 0;
            for (let dy = 0; dy < 4; dy++)
              for (let dx = 0; dx < 4; dx++)
                if (pixelData(pixels, (cy * 4 + dy) * CHUNK_PX + cx * 4 + dx).land) landPixels++;
            if (landPixels > 0 && landPixels < 16) mixed++;
          }
        }
      }
    }
    expect(beds).toBeGreaterThan(20);
    expect(mixed / beds).toBeGreaterThan(0.9);
  });
});
