import { describe, expect, it } from 'vitest';
import { loadGameData } from '../core/data';
import { SEASON_COVERS, VEGETATION_TYPES } from '../core/data/schemas';
import { FOREST_SNOW_SHARE, seasonFactor, southern } from '../core/seasons';
import { emptyLayers } from '../core/world';
import { parseColor } from './bake';
import { glslFloat } from './glsl';
import { HUMAN_FRAGMENT } from './humanShader';
import { COVER_GLSL, MAP_FRAGMENT } from './mapShader';
import {
  biomeCodes,
  cellSeasonCodes,
  encodeAmplitude,
  encodeFlags,
  encodeTemperature,
  seasonPalettes,
  seasonTexels,
  shadowTones,
  snowShare,
} from './seasons';
import { evaluateGlsl } from './testing';

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

  it("range l'hémisphère, la végétation, la couverture, l'eau et la forêt dans le canal bleu", () => {
    const flags = encodeFlags({ south: true, vegetation: 5, cover: 3, water: true, forest: false });
    expect(flags & 1).toBe(1);
    expect((flags >> 1) & 7).toBe(5);
    expect((flags >> 4) & 3).toBe(3);
    expect((flags >> 6) & 1).toBe(1);
    expect(flags >> 7).toBe(0);
    expect(encodeFlags({ south: false, vegetation: 0, cover: 0, water: false, forest: true })).toBe(
      128,
    );
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
      encodeFlags({
        south: false,
        vegetation: VEGETATION_TYPES.indexOf('evergreen'),
        cover: SEASON_COVERS.indexOf('snow'),
        water: false,
        forest: true,
      }),
      taiga,
    ]);
    // Case (1, 3), au sud, de lac : de la glace.
    expect(texels[13 * 4 + 2]).toBe(
      encodeFlags({
        south: true,
        vegetation: 0,
        cover: SEASON_COVERS.indexOf('ice'),
        water: true,
        forest: false,
      }),
    );
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

