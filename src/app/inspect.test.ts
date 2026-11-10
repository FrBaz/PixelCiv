import { describe, expect, it } from 'vitest';
import { loadGameData } from '../core/data';
import { emptyLayers, encodeDrainage } from '../core/world';
import { describeCell } from './inspect';

const data = loadGameData();
const size = { width: 4, height: 4 };

function world() {
  const layers = emptyLayers(size);
  layers.biome.fill(data.biomes.indexOf('steppe') ?? 0);
  layers.elevation.fill(620);
  layers.temperature.fill(85);
  layers.amplitude.fill(120);
  layers.precipitation.fill(410);
  layers.trees.fill(51);
  layers.shrubs.fill(255);
  // Case (2, 1) : un lac de 40 m, à 300 m d'altitude.
  layers.biome[6] = data.biomes.indexOf('lake') ?? 0;
  layers.elevation[6] = 300;
  layers.waterDepth[6] = 40;
  // Case (3, 0) : une rivière et un gisement d'or.
  layers.drainage[3] = encodeDrainage(2, 2);
  layers.deposit[3] = (data.resources.indexOf('gold') ?? 0) + 1;
  return layers;
}

describe("inspection d'une case", () => {
  it('décrit la case : biome, niveau, climat, flore', () => {
    const cell = describeCell(world(), size, 1, 2, 0.5, data);
    expect(cell).toMatchObject({
      x: 1,
      y: 2,
      biome: 'biome.steppe',
      level: 'altitude.hill-two',
      elevation: 620,
      depth: 0,
      temperature: 8.5,
      precipitation: 410,
      river: 0,
      deposit: undefined,
      resources: ['resource.game'],
      trees: 20,
      shrubs: 100,
    });
  });

  it('nomme les ressources du milieu, et la pluie du mois (SAI-02)', () => {
    const layers = world();
    layers.biome[0] = data.biomes.indexOf('bog') ?? 0;
    expect(describeCell(layers, size, 0, 0, 0.5, data)?.resources).toEqual([
      'resource.peat',
      'resource.bog-iron',
    ]);
    // Sur douze mois, la pluie des mois redonne la pluie annuelle.
    let year = 0;
    for (let month = 0; month < 12; month++) {
      year += describeCell(layers, size, 1, 1, month + 0.5, data)?.monthlyPrecipitation ?? 0;
    }
    expect(year).toBeCloseTo(410, 6);
  });

  it('suit les saisons de chaque hémisphère : la mi-janvier est froide au nord', () => {
    // Au nord (ligne 1), à la mi-janvier, la température s'écarte de presque toute
    // l'amplitude sous la moyenne ; au sud (ligne 2), au-dessus.
    const north = describeCell(world(), size, 0, 1, 0.5, data);
    const south = describeCell(world(), size, 0, 2, 0.5, data);
    expect(north?.monthly).toBeCloseTo(8.5 - 12, 5);
    expect(south?.monthly).toBeCloseTo(8.5 + 12, 5);
    expect(describeCell(world(), size, 0, 1, 6.5, data)?.monthly).toBeCloseTo(8.5 + 12, 5);
  });

  it('range un lac par sa profondeur, et nomme rivière et gisement', () => {
    const lake = describeCell(world(), size, 2, 1, 0, data);
    expect(lake).toMatchObject({ biome: 'biome.lake', depth: 40, level: 'altitude.coastal-water' });
    const river = describeCell(world(), size, 3, 0, 0, data);
    expect(river).toMatchObject({ river: 2, deposit: 'resource.gold' });
  });

  it('boucle en x, et ne décrit rien hors des pôles', () => {
    expect(describeCell(world(), size, -1, 0, 0, data)?.x).toBe(3);
    expect(describeCell(world(), size, 6.5, 0, 0, data)?.x).toBe(2);
    expect(describeCell(world(), size, 0, -0.5, 0, data)).toBeUndefined();
    expect(describeCell(world(), size, 0, 4, 0, data)).toBeUndefined();
    expect(describeCell(world(), size, Number.NaN, 0, 0, data)).toBeUndefined();
  });
});
