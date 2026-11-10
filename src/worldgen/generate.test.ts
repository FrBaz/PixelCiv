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
import { seamOutliers } from './seamCheck';
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

  it('mène toute rivière à la mer ou à un lac, sous les glaciers compris (PLAN 1.4)', () => {
    // Le monde gardé et dessiné : sur un glacier, la rivière n'a plus de classe, mais son
    // eau suit encore l'écoulement, sous la glace, jusqu'à la mer, à un lac ou au bord des
    // pôles.
    const outlets = new Set(['deep-ocean', 'ocean', 'coastal-ocean', 'lake', 'salt-lake', 'salar']);
    let underIce = 0;
    for (const seed of ['cohérence', 'alpha', 'beta']) {
      const size = WORLD_SIZES.small;
      const layers = generate(seed, size);
      const neighbors = neighborTable(size);
      const count = size.width * size.height;
      const id = (cell: number) => biomes.entries.at(layers.biome[cell] ?? 0)?.id ?? '';
      // Issue de chaque case : 1 si son eau gagne une mer ou un lac, 2 en passant sous un
      // glacier, -1 sans issue ; 0 tant qu'elle n'est pas connue.
      const fate = new Int8Array(count);
      const stuck: number[] = [];
      for (let start = 0; start < count; start++) {
        if (riverClass(layers.drainage[start] ?? 0) === 0 || fate[start] !== 0) continue;
        const path: number[] = [];
        let cell = start;
        let result = 0;
        while (result === 0) {
          // Le bord des pôles est un exutoire : l'eau y quitte la carte.
          const edge = cell < size.width || cell >= count - size.width;
          if (fate[cell] !== 0) result = fate[cell] ?? -1;
          else if (outlets.has(id(cell)) || edge) result = 1;
          else {
            const direction = flowDirection(layers.drainage[cell] ?? 0);
            const next = direction < 8 ? (neighbors[cell * 8 + direction] ?? -1) : -1;
            path.push(cell);
            if (next < 0 || path.length > count) result = -1;
            else cell = next;
          }
        }
        // En remontant le chemin : l'issue, et le passage sous un glacier.
        for (let index = path.length - 1; index >= 0; index--) {
          const here = path[index] ?? 0;
          if (result === 1 && id(here) === 'glacier') result = 2;
          fate[here] = result;
        }
        if (result < 0) stuck.push(start);
      }
      expect(stuck).toEqual([]);
      for (let cell = 0; cell < count; cell++) {
        if (fate[cell] === 2 && riverClass(layers.drainage[cell] ?? 0) > 0) underIce++;
      }
    }
    // Le cas des glaciers se présente bien dans ces mondes.
    expect(underIce).toBeGreaterThan(0);
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
    for (const name of [
      'elevation',
      'waterDepth',
      'temperature',
      'amplitude',
      'precipitation',
      'trees',
      'shrubs',
    ] as const) {
      expect(seamOutliers(layers[name], size), name).toBeLessThan(0.2);
    }
    // Couches de catégories : un changement compte 1, quel qu'il soit.
    const differs = (a: number, b: number) => (a === b ? 0 : 1);
    const directions = layers.drainage.map((code) => flowDirection(code));
    for (const [name, field] of [
      ['deposit', layers.deposit],
      ['drainage', directions],
    ] as const) {
      expect(seamOutliers(field, size, differs), name).toBeLessThan(0.2);
    }
    // Les biomes changent d'une colonne à l'autre aussi souvent à la couture qu'ailleurs.
    let changes = 0;
    let seamChanges = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const a = layers.biome[y * width + x] ?? 0;
        const b = layers.biome[y * width + ((x + 1) % width)] ?? 0;
        if (a === b) continue;
        if (x === width - 1) seamChanges++;
        else changes++;
      }
    }
    const perColumn = changes / (width - 1);
    expect(seamChanges).toBeLessThan(2 * perColumn + 5);
    expect(seamChanges).toBeGreaterThan(perColumn / 3);
    // Les rivières passent la couture dans les deux sens, comme d'une colonne à l'autre.
    const east = new Set([0, 1, 7]);
    const west = new Set([3, 4, 5]);
    const crossing = (drainage: number, directions: Set<number>) =>
      riverClass(drainage) > 0 && directions.has(flowDirection(drainage)) ? 1 : 0;
    let crossings = 0;
    let seamCrossings = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const here = y * width + x;
        const next = y * width + ((x + 1) % width);
        const count =
          crossing(layers.drainage[here] ?? 0, east) + crossing(layers.drainage[next] ?? 0, west);
        if (x === width - 1) seamCrossings += count;
        else crossings += count;
      }
    }
    expect(seamCrossings).toBeGreaterThan(0);
    expect(seamCrossings).toBeLessThan(3 * (crossings / (width - 1)) + 5);
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
