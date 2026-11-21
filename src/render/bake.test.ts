import { describe, expect, it } from 'vitest';
import { loadGameData } from '../core/data';
import { CHUNK_SIZE, riverClass, WORLD_SIZES } from '../core/world';
import { defaultWorldParams } from '../core/worldParams';
import { generateWorld } from '../worldgen/generate';
import { Fingerprint } from '../core/hash';
import {
  bakeBiomes,
  bakeChunk,
  bakeRegion,
  CHUNK_PX,
  IDENTITY,
  pixelData,
  TINT,
  toneShares,
  type BakeWorld,
} from './bake';

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

describe('carte d’identité des tons (tâche 2b.7, ADR 0019, § 2)', () => {
  const SEEDS = ['pixelciv', 'graine', 'autre'] as const;
  /** Des blocs du nord au sud, de part et d'autre de la couture. */
  const CHUNKS = [
    [0, 0],
    [3, 1],
    [7, 1],
    [5, 2],
    [2, 3],
  ] as const;
  const worldOf = (seed: string): BakeWorld => ({
    size,
    layers: generateWorld(
      { ...defaultWorldParams(data.worldgen.parameters, seed, 'small'), size },
      data,
    ),
    biomes,
    riverBiome,
  });
  const worlds = SEEDS.map(worldOf);

  it('ne change aucun pixel cuit : ceux de 7c893a7, la carte demandée ou non', () => {
    // La règle de la phase (« ne touche pas aux tuiles ») : les empreintes de la cuisson de
    // 7c893a7, relevées avant que la cuisson ne sache tenir sa carte d'identité.
    const expected = ['1f4835ca', 'afa6652c', '42113471'];
    worlds.forEach((world, index) => {
      const plain = new Fingerprint();
      const identified = new Fingerprint();
      for (const [column, row] of CHUNKS) {
        plain.typedArray(bakeChunk(world, column, row));
        identified.typedArray(bakeChunk(world, column, row, new Uint8Array(CHUNK_PX * CHUNK_PX)));
      }
      expect(plain.hex(), SEEDS[index]).toBe(expected[index]);
      expect(identified.hex(), SEEDS[index]).toBe(expected[index]);
    });
  });

  it('donne le rang et la case de chaque ton de terre, dont la cuisson se déduit au pixel près', () => {
    // La critique (requis 2) : deviner le rang d'après la couleur manquait les tons saturés
    // (glaciers, plages, déserts) et confondait des palettes voisines (forêts pluviales tempérée
    // et tropicale, marécage et mangrove). La carte le dit : recalculer chaque pixel de terre de
    // son ton, de son ombrage et de la teinte de la case qui le prête redonne le pixel cuit.
    const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
    const byte = (value: number) => Math.min(255, Math.max(0, Math.round(value)));
    const biomesSeen = new Set<string>();
    worlds.forEach((world, index) => {
      let land = 0;
      let known = 0;
      let rebuilt = 0;
      let floor = 0;
      for (const [column, row] of CHUNKS) {
        const identity = new Uint8Array(CHUNK_PX * CHUNK_PX);
        const pixels = bakeChunk(world, column, row, identity);
        for (let y = 0; y < CHUNK_PX; y++) {
          for (let x = 0; x < CHUNK_PX; x++) {
            const at = y * CHUNK_PX + x;
            const code = identity[at] ?? 0;
            if (((pixels[at * 4] ?? 0) & 1) === 0) {
              // L'eau, les rivières comprises, n'a pas de ton de terre.
              expect(code).toBe(IDENTITY.none);
              continue;
            }
            land++;
            if (code === IDENTITY.none) continue;
            known++;
            expect(code).toBeLessThanOrEqual(IDENTITY.ranks * IDENTITY.slots);
            const rank = (code - 1) % IDENTITY.ranks;
            const lender = Math.floor((code - 1) / IDENTITY.ranks);
            const px = column * CHUNK_PX + x;
            const py = row * CHUNK_PX + y;
            const sx = Math.floor((px + 0.5) / 4 - 0.5) + (lender % 2);
            const sy = Math.floor((py + 0.5) / 4 - 0.5) + Math.floor(lender / 2);
            const cell =
              Math.min(size.height - 1, Math.max(0, sy)) * size.width +
              (((sx % size.width) + size.width) % size.width);
            const biome = biomes.at(world.layers.biome[cell] ?? 0);
            if (biome === undefined) throw new Error('biome inconnu');
            biomesSeen.add(data.biomes.entries.at(world.layers.biome[cell] ?? 0)?.id ?? '');
            const tone = [biome.shadow, biome.base, biome.light][rank] ?? [0, 0, 0];
            const shade = (pixels[at * 4 + 3] ?? 0) / 255 + 0.5;
            // Un ombrage sous 0,5 (une rive) se range à 0,5 : la cuisson n'en garde pas moins.
            if ((pixels[at * 4 + 3] ?? 0) === 0) floor++;
            const temperature = (world.layers.temperature[cell] ?? 0) / 10;
            const warm = clamp01((temperature - TINT.warmFrom) / TINT.warmSpan);
            const cold = clamp01(-temperature / TINT.coldSpan);
            const red = byte(tone[0] * shade * (1 + TINT.red * warm - TINT.red * cold));
            const green = byte(tone[1] * shade * (1 + TINT.green * warm));
            const blue = byte(tone[2] * shade * (1 - TINT.blue * warm + TINT.blue * cold));
            const close =
              Math.abs((red & 0xfe) - ((pixels[at * 4] ?? 0) & 0xfe)) <= 2 &&
              Math.abs((green & 0xfe) - ((pixels[at * 4 + 1] ?? 0) & 0xfe)) <= 2 &&
              Math.abs(blue - (pixels[at * 4 + 2] ?? 0)) <= 1;
            if (close) rebuilt++;
          }
        }
      }
      const seed = SEEDS[index] ?? '';
      // Tout pixel de terre a son ton, sauf quelques rives d'un fleuve sans voisine de leur biome.
      expect(known / land, seed).toBeGreaterThan(0.999);
      // Tout pixel au ton connu se recalcule, sauf ceux dont l'ombrage a touché son plancher, ou
      // dont la case prêteuse remplace le lit d'un fleuve (sa teinte est celle de la voisine).
      expect(known - rebuilt, seed).toBeLessThanOrEqual(floor + known * 0.002);
    });
    // Les biomes saturés et les palettes voisines de la critique sont là.
    for (const id of [
      'glacier',
      'beach',
      'desert',
      'temperate-rainforest',
      'rainforest',
      'swamp',
    ]) {
      expect(biomesSeen.has(id), id).toBe(true);
    }
  });

  it('pèse les rangs de chaque tuile d’après le motif de la cuisson', () => {
    for (const biome of biomes) {
      if (biome.style === 'water') continue;
      const shares = toneShares(biome);
      expect(shares.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1, 12);
      // La base domine, sauf la glace, plus claire, et la roche, plus contrastée.
      if (biome.style === 'grass') expect(shares[1]).toBeGreaterThan(0.6);
      if (biome.style === 'ice') expect(shares[2]).toBeGreaterThan(0.5);
    }
  });
});
