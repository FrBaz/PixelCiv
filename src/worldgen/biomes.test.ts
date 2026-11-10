import { describe, expect, it } from 'vitest';
import { loadGameData } from '../core/data';
import { Rng } from '../core/rng';
import { WORLD_SIZES, type WorldSize } from '../core/world';
import { classifyBiomes, type BiomeLayers } from './biomes';
import { extremeMonths, generateClimate, type Climate } from './climate';
import { distanceField, neighborTable } from './grid';
import { findOcean, generateHydrology, LAKE, RIVER, type Hydrology } from './hydrology';
import { generateRelief, reliefSettings } from './relief';
import { CylinderSampler } from './sampler';

const data = loadGameData();
const { worldgen, biomes } = data;
const SIZE = WORLD_SIZES.small;

interface World {
  readonly elevation: Float32Array;
  readonly climate: Climate;
  readonly hydrology: Hydrology;
  readonly layers: BiomeLayers;
}

function world(seed: string, size: WorldSize = SIZE): World {
  const sampler = new CylinderSampler(size);
  const rng = new Rng(seed);
  const raw = generateRelief(
    sampler,
    rng,
    { landShare: 0.35, seaLevel: 0, relief: 0.5 },
    reliefSettings(data.worldgen, data.altitudeLevels.entries),
  );
  const ocean = findOcean(raw, size, worldgen.ocean.minShare);
  const climate = generateClimate(sampler, rng, raw, ocean, worldgen.climate, {
    temperature: 0,
    humidity: 1,
  });
  const hydrology = generateHydrology(
    size,
    raw,
    ocean,
    climate.temperature,
    climate.precipitation,
    rng.stream('worldgen.hydrology'),
    worldgen.hydrology,
    { rivers: 1 },
    climate.amplitude,
  );
  const layers = classifyBiomes(
    sampler,
    rng,
    hydrology.elevation,
    climate,
    hydrology,
    worldgen,
    biomes,
  );
  return { elevation: hydrology.elevation, climate, hydrology, layers };
}

const id = (index: number) => biomes.entries[index]?.id ?? '';
const family = (index: number) => biomes.entries[index]?.family ?? '';

