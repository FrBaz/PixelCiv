import { describe, expect, it } from 'vitest';
import { loadGameData } from '../core/data';
import { SEASON_COVERS, VEGETATION_TYPES } from '../core/data/schemas';
import { emptyLayers } from '../core/world';
import {
  encodeAmplitude,
  encodeFlags,
  encodeTemperature,
  seasonPalettes,
  seasonTexels,
} from './seasons';

const { biomes } = loadGameData();

describe('texture des saisons', () => {
  it('code la température par demi-degré, l’amplitude par huitième de degré, bornées', () => {
    expect(encodeTemperature(0)).toBe(128);
    expect(encodeTemperature(-25.5)).toBe(77);
    expect(encodeTemperature(27)).toBe(182);
    expect(encodeTemperature(-80)).toBe(0);
    expect(encodeTemperature(90)).toBe(255);
    expect(encodeAmplitude(12.5)).toBe(100);
    expect(encodeAmplitude(40)).toBe(255);
  });

  it("range l'hémisphère, la végétation et la couverture dans le canal bleu", () => {
    const flags = encodeFlags(true, 5, 3);
    expect(flags & 1).toBe(1);
    expect((flags >> 1) & 7).toBe(5);
    expect((flags >> 4) & 3).toBe(3);
  });

  it('décrit chaque case : climat, hémisphère, végétation, couverture, biome', () => {
    const size = { width: 4, height: 4 };
    const layers = emptyLayers(size);
    const taiga = biomes.indexOf('taiga') ?? 0;
    const lake = biomes.indexOf('lake') ?? 0;
    layers.biome.fill(taiga);
    layers.biome[13] = lake;
    layers.temperature.fill(-35);
    layers.amplitude.fill(150);
    const texels = seasonTexels(size, layers, biomes.entries);
    // Case (1, 0), au nord, de taïga.
    expect(Array.from(texels.subarray(4, 8))).toEqual([
      encodeTemperature(-3.5),
      encodeAmplitude(15),
      encodeFlags(false, VEGETATION_TYPES.indexOf('evergreen'), SEASON_COVERS.indexOf('snow')),
      taiga,
    ]);
    // Case (1, 3), au sud, de lac : de la glace.
    expect(texels[13 * 4 + 2]).toBe(encodeFlags(true, 0, SEASON_COVERS.indexOf('ice')));
    expect(texels[13 * 4 + 3]).toBe(lake);
    // Un rectangle de cases redonne les mêmes texels.
    expect(Array.from(seasonTexels(size, layers, biomes.entries, 1, 3, 2, 1))).toEqual(
      Array.from(texels.subarray(13 * 4, 15 * 4)),
    );
  });

  it('donne une palette de saison à chaque biome couvert, aucune aux autres', () => {
    const palettes = seasonPalettes(biomes.entries);
    expect(palettes).toHaveLength(biomes.entries.length * 3 * 4);
    biomes.entries.forEach((biome, row) => {
      const alpha = palettes[(row * 3 + 1) * 4 + 3];
      expect(alpha).toBe(biome.seasons.cover === 'none' ? 0 : 255);
    });
  });
});
