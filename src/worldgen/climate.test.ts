import { describe, expect, it } from 'vitest';
import { loadGameData } from '../core/data';
import { Rng } from '../core/rng';
import { WORLD_SIZES, type WorldSize } from '../core/world';
import {
  extremeMonths,
  generateClimate,
  latitude,
  monthlyTemperature,
  rainBand,
  SEASON_PEAK,
  westerlyWeight,
  type Climate,
  type ClimateConfig,
} from './climate';
import { findOcean } from './hydrology';
import { generateRelief } from './relief';
import { CylinderSampler } from './sampler';

const { worldgen } = loadGameData();
const CONFIG: ClimateConfig = worldgen.climate;
const PARAMS = { temperature: 0, humidity: 1 };

interface World {
  readonly size: WorldSize;
  readonly elevation: Float32Array;
  readonly ocean: Uint8Array;
  readonly climate: Climate;
}

function world(seed: string, size: WorldSize = WORLD_SIZES.small): World {
  const sampler = new CylinderSampler(size);
  const rng = new Rng(seed);
  const elevation = generateRelief(sampler, rng, { landShare: 0.35, seaLevel: 0, relief: 0.5 });
  const ocean = findOcean(elevation, size, worldgen.ocean.minShare);
  return {
    size,
    elevation,
    ocean,
    climate: generateClimate(sampler, rng, elevation, ocean, CONFIG, PARAMS),
  };
}

/** Monde de synthèse : de la mer partout, sauf `land`, qui donne l'altitude des terres. */
function synthetic(size: WorldSize, land: (x: number, y: number) => number | undefined): World {
  const { width, height } = size;
  const elevation = new Float32Array(width * height).fill(-3000);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const altitude = land(x, y);
      if (altitude !== undefined) elevation[y * width + x] = altitude;
    }
  }
  const ocean = findOcean(elevation, size, worldgen.ocean.minShare);
  const sampler = new CylinderSampler(size);
  return {
    size,
    elevation,
    ocean,
    climate: generateClimate(sampler, new Rng('synthèse'), elevation, ocean, CONFIG, PARAMS),
  };
}

function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