describe('biomes', () => {
  // Le salar, rare, naît dans les cuvettes fermées des déserts : « couture » en a un.
  const worlds = ['pixelciv', 'alpha', 'beta', 'gamma', 'delta', 'couture'].map((seed) =>
    world(seed),
  );
  const neighbors = neighborTable(SIZE);
  const count = SIZE.width * SIZE.height;

  it('emploient les 32 biomes de C1 sur quelques mondes (D6)', () => {
    const seen = new Set<string>();
    for (const { layers } of worlds) for (const biome of layers.biome) seen.add(id(biome));
    expect([...seen].sort()).toEqual(biomes.entries.map((biome) => biome.id).sort());
  });

  it('ne placent de plages que sur la seule rangée de terres au contact de la mer (D4)', () => {
    for (const { hydrology, layers } of worlds) {
      for (let cell = 0; cell < count; cell++) {
        const touchesSea = [...Array(8).keys()].some((d) => {
          const other = neighbors[cell * 8 + d] ?? -1;
          return other >= 0 && hydrology.ocean[other] === 1;
        });
        const coast = family(layers.biome[cell] ?? 0) === 'coast';
        // Toute côte touche la mer ; toute terre ordinaire qui touche la mer est une côte.
        if (coast) expect(touchesSea).toBe(true);
        if (touchesSea && !hydrology.ocean[cell] && hydrology.lake[cell] === LAKE.none) {
          const kind = id(layers.biome[cell] ?? 0);
          expect(coast || kind === 'glacier' || kind === 'river').toBe(true);
        }
      }
    }
  });

  it('ne mettent de glacier que là où le mois le plus chaud reste sous 0 °C (D13)', () => {
    let glaciers = 0;
    for (const { climate, hydrology, layers } of worlds) {
      for (let cell = 0; cell < count; cell++) {
        const { warmest } = extremeMonths(
          climate.temperature[cell] ?? 0,
          climate.amplitude[cell] ?? 0,
        );
        const glacier = id(layers.biome[cell] ?? 0) === 'glacier';
        if (glacier) {
          glaciers++;
          expect(warmest).toBeLessThan(0);
        } else if (
          !hydrology.ocean[cell] &&
          (hydrology.lake[cell] === LAKE.none || hydrology.lake[cell] === LAKE.saltFlat)
        ) {
          // Inversement, toute terre dont le mois le plus chaud gèle est un glacier, un
          // salar compris, terre émergée (D2).
          expect(warmest).toBeGreaterThanOrEqual(0);
        }
        if (id(layers.biome[cell] ?? 0) === 'salar' || id(layers.biome[cell] ?? 0) === 'salt-lake')
          expect(warmest).toBeGreaterThanOrEqual(0);
      }
    }
    expect(glaciers).toBeGreaterThan(0);
  });

  it('suivent la limite des arbres : toundra ou alpin sous 10 °C au mois le plus chaud (D13)', () => {
    for (const { climate, layers } of worlds) {
      for (let cell = 0; cell < count; cell++) {
        const kind = id(layers.biome[cell] ?? 0);
        const { warmest, coldest } = extremeMonths(
          climate.temperature[cell] ?? 0,
          climate.amplitude[cell] ?? 0,
        );
        if (kind === 'tundra' || kind === 'alpine') expect(warmest).toBeLessThan(10);
        if (kind === 'taiga') {
          expect(coldest).toBeLessThan(-3);
          expect(warmest).toBeGreaterThanOrEqual(10);
        }
        if (['rainforest', 'tropical-forest', 'tropical-grassland', 'savanna'].includes(kind)) {
          expect(coldest).toBeGreaterThanOrEqual(18);
        }
        const tree = biomes.entries[layers.biome[cell] ?? 0]?.flora.trees ?? 0;
        if (warmest < 10 && family(layers.biome[cell] ?? 0) !== 'water')
          expect(tree).toBeLessThan(0.3);
      }
    }
  });

  it('rangent la mer par profondeur, les lacs par bilan, et les fleuves à part', () => {
    for (const { elevation, hydrology, layers } of worlds) {
      for (let cell = 0; cell < count; cell++) {
        const kind = id(layers.biome[cell] ?? 0);
        if (hydrology.ocean[cell]) {
          const depth = -(elevation[cell] ?? 0);
          expect(kind).toBe(depth < 200 ? 'coastal-ocean' : depth < 1000 ? 'ocean' : 'deep-ocean');
          continue;
        }
        const lake = hydrology.lake[cell];
        if (lake === LAKE.fresh) expect(kind).toBe('lake');
        if (lake === LAKE.salt) expect(kind).toBe('salt-lake');
        if (lake === LAKE.saltFlat) expect(kind).toBe('salar');
        if (kind === 'river') expect(layers.river[cell]).toBe(RIVER.major);
      }
    }
  });

  it("n'ont de zones humides que sur des terres plates, basses et humides, près d'une eau (D5)", () => {
    const { maxAltitude, maxSlope, minPrecipitation, waterDistance } = worldgen.wetlands;
    let wetlands = 0;
    for (const { elevation, climate, hydrology, layers } of worlds) {
      const { ocean, lake, river, smallDepression } = hydrology;
      // Pente de chaque case (plus forte descente vers un voisin), et la plus forte des
      // terres « plates » : les maxSlope plus plates.
      const slope = new Float64Array(count);
      const landSlopes: number[] = [];
      for (let cell = 0; cell < count; cell++) {
        for (let d = 0; d < 8; d++) {
          const other = neighbors[cell * 8 + d] ?? -1;
          if (other < 0) continue;
          const drop = Math.abs((elevation[cell] ?? 0) - Math.max(0, elevation[other] ?? 0));
          slope[cell] = Math.max(slope[cell] ?? 0, drop / (d % 2 === 0 ? 1 : Math.SQRT2));
        }
        if (!ocean[cell] && lake[cell] === LAKE.none) landSlopes.push(slope[cell] ?? 0);
      }
      landSlopes.sort((a, b) => a - b);
      const flat = landSlopes[Math.floor(maxSlope * (landSlopes.length - 1))] ?? 0;
      const water = new Uint8Array(count);
      for (let cell = 0; cell < count; cell++) {
        const open = ocean[cell] || lake[cell] === LAKE.fresh || lake[cell] === LAKE.salt;
        water[cell] = open || river[cell] ? 1 : 0;
      }
      const distance = distanceField(water, SIZE, neighbors);
      for (let cell = 0; cell < count; cell++) {
        if (family(layers.biome[cell] ?? 0) !== 'wetland') continue;
        wetlands++;
        expect(elevation[cell] ?? 0).toBeLessThanOrEqual(maxAltitude);
        expect(climate.precipitation[cell] ?? 0).toBeGreaterThanOrEqual(minPrecipitation);
        expect(slope[cell] ?? 0).toBeLessThanOrEqual(flat);
        // Près d'une eau, en cases d'une carte Grand, ou dans une petite cuvette drainée.
        const near = (distance[cell] ?? Infinity) <= (waterDistance * SIZE.width) / 1024;
        expect(near || smallDepression[cell] === 1).toBe(true);
        // Ni sur la côte, ni dans le lit d'un fleuve.
        expect(river[cell]).not.toBe(RIVER.major);
        for (let d = 0; d < 8; d++) expect(ocean[neighbors[cell * 8 + d] ?? cell]).toBe(0);
        const temperature = climate.temperature[cell] ?? 0;
        const kind = id(layers.biome[cell] ?? 0);
        expect(kind).toBe(temperature < 3 ? 'bog' : temperature < 22 ? 'marsh' : 'swamp');
      }
    }
    expect(wetlands).toBeGreaterThan(0);
  });

  it('gardent leur part à toutes les tailles, en taches sans case isolée (D5)', () => {
    // Un monde Petit est un monde Grand vu de plus loin (ADR 0009) : les zones humides y
    // gardent à peu près leur part des terres, aperçu de l'écran de création compris.
    const sizes = [{ width: 256, height: 128 }, SIZE, WORLD_SIZES.medium];
    const shares = sizes.map((size) => {
      const { hydrology, layers } = world('pixelciv', size);
      let land = 0;
      let wet = 0;
      for (let cell = 0; cell < size.width * size.height; cell++) {
        if (hydrology.ocean[cell]) continue;
        land++;
        if (family(layers.biome[cell] ?? 0) === 'wetland') wet++;
      }
      if (size === WORLD_SIZES.medium) {
        // Une tache y couvre au moins 2 × 2 cases : chaque case est dans un tel carré.
        const { width, height } = size;
        const wetAt = (x: number, y: number) =>
          y >= 0 &&
          y < height &&
          family(layers.biome[y * width + ((x + width) % width)] ?? 0) === 'wetland';
        for (let cell = 0; cell < width * height; cell++) {
          if (family(layers.biome[cell] ?? 0) !== 'wetland') continue;
          const x = cell % width;
          const y = (cell - x) / width;
          const squares = [0, -1].flatMap((ox) => [0, -1].map((oy) => [x + ox, y + oy] as const));
          const inSquare = squares.some(
            ([sx, sy]) =>
              wetAt(sx, sy) && wetAt(sx + 1, sy) && wetAt(sx, sy + 1) && wetAt(sx + 1, sy + 1),
          );
          expect(inSquare).toBe(true);
        }
      }
      return wet / land;
    });
    const reference = shares[1] ?? 0;
    expect(reference).toBeGreaterThan(0.01);
    for (const share of shares) {
      expect(share / reference).toBeGreaterThan(0.6);
      expect(share / reference).toBeLessThan(1.5);
    }
  });

  it("n'ont pas de rivière sur les glaciers, et gardent les autres", () => {
    for (const { hydrology, layers } of worlds) {
      for (let cell = 0; cell < count; cell++) {
        if (id(layers.biome[cell] ?? 0) === 'glacier') expect(layers.river[cell]).toBe(RIVER.none);
        else expect(layers.river[cell]).toBe(hydrology.river[cell]);
      }
    }
  });

  it('donnent des déserts et des forêts pluviales, mais pas partout', () => {
    for (const { hydrology, layers } of worlds) {
      const shares = new Map<string, number>();
      let land = 0;
      for (let cell = 0; cell < count; cell++) {
        if (hydrology.ocean[cell]) continue;
        land++;
        const kind = id(layers.biome[cell] ?? 0);
        shares.set(kind, (shares.get(kind) ?? 0) + 1);
      }
      const share = (kind: string) => (shares.get(kind) ?? 0) / land;
      expect(share('desert')).toBeGreaterThan(0.01);
      expect(share('desert')).toBeLessThan(0.2);
      expect(share('glacier')).toBeLessThan(0.25);
      expect(share('temperate-forest') + share('taiga') + share('rainforest')).toBeGreaterThan(0.1);
    }
  });
});
