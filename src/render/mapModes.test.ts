import { describe, expect, it } from 'vitest';
import { loadGameData } from '../core/data';
import { emptyLayers } from '../core/world';
import { parseColor } from './bake';
import { BIOME_RESOURCE, legend, overlayTexels, RIVER_CELL } from './mapModes';

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
    const texels = overlayTexels('relief', sample(), modeData, 4);
    expect(texel(texels, 0)).toEqual([...parseColor(level('hill-one').color), RIVER_CELL]);
    // Le lac se range par sa profondeur depuis sa surface, comme une eau côtière.
    expect(texel(texels, 1)).toEqual([...parseColor(level('coastal-water').color), 255]);
    expect(texel(texels, 2)).toEqual([...parseColor(level('ocean').color), 255]);
    // Une case de rivière garde son altitude, et ses pixels d'eau restent des rivières.
    expect(texel(texels, 3)).toEqual([...parseColor(level('plain-one').color), RIVER_CELL]);
  });

  it('colore les biomes par leur couleur de base', () => {
    const layers = sample();
    const texels = overlayTexels('biomes', layers, modeData, 4);
    for (let cell = 0; cell < 4; cell++) {
      const biome = data.biomes.entries.at(layers.biome[cell] ?? 0);
      expect(biome).toBeDefined();
      expect(texel(texels, cell)).toEqual([...parseColor(biome?.palette.base ?? ''), 255]);
    }
  });

  it('colore les gisements en plein, et pas les ressources partout présentes', () => {
    const texels = overlayTexels('resources', sample(), modeData, 4);
    const copper = data.resources.entries.at(index(data.resources, 'copper'));
    expect(texel(texels, 0)).toEqual([...parseColor(copper?.color ?? ''), 255]);
    // Le poisson des lacs, des mers et des fleuves ne se peint pas : il est partout.
    for (let cell = 1; cell < 4; cell++) expect(texel(texels, cell)).toEqual([0, 0, 0, 0]);
  });

  it('teinte les milieux humides et salés de leurs ressources (RES-05)', () => {
    // Une ligne de quatre cases : tourbière, tourbière, marais, lac salé ; puis une autre
    // ligne de tourbière, pour les carrés de 2 × 2 cases.
    const layers = emptyLayers({ width: 4, height: 3 });
    const bog = index(data.biomes, 'bog');
    layers.biome.fill(bog);
    layers.biome[2] = index(data.biomes, 'marsh');
    layers.biome[3] = index(data.biomes, 'salt-lake');
    const texels = overlayTexels('resources', layers, modeData, 4);
    const color = (id: string) => [
      ...parseColor(data.resources.entries.at(index(data.resources, id))?.color ?? ''),
      BIOME_RESOURCE,
    ];
    expect(texel(texels, 0)).toEqual(color('peat'));
    expect(texel(texels, 2)).toEqual(color('reeds'));
    expect(texel(texels, 3)).toEqual(color('salt'));
    // La tourbière porte aussi du fer des marais, qui alterne avec la tourbe.
    expect(texel(texels, 4 * 2)).toEqual(color('bog-iron'));
    expect(legend('resources', layers, modeData).map((entry) => entry.label)).toEqual([
      'resource.salt',
      'resource.reeds',
      'resource.peat',
      'resource.bog-iron',
    ]);
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