describe('climat', () => {
  const worlds = ['pixelciv', 'alpha', 'beta', 'gamma'].map((seed) => world(seed));

  it('donne environ 27 °C à l’équateur et −25 °C aux pôles, au niveau de la mer', () => {
    for (const { size, ocean, climate } of worlds) {
      const { width, height } = size;
      const rowMean = (y: number) => {
        const values: number[] = [];
        for (let x = 0; x < width; x++) {
          if (ocean[y * width + x]) values.push(climate.temperature[y * width + x] ?? 0);
        }
        return mean(values);
      };
      expect(rowMean(height / 2)).toBeCloseTo(27, 0);
      expect(rowMean(0)).toBeGreaterThan(-26);
      expect(rowMean(0)).toBeLessThan(-23.5);
      expect(rowMean(height - 1)).toBeLessThan(-23.5);
    }
  });

  it('perd 6,5 °C par 1 000 m', () => {
    const size = { width: 256, height: 128 };
    // Un plateau à 2 000 m au cœur d'un continent plat.
    const flat = synthetic(size, (x, y) =>
      x > 60 && x < 200 && y > 30 && y < 98 ? 100 : undefined,
    );
    const plateau = synthetic(size, (x, y) => {
      if (!(x > 60 && x < 200 && y > 30 && y < 98)) return undefined;
      return x > 120 && x < 140 ? 2100 : 100;
    });
    const index = 64 * 256 + 130;
    const drop = (flat.climate.temperature[index] ?? 0) - (plateau.climate.temperature[index] ?? 0);
    expect(drop).toBeCloseTo(6.5 * 2, 5);
  });

  it('inverse les saisons entre les hémisphères (D8)', () => {
    expect(monthlyTemperature(10, 8, false, 6)).toBeGreaterThan(17);
    expect(monthlyTemperature(10, 8, true, 6)).toBeLessThan(3);
    expect(monthlyTemperature(10, 8, false, 0)).toBeLessThan(3);
    expect(monthlyTemperature(10, 8, true, 0)).toBeGreaterThan(17);
    const { warmest, coldest } = extremeMonths(10, 8);
    expect(warmest).toBeCloseTo(10 + 8 * SEASON_PEAK, 10);
    expect(coldest).toBeCloseTo(10 - 8 * SEASON_PEAK, 10);
    expect(SEASON_PEAK).toBeCloseTo(Math.cos(Math.PI / 12), 12);
  });

  it('suit la demi-amplitude de D8, selon la latitude et la continentalité', () => {
    for (const { size, ocean, climate } of worlds) {
      const { width, height } = size;
      for (let y = 0; y < height; y += 7) {
        const polar = 1 + 15 * Math.pow(latitude(y, height), 1.3);
        for (let x = 0; x < width; x += 5) {
          const index = y * width + x;
          const continentality = climate.continentality[index] ?? 0;
          expect(continentality).toBeGreaterThanOrEqual(0);
          expect(continentality).toBeLessThanOrEqual(1);
          if (ocean[index]) expect(continentality).toBe(0);
          expect(climate.amplitude[index]).toBeCloseTo(polar * (0.75 + 0.5 * continentality), 4);
        }
      }
    }
  });

  it('dessine des bandes de pluie : équateur humide, zone sèche vers 30°, pôles secs', () => {
    expect(rainBand(0)).toBeGreaterThan(0.9);
    expect(rainBand(1 / 3)).toBeLessThan(0.25);
    expect(rainBand(0.6)).toBeGreaterThan(0.6);
    expect(rainBand(1)).toBeLessThan(0.2);
    // Les vents passent de l'un à l'autre sans cassure.
    expect(westerlyWeight(0.1)).toBe(0);
    expect(westerlyWeight(0.5)).toBe(1);
    expect(westerlyWeight(0.9)).toBe(0);
    expect(westerlyWeight(1 / 3)).toBeCloseTo(0.5, 5);
  });

  it('assèche l’intérieur des terres sous la zone sèche subtropicale', () => {
    let dry = 0;
    let land = 0;
    for (const { size, ocean, climate } of worlds) {
      const { width, height } = size;
      for (let y = 0; y < height; y++) {
        const lat = latitude(y, height);
        if (lat < 0.2 || lat > 0.45) continue;
        for (let x = 0; x < width; x++) {
          const index = y * width + x;
          if (ocean[index]) continue;
          land++;
          if ((climate.precipitation[index] ?? 0) < 250) dry++;
        }
      }
    }
    expect(dry / land).toBeGreaterThan(0.08);
  });

  it('arrose le versant au vent et assèche le versant sous le vent (ombre pluviométrique)', () => {
    const size = { width: 512, height: 256 };
    const { width } = size;
    // Un continent de 200 cases de large aux latitudes moyennes du nord (lignes 46 à 82,
    // latitudes 0,64 à 0,36 : les vents d'ouest), barré du nord au sud par une chaîne de
    // 3 000 m en son milieu.
    const inside = (x: number, y: number) => x >= 150 && x < 350 && y >= 46 && y < 82;
    const ridge = synthetic(size, (x, y) => {
      if (!inside(x, y)) return undefined;
      return x >= 245 && x < 255 ? 3000 : 200;
    });
    const plain = synthetic(size, (x, y) => (inside(x, y) ? 200 : undefined));
    const column = (world: World, x: number) => {
      const values: number[] = [];
      // Latitudes 0,55 à 0,43 : le vent d'ouest seul.
      for (let y = 57; y < 73; y++) values.push(world.climate.precipitation[y * width + x] ?? 0);
      return mean(values);
    };
    // Vents d'ouest : l'ouest de la chaîne est au vent, l'est sous le vent.
    const windward = column(ridge, 240);
    const lee = column(ridge, 265);
    expect(windward).toBeGreaterThan(lee * 2);
    expect(lee).toBeLessThan(column(plain, 265) * 0.7);
  });

  it('trouve des déserts d’abri derrière les montagnes des mondes générés', () => {
    let shadows = 0;
    for (const { size, elevation, ocean, climate } of worlds) {
      const { width, height } = size;
      for (let y = 0; y < height; y++) {
        const westerly = westerlyWeight(latitude(y, height)) > 0.5;
        // Le vent vient de l'ouest sous les vents d'ouest, de l'est ailleurs.
        const upwind = westerly ? -1 : 1;
        for (let x = 0; x < width; x++) {
          const index = y * width + x;
          if (ocean[index] || (climate.precipitation[index] ?? 0) >= 300) continue;
          for (let step = 1; step <= 12; step++) {
            const other = y * width + ((x + upwind * step + width) % width);
            if ((elevation[other] ?? 0) >= 1800) {
              shadows++;
              break;
            }
          }
        }
      }
    }
    expect(shadows).toBeGreaterThan(50);
  });

  it('se referme sans couture, températures et pluies comprises', () => {
    for (const { size, climate } of worlds) {
      const { width, height } = size;
      for (const field of [climate.temperature, climate.precipitation]) {
        const gaps = Array.from({ length: width }, (_, x) => {
          let sum = 0;
          for (let y = 0; y < height; y++) {
            sum += Math.abs(
              (field[y * width + ((x + 1) % width)] ?? 0) - (field[y * width + x] ?? 0),
            );
          }
          return sum / height;
        });
        const seam = gaps[width - 1] ?? 0;
        const others = gaps.slice(0, width - 1);
        expect(seam).toBeGreaterThanOrEqual(Math.min(...others));
        expect(seam).toBeLessThanOrEqual(Math.max(...others));
      }
    }
  });

  it('ne dépend pas de la résolution : mêmes pluies par bande de latitude', () => {
    const coarse = world('pixelciv', { width: 256, height: 128 });
    const fine = world('pixelciv');
    const bandMeans = ({ size, ocean, climate }: World) => {
      const sums = new Float64Array(5);
      const counts = new Float64Array(5);
      for (let y = 0; y < size.height; y++) {
        const band = Math.min(4, Math.floor(latitude(y, size.height) * 5));
        for (let x = 0; x < size.width; x++) {
          const index = y * size.width + x;
          if (!ocean[index]) continue;
          sums[band] = (sums[band] ?? 0) + (climate.precipitation[index] ?? 0);
          counts[band] = (counts[band] ?? 0) + 1;
        }
      }
      return Array.from(sums, (sum, band) => sum / (counts[band] ?? 1));
    };
    const a = bandMeans(coarse);
    const b = bandMeans(fine);
    a.forEach((value, band) => {
      expect(value / (b[band] ?? 1)).toBeGreaterThan(0.85);
      expect(value / (b[band] ?? 1)).toBeLessThan(1.15);
    });
  });
});
