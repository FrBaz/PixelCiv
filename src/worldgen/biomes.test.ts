import { describe, expect, it } from 'vitest';
import { loadGameData } from '../core/data';
import { Rng } from '../core/rng';
import { WORLD_SIZES } from '../core/world';
import { classifyBiomes, type BiomeLayers } from './biomes';
import { extremeMonths, generateClimate, type Climate } from './climate';
import { neighborTable } from './grid';
import { findOcean, generateHydrology, LAKE, RIVER, type Hydrology } from './hydrology';
import { generateRelief } from './relief';
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

function world(seed: string): World {
  const sampler = new CylinderSampler(SIZE);
  const rng = new Rng(seed);
  const raw = generateRelief(sampler, rng, { landShare: 0.35, seaLevel: 0, relief: 0.5 });
  const ocean = findOcean(raw, SIZE, worldgen.ocean.minShare);
  const climate = generateClimate(sampler, rng, raw, ocean, worldgen.climate, {
    temperature: 0,
    humidity: 1,
  });
  const hydrology = generateHydrology(
    SIZE,
    raw,
    ocean,
    climate.temperature,
    climate.precipitation,
    rng.stream('worldgen.hydrology'),
    worldgen.hydrology,
    { rivers: 1 },
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
  const worlds = ['pixelciv', 'alpha', 'beta', 'gamma', 'delta'].map((seed) => world(seed));
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
        } else if (!hydrology.ocean[cell] && hydrology.lake[cell] === LAKE.none) {
          // Inversement, toute terre dont le mois le plus chaud gèle est un glacier.
          expect(warmest).toBeGreaterThanOrEqual(0);
        }
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

  it("n'ont de zones humides que sur des terres plates, basses et humides (D5)", () => {
    let wetlands = 0;
    for (const { elevation, climate, layers } of worlds) {
      for (let cell = 0; cell < count; cell++) {
        if (family(layers.biome[cell] ?? 0) !== 'wetland') continue;
        wetlands++;
        expect(elevation[cell] ?? 0).toBeLessThanOrEqual(worldgen.wetlands.maxAltitude);
        expect(climate.precipitation[cell] ?? 0).toBeGreaterThanOrEqual(
          worldgen.wetlands.minPrecipitation,
        );
        const temperature = climate.temperature[cell] ?? 0;
        const kind = id(layers.biome[cell] ?? 0);
        expect(kind).toBe(temperature < 3 ? 'bog' : temperature < 22 ? 'marsh' : 'swamp');
      }
    }
    expect(wetlands).toBeGreaterThan(0);
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