describe('neige du décor et ombre « ground » (ADR 0017, § 4 et 5)', () => {
  /** Une case de chaque biome, à des climats variés, dans les deux hémisphères. */
  function sampleWorld() {
    const climates = [-200, -60, -10, 0, 5, 12, 30, 80, 150, 260];
    const amplitudes = [0, 15, 40, 85, 140, 210];
    const size = { width: biomes.entries.length, height: climates.length * amplitudes.length * 2 };
    const layers = emptyLayers(size);
    for (let y = 0; y < size.height; y++) {
      const climate = Math.floor(y / 2) % climates.length;
      const amplitude = Math.floor(Math.floor(y / 2) / climates.length);
      for (let x = 0; x < size.width; x++) {
        const cell = y * size.width + x;
        layers.biome[cell] = x;
        layers.temperature[cell] = (climates[climate] ?? 0) + (x % 3);
        layers.amplitude[cell] = amplitudes[amplitude] ?? 0;
      }
    }
    return { size, layers };
  }

  it('lit pour chaque case les codes de la texture des saisons, à l’octet près', () => {
    const { size, layers } = sampleWorld();
    const texels = seasonTexels(size, layers, biomes.entries);
    const codes = biomeCodes(biomes.entries);
    for (let cell = 0; cell < size.width * size.height; cell++) {
      const south = southern(Math.floor(cell / size.width), size.height);
      const code = cellSeasonCodes(layers, codes, cell, south);
      expect([code.temperature, code.amplitude, code.flags]).toEqual([
        texels[cell * 4],
        texels[cell * 4 + 1],
        texels[cell * 4 + 2],
      ]);
    }
  });

  it('enneige le décor de la part de neige que pose le shader de la carte, évaluée hors du GPU', () => {
    const { size, layers } = sampleWorld();
    const texels = seasonTexels(size, layers, biomes.entries);
    let snowy = 0;
    let forest = 0;
    for (const month of [0.5, 2.25, 6.5, 10.75, 11.9]) {
      const season = seasonFactor(month);
      for (let cell = 0; cell < size.width * size.height; cell++) {
        // Le texel de la case, normalisé comme le lit le GPU, puis chaque expression du shader.
        const variables: Record<string, number> = {
          'data.r': (texels[cell * 4] ?? 0) / 255,
          'data.g': (texels[cell * 4 + 1] ?? 0) / 255,
          'data.b': (texels[cell * 4 + 2] ?? 0) / 255,
          uSeason: Math.fround(season),
        };
        for (const name of [
          'temperature',
          'amplitude',
          'flags',
          'south',
          'cover',
          'waterCell',
          'forest',
          'monthly',
          'snow',
          'forestSnow',
        ] as const) {
          variables[name] = evaluateGlsl(COVER_GLSL[name], variables);
        }
        // La carte : la neige de la forêt sur une case de terre couverte de neige, rien sinon.
        const land = variables.waterCell === 0 && variables.cover === 1;
        const map = land ? variables.forestSnow : 0;
        const decor = snowShare(
          texels[cell * 4] ?? 0,
          texels[cell * 4 + 1] ?? 0,
          texels[cell * 4 + 2] ?? 0,
          season,
        );
        expect(decor, `case ${String(cell)}, mois ${String(month)}`).toBeCloseTo(map, 5);
        if (map > 0) snowy++;
        if (map > 0 && variables.forest === 1) forest++;
      }
    }
    // Des cases enneigées, de forêt comprises, dont la part garde FOREST_SNOW_SHARE.
    expect(snowy).toBeGreaterThan(100);
    expect(forest).toBeGreaterThan(10);
    expect(COVER_GLSL.forestSnow).toContain(glslFloat(FOREST_SNOW_SHARE));
    // Le shader de la carte, et celui des objets pour l'ombre « ground », lisent ces expressions.
    for (const name of ['monthly', 'snow', 'forestSnow'] as const) {
      expect(MAP_FRAGMENT).toContain(COVER_GLSL[name]);
      expect(HUMAN_FRAGMENT).toContain(COVER_GLSL[name]);
    }
  });

  it('suit le shader pour chaque code de la case : hémisphère, couverture, eau, forêt', () => {
    let checked = 0;
    for (const south of [false, true]) {
      for (let cover = 0; cover < SEASON_COVERS.length; cover++) {
        for (const water of [false, true]) {
          for (const forest of [false, true]) {
            const flags = encodeFlags({ south, vegetation: 2, cover, water, forest });
            for (const temperature of [0, 100, 120, 128, 129, 140]) {
              for (const amplitude of [0, 60, 200]) {
                for (const season of [-1, -0.3, 0.4, 1]) {
                  const variables: Record<string, number> = {
                    'data.r': temperature / 255,
                    'data.g': amplitude / 255,
                    'data.b': flags / 255,
                    uSeason: Math.fround(season),
                  };
                  for (const name of [
                    'temperature',
                    'amplitude',
                    'flags',
                    'south',
                    'cover',
                    'waterCell',
                    'forest',
                    'monthly',
                    'snow',
                    'forestSnow',
                  ] as const) {
                    variables[name] = evaluateGlsl(COVER_GLSL[name], variables);
                  }
                  const land = variables.waterCell === 0 && variables.cover === 1;
                  const map = land ? variables.forestSnow : 0;
                  const label = `drapeaux ${String(flags)}, ${String(temperature)}, ${String(amplitude)}, ${String(season)}`;
                  expect(snowShare(temperature, amplitude, flags, season), label).toBeCloseTo(
                    map,
                    5,
                  );
                  checked++;
                }
              }
            }
          }
        }
      }
    }
    expect(checked).toBe(2 * SEASON_COVERS.length * 2 * 2 * 6 * 3 * 4);
  });

  it('range pour chaque biome son ton d’ombre, puis celui de sa couverture', () => {
    const tones = shadowTones(biomes.entries);
    expect(tones).toHaveLength(biomes.entries.length * 2 * 4);
    biomes.entries.forEach((biome, row) => {
      const at = (column: number) =>
        Array.from(tones.slice((row * 2 + column) * 4, (row * 2 + column) * 4 + 4));
      const cover = biome.seasons.palette?.shadow ?? biome.palette.shadow;
      expect(at(0), biome.id).toEqual([...parseColor(biome.palette.shadow), 255]);
      expect(at(1), biome.id).toEqual([...parseColor(cover), 255]);
    });
  });
});
