import { describe, expect, it } from 'vitest';
import { altitudeLevelIndex } from '../core/altitude';
import { loadGameData } from '../core/data';
import { WORLD_SIZES } from '../core/world';
import { defaultWorldParams } from '../core/worldParams';
import { generateWorld } from './generate';

const data = loadGameData();
const { biomes, resources, altitudeLevels, worldgen } = data;
const SIZE = WORLD_SIZES.small;

function world(seed: string) {
  return generateWorld(
    { ...defaultWorldParams(worldgen.parameters, seed, 'small'), size: SIZE },
    data,
  );
}

describe('ressources et flore', () => {
  const worlds = ['pixelciv', 'alpha', 'beta', 'gamma'].map((seed) => world(seed));
  const count = SIZE.width * SIZE.height;

  it('ne placent de gisements que sur les terres, aux étages et biomes de chaque minerai', () => {
    for (const layers of worlds) {
      for (let cell = 0; cell < count; cell++) {
        const code = layers.deposit[cell] ?? 0;
        if (code === 0) continue;
        const resource = resources.entries.at(code - 1);
        const biome = biomes.entries.at(layers.biome[cell] ?? 0);
        expect(resource?.deposit).toBeDefined();
        expect(biome?.family).not.toBe('water');
        const level = altitudeLevels.entries.at(
          altitudeLevelIndex(altitudeLevels.entries, layers.elevation[cell] ?? 0),
        );
        const families: readonly string[] = resource?.deposit?.altitudes ?? [];
        const admitted =
          (level !== undefined && families.includes(level.family)) ||
          (resource?.deposit?.biomes ?? []).includes(biome?.id ?? '');
        expect(admitted).toBe(true);
      }
    }
  });

  it('trouve chacun des neuf minerais de RES-01, plus ou moins rares', () => {
    const totals = new Map<string, number>();
    for (const layers of worlds) {
      for (const code of layers.deposit) {
        if (code === 0) continue;
        const id = resources.entries.at(code - 1)?.id ?? '';
        totals.set(id, (totals.get(id) ?? 0) + 1);
      }
    }
    const minerals = resources.entries
      .filter((resource) => resource.kind === 'mineral')
      .map((resource) => resource.id);
    expect(minerals.sort()).toEqual([
      'coal',
      'copper',
      'gems',
      'gold',
      'iron',
      'salt',
      'silver',
      'stone',
      'tin',
    ]);
    for (const id of minerals) expect(totals.get(id) ?? 0).toBeGreaterThan(0);
    // La pierre est commune, les gemmes rares.
    expect(totals.get('stone') ?? 0).toBeGreaterThan((totals.get('gems') ?? 0) * 5);
  });

  it('regroupe les gisements en provinces', () => {
    // Un gisement de cuivre a bien plus souvent un gisement de cuivre dans son voisinage
    // que si les gisements étaient semés au hasard sur les cases qui admettent le cuivre.
    const layers = worlds[1] ?? world('alpha');
    const { width, height } = SIZE;
    const copper = resources.entries.find((resource) => resource.id === 'copper');
    const code = (resources.indexOf('copper') ?? 0) + 1;
    const families = new Set<string>(copper?.deposit?.altitudes ?? []);
    const admits = (cell: number) => {
      if (biomes.entries.at(layers.biome[cell] ?? 0)?.family === 'water') return false;
      const level = altitudeLevels.entries.at(
        altitudeLevelIndex(altitudeLevels.entries, layers.elevation[cell] ?? 0),
      );
      return families.has(level?.family ?? '');
    };
    let deposits = 0;
    let admitted = 0;
    let neighbors = 0;
    let admittedNeighbors = 0;
    for (let y = 3; y < height - 3; y++) {
      for (let x = 0; x < width; x++) {
        if (admits(y * width + x)) admitted++;
        if (layers.deposit[y * width + x] !== code) continue;
        deposits++;
        for (let dy = -3; dy <= 3; dy++) {
          for (let dx = -3; dx <= 3; dx++) {
            if (dx === 0 && dy === 0) continue;
            const other = (y + dy) * width + ((x + dx + width) % width);
            if (layers.deposit[other] === code) neighbors++;
            if (admits(other)) admittedNeighbors++;
          }
        }
      }
    }
    expect(deposits).toBeGreaterThan(10);
    // Au hasard, chaque voisin admis serait un gisement avec la probabilité deposits / admitted.
    const scattered = (admittedNeighbors * deposits) / admitted;
    expect(neighbors).toBeGreaterThan(2 * scattered);
  });

  it('tire le sel des salars, des marais littoraux et des déserts (RES-05)', () => {
    const salt = (resources.indexOf('salt') ?? 0) + 1;
    for (const layers of worlds) {
      for (let cell = 0; cell < count; cell++) {
        if (layers.deposit[cell] !== salt) continue;
        expect(['salar', 'coastal-marsh', 'desert']).toContain(
          biomes.entries.at(layers.biome[cell] ?? 0)?.id,
        );
      }
    }
    // Les milieux humides et salés portent leurs ressources propres.
    const resourcesOf = (id: string) =>
      biomes.entries.find((biome) => biome.id === id)?.resources ?? [];
    expect(resourcesOf('marsh')).toContain('reeds');
    expect(resourcesOf('bog')).toEqual(expect.arrayContaining(['peat', 'bog-iron']));
    expect(resourcesOf('salar')).toContain('salt');
    expect(resourcesOf('salt-lake')).toContain('salt');
  });

  it('donne aux forêts des arbres, aux déserts et aux glaciers presque rien', () => {
    for (const layers of worlds) {
      const sums = new Map<string, { trees: number; cells: number }>();
      let outside = 0;
      for (let cell = 0; cell < count; cell++) {
        const biome = biomes.entries.at(layers.biome[cell] ?? 0);
        if (biome === undefined) continue;
        const sum = sums.get(biome.id) ?? { trees: 0, cells: 0 };
        sum.trees += layers.trees[cell] ?? 0;
        sum.cells++;
        sums.set(biome.id, sum);
        // Autour de la densité du biome, à ±35 %.
        const base = biome.flora.trees * 255;
        const trees = layers.trees[cell] ?? 0;
        const high = Math.min(255, Math.ceil(base * 1.35 + 0.5));
        if (trees > high || trees < Math.floor(base * 0.65 - 0.5)) outside++;
      }
      expect(outside).toBe(0);
      const mean = (id: string) => {
        const sum = sums.get(id);
        return sum === undefined ? Number.NaN : sum.trees / sum.cells;
      };
      expect(mean('temperate-forest')).toBeGreaterThan(150);
      expect(mean('glacier')).toBe(0);
      expect(mean('deep-ocean')).toBe(0);
      if (sums.has('desert')) expect(mean('desert')).toBeLessThan(0.05 * 255);
    }
    expect(worlds.some((layers) => layers.biome.includes(biomes.indexOf('desert') ?? -1))).toBe(
      true,
    );
  });
});
