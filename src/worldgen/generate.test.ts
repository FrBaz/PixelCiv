import { describe, expect, it } from 'vitest';
import { loadGameData } from '../core/data';
import {
  flowDirection,
  GENERATION_STAGES,
  layersFingerprint,
  riverClass,
  WORLD_SIZES,
  type GenerationStage,
  type WorldSize,
} from '../core/world';
import { defaultWorldParams, type WorldParams } from '../core/worldParams';
import { generateWorld } from './generate';
import { neighborTable } from './grid';

const data = loadGameData();
const { biomes, worldgen } = data;

function params(seed: string, overrides: Partial<WorldParams> = {}): WorldParams {
  return { ...defaultWorldParams(worldgen.parameters, seed, 'small'), ...overrides };
}

function generate(
  seed: string,
  size: WorldSize = WORLD_SIZES.small,
  overrides: Partial<WorldParams> = {},
) {
  return generateWorld({ ...params(seed, overrides), size }, data);
}

describe('génération du monde', () => {
  it("passe par les étapes, dans l'ordre", () => {
    const stages: GenerationStage[] = [];
    generateWorld({ ...params('étapes'), size: { width: 128, height: 64 } }, data, (stage) =>
      stages.push(stage),
    );
    expect(stages).toEqual([...GENERATION_STAGES]);
  });

  it('donne le même monde pour la même graine et les mêmes paramètres', () => {
    const size = { width: 256, height: 128 };
    const a = layersFingerprint(generate('pixelciv', size));
    expect(layersFingerprint(generate('pixelciv', size))).toBe(a);
    expect(layersFingerprint(generate('pixelcib', size))).not.toBe(a);
    expect(layersFingerprint(generate('pixelciv', size, { relief: 0.6 }))).not.toBe(a);
  });

  it("tient des couches cohérentes : altitude, profondeur de l'eau, écoulement", () => {
    const size = WORLD_SIZES.small;
    const layers = generate('cohérence', size);
    const neighbors = neighborTable(size);
    const water = new Set(['deep-ocean', 'ocean', 'coastal-ocean', 'lake', 'salt-lake']);
    for (let cell = 0; cell < size.width * size.height; cell++) {
      const biome = biomes.entries.at(layers.biome[cell] ?? 0);
      expect(biome).toBeDefined();
      const sea = ['deep-ocean', 'ocean', 'coastal-ocean'].includes(biome?.id ?? '');
      const elevation = layers.elevation[cell] ?? 0;
      if (sea) expect(elevation).toBeLessThanOrEqual(-1);
      // Seules les eaux ont une profondeur : mer et lacs, et toutes en ont une.
      expect((layers.waterDepth[cell] ?? 0) > 0).toBe(water.has(biome?.id ?? ''));
      if (sea) expect(layers.waterDepth[cell]).toBe(-elevation);
      const direction = flowDirection(layers.drainage[cell] ?? 0);
      expect(direction).toBeLessThanOrEqual(8);
      if (direction < 8) expect(neighbors[cell * 8 + direction]).toBeGreaterThanOrEqual(0);
      const river = riverClass(layers.drainage[cell] ?? 0);
      if (river > 0) expect(direction).toBeLessThan(8);
      if (biome?.id === 'river') expect(river).toBe(3);
    }
  });

  it('suit les paramètres de température et d’humidité', () => {
    const size = { width: 256, height: 128 };
    const mean = (array: Int16Array | Uint16Array) => {
      let sum = 0;
      for (const value of array) sum += value;
      return sum / array.length;
    };
    const base = generate('réglages', size);
    const warm = generate('réglages', size, { temperature: 5 });
    const wet = generate('réglages', size, { humidity: 1.4 });
    expect((mean(warm.temperature) - mean(base.temperature)) / 10).toBeCloseTo(5, 1);
    expect(mean(wet.precipitation) / mean(base.precipitation)).toBeCloseTo(1.4, 1);
  });

  it('se referme sans couture : toutes les couches, biomes et rivières compris', () => {
    const size = WORLD_SIZES.small;
    const { width, height } = size;
    const layers = generate('couture', size);
    /** Écart moyen entre les colonnes x et x + 1, la dernière paire passant la couture. */
    const gaps = (measure: (cell: number, next: number) => number) =>
      Array.from({ length: width }, (_, x) => {
        let sum = 0;
        for (let y = 0; y < height; y++)
          sum += measure(y * width + x, y * width + ((x + 1) % width));
        return sum / height;
      });
    const expectSeamLikeOthers = (values: number[]) => {
      const seam = values[width - 1] ?? 0;
      const others = values.slice(0, width - 1);
      expect(seam).toBeGreaterThanOrEqual(Math.min(...others));
      expect(seam).toBeLessThanOrEqual(Math.max(...others));
    };
    for (const name of [
      'elevation',
      'temperature',
      'amplitude',
      'precipitation',
      'trees',
    ] as const) {
      const field = layers[name];
      expectSeamLikeOthers(gaps((cell, next) => Math.abs((field[next] ?? 0) - (field[cell] ?? 0))));
    }
    // Les biomes changent d'une colonne à l'autre aussi souvent à la couture qu'ailleurs.
    expectSeamLikeOthers(
      gaps((cell, next) => ((layers.biome[cell] ?? 0) === (layers.biome[next] ?? 0) ? 0 : 1)),
    );
    // Autant de rivières passent la couture que d'une colonne à la suivante, dans les deux
    // sens : vers l'est (E, SE, NE), et vers l'ouest depuis la colonne suivante.
    const east = new Set([0, 1, 7]);
    const west = new Set([3, 4, 5]);
    const crossing = (drainage: number, directions: Set<number>) =>
      riverClass(drainage) > 0 && directions.has(flowDirection(drainage)) ? 1 : 0;
    const rivers = gaps(
      (cell, next) =>
        crossing(layers.drainage[cell] ?? 0, east) + crossing(layers.drainage[next] ?? 0, west),
    );
    expect(rivers[width - 1]).toBeGreaterThan(0);
    expectSeamLikeOthers(rivers);
  });

  it("montre les mêmes continents dans l'aperçu réduit", () => {
    const preview = generate('aperçu', { width: 256, height: 128 });
    const full = generate('aperçu', WORLD_SIZES.small);
    let agree = 0;
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 256; x++) {
        const coarse = (preview.elevation[y * 256 + x] ?? 0) >= 0;
        const fine = (full.elevation[2 * y * 512 + 2 * x] ?? 0) >= 0;
        if (coarse === fine) agree++;
      }
    }
    expect(agree / (256 * 128)).toBeGreaterThan(0.9);
  });
});
