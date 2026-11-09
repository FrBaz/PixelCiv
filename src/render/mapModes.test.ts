import { describe, expect, it } from 'vitest';
import { loadGameData } from '../core/data';
import { emptyLayers } from '../core/world';
import { parseColor } from './bake';
import { legend, overlayTexels, RIVER_CELL } from './mapModes';

const data = loadGameData();
const modeData = {
  biomes: data.biomes.entries,
  altitudeLevels: data.altitudeLevels.entries,
  resources: data.resources.entries,
};

function index(catalog: { indexOf(id: string): number | undefined }, id: string): number {
  const found = catalog.indexOf(id);
  if (found === undefined) throw new Error(`identifiant inconnu : ${id}`);
  return found;
}

/** Quatre cases : une terre à 450 m, un lac de 30 m, une mer de 2500 m, une rivière. */
function sample() {
  const layers = emptyLayers({ width: 4, height: 1 });
  layers.biome.set([
    index(data.biomes, 'temperate-forest'),
    index(data.biomes, 'lake'),
    index(data.biomes, 'ocean'),
    index(data.biomes, 'river'),
  ]);
  layers.elevation.set([450, 200, -2500, 12]);
  layers.waterDepth.set([0, 30, 2500, 0]);
  layers.deposit.set([index(data.resources, 'copper') + 1, 0, 0, 0]);
  return layers;
}

/** Couleur RGBA du texel `cell`. */
function texel(texels: Uint8Array, cell: number): number[] {
  return Array.from(texels.subarray(cell * 4, cell * 4 + 4));
}

function level(id: string) {
  const found = data.altitudeLevels.entries.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`niveau inconnu : ${id}`);
  return found;
}

describe('modes de carte', () => {
  it('colore le relief par niveau, les eaux par leur profondeur, et marque les rivières', () => {
    const texels = overlayTexels('relief', sample(), modeData);
    expect(texel(texels, 0)).toEqual([...parseColor(level('hill-one').color), RIVER_CELL]);
    // Le lac se range par sa profondeur depuis sa surface, comme une eau côtière.
    expect(texel(texels, 1)).toEqual([...parseColor(level('coastal-water').color), 255]);
    expect(texel(texels, 2)).toEqual([...parseColor(level('ocean').color), 255]);
    // Une case de rivière garde son altitude, et ses pixels d'eau restent des rivières.
    expect(texel(texels, 3)).toEqual([...parseColor(level('plain-one').color), RIVER_CELL]);
  });

  it('colore les biomes par leur couleur de base', () => {
    const layers = sample();
    const texels = overlayTexels('biomes', layers, modeData);
    for (let cell = 0; cell < 4; cell++) {
      const biome = data.biomes.entries.at(layers.biome[cell] ?? 0);
      expect(biome).toBeDefined();
      expect(texel(texels, cell)).toEqual([...parseColor(biome?.palette.base ?? ''), 255]);
    }
  });

  it('ne colore que les gisements en mode ressources', () => {
    const texels = overlayTexels('resources', sample(), modeData);
    const copper = data.resources.entries.at(index(data.resources, 'copper'));
    expect(texel(texels, 0)).toEqual([...parseColor(copper?.color ?? ''), 255]);
    for (let cell = 1; cell < 4; cell++) expect(texel(texels, cell)).toEqual([0, 0, 0, 0]);
  });

  it('légende le relief du sommet aux abysses, et seulement ce que le monde contient', () => {
    const layers = sample();
    const relief = legend('relief', layers, modeData);
    expect(relief).toHaveLength(data.altitudeLevels.entries.length);
    expect(relief.at(0)?.label).toBe('altitude.summit');
    expect(relief.at(-1)?.label).toBe('altitude.abyss');
    // Biomes présents, dans l'ordre des données.
    expect(legend('biomes', layers, modeData).map((entry) => entry.label)).toEqual([
      'biome.ocean',
      'biome.river',
      'biome.lake',
      'biome.temperate-forest',
    ]);
    expect(legend('resources', layers, modeData)).toEqual([
      {
        color: data.resources.entries.at(index(data.resources, 'copper'))?.color,
        label: 'resource.copper',
      },
    ]);
  });
});
