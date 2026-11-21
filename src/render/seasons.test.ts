import { describe, expect, it } from 'vitest';
import { loadGameData } from '../core/data';
import { SEASON_COVERS, VEGETATION_TYPES } from '../core/data/schemas';
import { coverShare, seasonFactor, southern } from '../core/seasons';
import {
  coverRamps,
  iceAt,
  phaseDay,
  snowAt,
  worldCalendars,
  type CalendarCover,
} from '../core/snow';
import { emptyLayers, WORLD_SIZES } from '../core/world';
import { fishingCover } from '../sim/cover';
import { testWorld } from '../sim/testing';
import { parseColor } from './bake';
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
  snowShareOn,
  snowThresholdsOn,
} from './seasons';
import { evaluateCover } from './testing';

const data = loadGameData();
const { biomes, seasons } = data;

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

describe('neige du décor et ombre « ground » (ADR 0017, § 4 et 5 ; ADR 0019)', () => {
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
        layers.precipitation[cell] = 120 + 90 * (x % 7);
      }
    }
    const calendars = worldCalendars(size, layers, biomes.entries, seasons);
    return { size, layers, calendars };
  }

  /** La rampe de la couverture d'une case de terre ou d'eau, comme le shader la choisit. */
  const rampOf = (cover: number): readonly [number, number, number] => {
    const { ramp } = cover === 1 ? seasons.snow : cover === 3 ? seasons.seaIce : seasons.freshIce;
    return [ramp.onset, ramp.span, ramp.full];
  };

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
    const { size, layers, calendars } = sampleWorld();
    const texels = seasonTexels(size, layers, biomes.entries);
    let snowy = 0;
    let forest = 0;
    let lingering = 0;
    for (const month of [0.5, 2.25, 3.6, 4.4, 6.5, 8.1, 10.75, 11.9]) {
      const season = seasonFactor(month);
      const day = month * 30;
      for (let cell = 0; cell < size.width * size.height; cell++) {
        const texel = [
          texels[cell * 4] ?? 0,
          texels[cell * 4 + 1] ?? 0,
          texels[cell * 4 + 2] ?? 0,
        ] as const;
        const flags = texel[2];
        // La carte : la neige d'une case de terre couverte de neige, celle des forêts réduite.
        const land = ((flags >> 6) & 1) === 0 && ((flags >> 4) & 3) === 1;
        const { share } = evaluateCover(COVER_GLSL, {
          texel,
          calendar: calendars.subarray(snowAt(cell), snowAt(cell) + 4),
          ramp: rampOf(1),
          season,
          day,
        });
        const keep = flags >> 7 === 1 ? Math.fround(seasons.snow.forest) : 1;
        const map = land ? Math.fround(share * keep) : 0;
        const decor = snowShareOn(
          texel[0],
          texel[1],
          flags,
          calendars,
          snowAt(cell),
          season,
          day,
          seasons,
        );
        expect(decor, `case ${String(cell)}, mois ${String(month)}`).toBeCloseTo(map, 5);
        if (map > 0) snowy++;
        if (map > 0 && flags >> 7 === 1) forest++;
        // Plus de neige au printemps que la rampe de l'instant : l'inertie de la neige.
        const south = (flags & 1) === 1;
        const annual = texel[0] / 2 - 64;
        const ramp = coverShare(
          seasons.snow.ramp,
          annual + (texel[1] / 8) * season * (south ? -1 : 1),
        );
        if (land && month > 3 && month < 6 && !south && map > ramp * keep + 0.1) lingering++;
      }
    }
    // Des cases enneigées, de forêt comprises, et de la neige qui traîne au printemps du nord.
    expect(snowy).toBeGreaterThan(100);
    expect(forest).toBeGreaterThan(10);
    expect(lingering).toBeGreaterThan(10);
    // Le shader de la carte, et celui des objets pour l'ombre « ground », lisent ces expressions.
    for (const name of ['monthly', 'phase', 'most', 'summer', 'now', 'level', 'share'] as const) {
      expect(MAP_FRAGMENT).toContain(COVER_GLSL[name]);
      expect(HUMAN_FRAGMENT).toContain(COVER_GLSL[name]);
    }
  });

  it('suit le shader pour chaque code de la case et chaque jour : hémisphère, couverture, eau, forêt', () => {
    // Des calendriers de toutes les formes : sans inertie, tardifs, longs, au plafond.
    const shapes = [
      [0, 0, 1, 1],
      [60, 200, 12, 12],
      [100, 240, 40, 30],
      [127, 0, 12, 12],
      [10, 244, 255, 255],
    ] as const;
    let checked = 0;
    for (const south of [false, true]) {
      for (let cover = 0; cover < SEASON_COVERS.length; cover++) {
        for (const water of [false, true]) {
          for (const forest of [false, true]) {
            const flags = encodeFlags({ south, vegetation: 2, cover, water, forest });
            for (const temperature of [0, 100, 120, 128, 129, 140]) {
              for (const amplitude of [0, 60, 200]) {
                for (const month of [0.5, 3.3, 6.5, 9.2, 11.8]) {
                  for (const calendar of shapes) {
                    const season = seasonFactor(month);
                    const { share } = evaluateCover(COVER_GLSL, {
                      texel: [temperature, amplitude, flags],
                      calendar,
                      ramp: rampOf(1),
                      season,
                      day: month * 30,
                    });
                    const keep = forest ? Math.fround(seasons.snow.forest) : 1;
                    const map = !water && cover === 1 ? Math.fround(share * keep) : 0;
                    const label = `drapeaux ${String(flags)}, ${String(temperature)}, ${String(amplitude)}, ${String(month)}`;
                    expect(
                      snowShareOn(
                        temperature,
                        amplitude,
                        flags,
                        calendar,
                        0,
                        season,
                        month * 30,
                        seasons,
                      ),
                      label,
                    ).toBeCloseTo(map, 5);
                    checked++;
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(checked).toBe(2 * SEASON_COVERS.length * 2 * 2 * 6 * 3 * 5 * 5);
  });

  it('voit, dans la pêche, la couverture de la carte, au milieu de chaque mois', () => {
    // Critique de la conception, facultatif 2 : la pêche (src/sim/cover.ts) et le shader
    // calculent la même part, depuis les mêmes codes arrondis et les mêmes calendriers.
    const world = testWorld('graine');
    const size = WORLD_SIZES.small;
    const count = size.width * size.height;
    const calendars = worldCalendars(size, world, biomes.entries, seasons);
    const texels = seasonTexels(size, world, biomes.entries);
    const ramps = coverRamps(seasons);
    let covered = 0;
    for (let cell = 0; cell < count; cell += 3) {
      const biome = biomes.entries.at(world.biome[cell] ?? 0);
      const kinds: CalendarCover[] =
        biome?.family === 'water'
          ? biome.seasons.cover === 'none'
            ? []
            : [biome.seasons.cover]
          : ['snow', 'ice'];
      const south = southern(Math.floor(cell / size.width), size.height);
      for (const kind of kinds) {
        const at = kind === 'snow' ? snowAt(cell) : iceAt(cell, count);
        const ramp = ramps[kind];
        for (let tick = 0; tick < 12; tick++) {
          const month = tick + 0.5;
          const season = seasonFactor(month) * (south ? -1 : 1);
          const phase = phaseDay(month * 30, south);
          const fishing = fishingCover(world, calendars, cell, kind, ramp, season, phase);
          const { share } = evaluateCover(COVER_GLSL, {
            texel: [texels[cell * 4] ?? 0, texels[cell * 4 + 1] ?? 0, texels[cell * 4 + 2] ?? 0],
            calendar: calendars.subarray(at, at + 4),
            ramp: [ramp.onset, ramp.span, ramp.full],
            season: seasonFactor(month),
            day: month * 30,
          });
          expect(fishing, `case ${String(cell)}, ${kind}, mois ${String(tick)}`).toBeCloseTo(
            share,
            5,
          );
          if (share > 0) covered++;
        }
      }
    }
    expect(covered).toBeGreaterThan(20_000);
  });

  it("donne au décor les jours où la neige d'une case arrive et part, et eux seuls", () => {
    // Pour chaque case du monde d'essai, jour après jour : l'état enneigé du décor (decorSeason,
    // snow.share) ne change qu'en franchissant l'un des deux seuils de g, ou au jour le plus
    // froid et au plus chaud, où le refroidissement change (DecorSource.refreshStates).
    const { size, layers, calendars } = sampleWorld();
    const texels = seasonTexels(size, layers, biomes.entries);
    const share = data.decor.snow.share;
    let changes = 0;
    let crossings = 0;
    for (let cell = 0; cell < size.width * size.height; cell++) {
      const [t = 0, a = 0, flags = 0] = texels.subarray(cell * 4, cell * 4 + 3);
      const [arrival, departure] = snowThresholdsOn(
        t,
        a,
        flags,
        calendars,
        snowAt(cell),
        share,
        seasons,
      );
      const south = (flags & 1) === 1;
      let before: boolean | undefined;
      let g0 = Number.NaN;
      for (let step = 0; step <= 720; step++) {
        const month = step / 60;
        const factor = seasonFactor(month);
        const g = south ? -factor : factor;
        const snow = snowShareOn(t, a, flags, calendars, snowAt(cell), factor, month * 30, seasons);
        const snowy = snow > 0 && snow >= share;
        if (before !== undefined && snowy !== before) {
          changes++;
          const between = (threshold: number) =>
            !Number.isNaN(threshold) &&
            Math.min(g0, g) - 1e-9 <= threshold &&
            threshold <= Math.max(g0, g) + 1e-9;
          const phase = phaseDay(month * 30, south);
          const flip = Math.abs(phase - 180) < 0.6 || phase < 0.6 || phase > 359.4;
          expect(
            between(arrival) || between(departure) || flip,
            `case ${String(cell)}, ${String(month)}`,
          ).toBe(true);
          if (between(arrival) || between(departure)) crossings++;
        }
        before = snowy;
        g0 = g;
      }
    }
    expect(changes).toBeGreaterThan(50);
    expect(crossings).toBeGreaterThan(50);
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
