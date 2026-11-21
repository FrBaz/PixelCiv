import { describe, expect, it } from 'vitest';
import { BiomesSchema, type Biome } from '../core/data/schemas';
import { Fingerprint } from '../core/hash';
import { loadGameData } from '../core/data';
import { coverShare, seasonFactor } from '../core/seasons';
import { coverRamps } from '../core/snow';
import {
  bakedWaterTone,
  MAX_CREST_LENGTH,
  MAX_CREST_THICKNESS,
  MAX_WAVE_BIOMES,
} from '../core/waves';
import { foliageShares, leafThreshold } from '../core/foliage';
import { TINT } from './bake';
import {
  COVER_GLSL,
  glslFloat,
  MAP_FRAGMENT,
  MAP_FRAGMENT_SEASONS,
  MAP_FRAGMENT_WAVES,
  MAP_FRAGMENT_WAVES_SEASONS,
  SEASON_ANCHORS,
  WAVE_ANCHORS,
} from './mapShader';
import { mirrorPhase, mirrorState } from './seasonMirror';
import { SEASON_EXPR, SEASON_GLSL } from './seasonShader';
import { evaluateGlsl } from './testing';
import {
  CALM_GLSL,
  WAVE_GLSL,
  waveNoise,
  wavePhase,
  wavePixel,
  waveTable,
  type WaveCovers,
} from './waves';

/** Une eau fictive, de tons et de mer animée choisis : le reste n'importe pas à l'onde. */
const water = (
  id: string,
  [shadow, base, light]: readonly [string, string, string],
  waves?: Biome['waves'],
): Biome => ({
  id,
  family: 'water',
  name: 'biome.essai',
  fertility: 0,
  movementCost: null,
  disease: false,
  resources: [],
  forage: { plants: 0, game: 0, fish: 0 },
  flora: { trees: 0, shrubs: 0, species: [] },
  fauna: {},
  palette: { shadow, base, light },
  tile: 'water',
  vegetation: 'none',
  seasons: { cover: 'none' },
  ...(waves === undefined ? {} : { waves }),
});

/**
 * Les eaux de l'empreinte du miroir, sans rapport avec data/biomes.json : autant d'eaux
 * animées que le shader a de places, aux longueurs et épaisseurs extrêmes, aux parts de 0 à 1
 * (des seuils variés), aux deux tons de crête ; puis une eau immobile. Des tons cuits
 * distincts, dont certains à bits faibles du rouge et du vert à 1, que la cuisson efface.
 */
const FICTIVE_WATERS: readonly Biome[] = [
  water('mer-longue', ['#102040', '#183050', '#204060'], {
    crest: { share: 1, length: MAX_CREST_LENGTH, thickness: MAX_CREST_THICKNESS, tone: 'light' },
    ripple: { share: 0.25 },
  }),
  water('mer-courte', ['#214171', '#295181', '#316191'], {
    crest: { share: 0.45, length: 1, thickness: 1, tone: 'base' },
    ripple: { share: 1 },
  }),
  water('mer-calme', ['#3060a0', '#3870b0', '#4080c0'], {
    crest: { share: 0, length: 3, thickness: 2, tone: 'base' },
    ripple: { share: 0.8 },
  }),
  water('mer-claire', ['#4890c8', '#50a0d0', '#58b0e0'], {
    crest: { share: 0.7, length: 2, thickness: 1, tone: 'light' },
    ripple: { share: 0 },
  }),
  water('eau-dormante', ['#2a6a9a', '#3a7aaa', '#4a8aba']),
];

describe('shader de la carte', () => {
  it('écrit les nombres en littéraux flottants de GLSL', () => {
    expect(glslFloat(3)).toBe('3.0');
    expect(glslFloat(-6)).toBe('-6.0');
    expect(glslFloat(0.85)).toBe('0.85');
    expect(glslFloat(-0.5)).toBe('-0.5');
  });

  it('lit les rampes et les calendriers par ses uniformes, sans données dans son code (F-3)', () => {
    // Les rampes de data/seasons.json, que la simulation lit aussi (src/sim/cover.ts), arrivent
    // par des uniformes : le programme ne change pas quand on les règle.
    for (const uniform of [
      'uniform vec3 uSnowRamp;',
      'uniform vec3 uIceRamp;',
      'uniform vec3 uSeaIceRamp;',
      'uniform float uForestSnow;',
      'uniform float uDay;',
      'uniform sampler2D uCalendars;',
    ]) {
      expect(MAP_FRAGMENT).toContain(uniform);
    }
    for (const name of ['phase', 'most', 'summer', 'now', 'level', 'share'] as const) {
      expect(MAP_FRAGMENT).toContain(COVER_GLSL[name]);
    }
    expect(MAP_FRAGMENT).not.toContain('${');
    expect(MAP_FRAGMENT).not.toContain('0.85');
    expect(MAP_FRAGMENT).not.toContain('0.7 ');
    // La même rampe, côté simulation : rien au-dessus du seuil, pleine en dessous.
    for (const ramp of Object.values(coverRamps(loadGameData().seasons))) {
      expect(coverShare(ramp, ramp.onset + 1)).toBe(0);
      expect(coverShare(ramp, ramp.onset - ramp.span / 2)).toBeCloseTo(ramp.full / 2, 12);
      expect(coverShare(ramp, ramp.onset - ramp.span - 1)).toBe(ramp.full);
    }
    expect(coverRamps(loadGameData().seasons).none.full).toBe(0);
  });
});

describe('programmes de la carte et de la mer animée (ADR 0015)', () => {
  it('fige le programme de la carte : couvertures à calendrier (tâche 2b.7, ADR 0019)', () => {
    // Celui de la tâche 2b.3 (f465afb9), ses couvertures désormais lues des calendriers.
    expect(new Fingerprint().string(MAP_FRAGMENT).hex()).toBe('f1e7960c');
  });

  it('garde aux couleurs de la saison les ancres de l’onde, une fois chacune', () => {
    expect(SEASON_ANCHORS).toEqual(WAVE_ANCHORS);
    for (const anchor of Object.values(SEASON_ANCHORS)) {
      expect(MAP_FRAGMENT_WAVES.split(anchor)).toHaveLength(2);
    }
    // Insérées après l'onde, elles la suivent et précèdent les modes de carte.
    const main = MAP_FRAGMENT_WAVES.indexOf(SEASON_ANCHORS.main);
    expect(main).toBeGreaterThan(MAP_FRAGMENT_WAVES.indexOf(WAVE_GLSL.main));
  });

  it("n'ajoute au programme de la mer que le code de l'onde, avant main() et après la couverture", () => {
    const header = MAP_FRAGMENT_WAVES.indexOf(WAVE_GLSL.header);
    const main = MAP_FRAGMENT_WAVES.indexOf(WAVE_GLSL.main);
    expect(header).toBeGreaterThan(0);
    expect(MAP_FRAGMENT_WAVES.slice(header + WAVE_GLSL.header.length)).toMatch(/^void main\(\) \{/);
    expect(MAP_FRAGMENT_WAVES.slice(main + WAVE_GLSL.main.length)).toMatch(
      /^ {2}if \(uMode > 0\.5\) \{/,
    );
    // La couverture se calcule avant l'onde, qui ne touche qu'un pixel non couvert.
    expect(main).toBeGreaterThan(MAP_FRAGMENT_WAVES.indexOf('if (coverage > bayer(dither)) {'));
    expect(WAVE_GLSL.main).toContain('coverage <= waveDither');
    const without = MAP_FRAGMENT_WAVES.replace(WAVE_GLSL.header, '').replace(WAVE_GLSL.main, '');
    expect(without).toBe(MAP_FRAGMENT);
    expect(MAP_FRAGMENT.split(WAVE_ANCHORS.header)).toHaveLength(2);
    expect(MAP_FRAGMENT.split(WAVE_ANCHORS.main)).toHaveLength(2);
  });

  it('écrit le code de l’onde depuis les constantes du miroir et les calendriers de la glace', () => {
    expect(MAP_FRAGMENT_WAVES).not.toContain('${');
    // Le calme : les calmDays jours (un uniforme) avant et après la glace de son calendrier.
    expect(WAVE_GLSL.header).toContain('uniform float uCalmDays;');
    expect(WAVE_GLSL.main).toContain(`float distance = ${CALM_GLSL.distance};`);
    expect(WAVE_GLSL.main).toContain(`calm = ${CALM_GLSL.calm};`);
    expect(WAVE_GLSL.main).toContain('if (kind > 1.5 && most > 0.0) {');
    expect(WAVE_GLSL.header).toContain('float tau = imod(uWavePhase.z + floor(h.g / 16.0), 16.0);');
    expect(WAVE_GLSL.header).toContain('if (tau >= 12.0) return false;');
    expect(WAVE_GLSL.header).toContain('vec4 h = waveNoise(vec2(b.x, b.y + 128.0));');
    expect(WAVE_GLSL.header).toContain('vec4 h = waveNoise(vec2(b.x, b.y + 320.0));');
    expect(WAVE_GLSL.header).toContain('uniform vec3 uWaveTones[12];');
    expect(WAVE_GLSL.header).toContain('for (int i = 0; i < 4; i++) {');
  });

  // Vitest ne voit pas le shader : ces deux empreintes figent son code et la logique de son
  // miroir, sur des eaux fictives écrites ici, non sur data/biomes.json. Le shader ne reçoit
  // les réglages des données que par ses uniformes, que le miroir lit dans la même table :
  // régler la mer animée dans les données ne change ni l'une ni l'autre. On n'en met une à jour
  // que si la logique du shader ou du miroir change, après avoir relancé le contrôle des
  // pixels dans Chromium (tools/wave-control/LISEZMOI.md ; ADR 0015, § 10), dont on joint le
  // résultat à la PR. Tâche 2b.7 : le calme suit le calendrier de la glace (ADR 0019, § 1), dont
  // les cases des eaux fictives portent des formes écrites ici (de 01c90fa3 et 5a74a6e6 à
  // e03ba2a6 et 85d6651b) ; puis une eau sans calendrier n'a que le calme de sa rampe (e03ba2a6
  // à 0e9941c9), que le contrôle des pixels a vu : 0 écart sur 44 236 800 pixels, six vues.
  it('fige le code de l’onde et le motif de son miroir, indépendamment des données', () => {
    expect(new Fingerprint().string(MAP_FRAGMENT_WAVES).hex()).toBe('0e9941c9');
    const biomes = BiomesSchema.parse(FICTIVE_WATERS);
    const table = waveTable(biomes, 1);
    expect(table.biomes).toHaveLength(MAX_WAVE_BIOMES);
    const noise = waveNoise();
    const worldPx = 2048;
    // Chaque ton cuit de chaque eau, et une terre, sur une grille ; des cases de tous les
    // drapeaux, à des températures de part et d'autre des seuils, en un mois de calme partiel.
    const tones = biomes
      .flatMap((biome) => [biome.palette.shadow, biome.palette.base, biome.palette.light])
      .map(bakedWaterTone);
    expect(new Set(tones).size).toBe(tones.length);
    const colors = [...tones, 0x6b8a3b];
    const temperatures = [-12, -7, -6, -5.5, -5, -4.5, -1, -0.5, 0, 0.5, 1, 4, 22];
    // Des rampes et un calme écrits ici, non ceux de data/seasons.json.
    const covers: WaveCovers = {
      ice: [-1, 3, Math.fround(0.9)],
      seaIce: [-6, 4, Math.fround(0.85)],
      calmDays: 12,
    };
    const view = {
      season: Math.fround(seasonFactor(1.37)),
      day: Math.fround(1.37 * 30),
      fine: true,
      natural: true,
      streams: true,
      covers,
    };
    // Des calendriers de glace de toutes formes, une par case : sans inertie, en cours de prise,
    // en cours de départ, sans glace avant le jour le plus froid.
    const shapes = [
      [0, 0, 1, 1],
      [20, 200, 12, 12],
      [40, 120, 40, 30],
      [10, 250, 12, 60],
    ];
    // Les uniformes de la table, tels que le shader les lit.
    const fingerprint = new Fingerprint()
      .uint32(table.biomes.length)
      .typedArray(table.tones)
      .typedArray(table.crests)
      .typedArray(table.ripples);
    const changed = new Map<string, number>();
    for (let step = 0; step < 64; step++) {
      const frame = { table, noise, phase: wavePhase(step, worldPx), worldPx };
      for (let y = 0; y < 128; y++) {
        for (let x = 0; x < 128; x++) {
          const cell = Math.floor(x / 4) + 31 * Math.floor(y / 4);
          const color = colors[(7 * x + 3 * y) % colors.length] ?? 0;
          const pixel = {
            red: color >>> 16,
            green: (color >>> 8) & 255,
            blue: color & 255,
            temperature: Math.round(((temperatures[cell % temperatures.length] ?? 0) + 64) * 2),
            amplitude: (cell * 5) % 120,
            flags: (cell & 1) | (((cell >> 1) % 4) << 4) | (((cell >> 3) & 1) << 6),
            calendar: shapes[cell % shapes.length] ?? [0, 0, 1, 1],
          };
          // À cheval sur la couture.
          const tone = wavePixel(frame, view, worldPx - 64 + x, y, pixel);
          if (tone === undefined) continue;
          // La crête éclaircit le pixel, le clapot l'assombrit, dans la palette de son eau.
          const owner = table.biomes.find((biome) => biome.tones.includes(tone));
          const lighter = (owner?.tones.indexOf(tone) ?? -1) > (owner?.tones.indexOf(color) ?? -1);
          const kind = `${owner?.id ?? ''} ${lighter ? 'crête' : 'clapot'}`;
          changed.set(kind, (changed.get(kind) ?? 0) + 1);
          fingerprint.uint32(step).uint32(x).uint32(y).uint32(tone);
        }
      }
    }
    // Chaque eau animée bouge, et elles seules : crêtes et clapots selon ses parts.
    expect([...changed.keys()].sort()).toEqual([
      'mer-calme clapot',
      'mer-claire crête',
      'mer-courte clapot',
      'mer-courte crête',
      'mer-longue clapot',
      'mer-longue crête',
    ]);
    expect(fingerprint.hex()).toBe('85d6651b');
  });
});

describe('programmes des couleurs de la saison (tâche 2b.7, ADR 0019, § 2, 3 et 6)', () => {
  it('ajoute le code des saisons après l’onde et la couverture, avant les modes, sans rien changer d’autre', () => {
    for (const [seasons, source] of [
      [MAP_FRAGMENT_SEASONS, MAP_FRAGMENT],
      [MAP_FRAGMENT_WAVES_SEASONS, MAP_FRAGMENT_WAVES],
    ] as const) {
      expect(seasons.replace(SEASON_GLSL.header, '').replace(SEASON_GLSL.main, '')).toBe(source);
      const main = seasons.indexOf(SEASON_GLSL.main);
      expect(seasons.slice(main + SEASON_GLSL.main.length)).toMatch(/^ {2}if \(uMode > 0\.5\) \{/);
      expect(main).toBeGreaterThan(seasons.indexOf('if (coverage > bayer(dither)) {'));
      expect(seasons).not.toContain('${');
    }
    // Dans le programme de l'onde, les saisons viennent après elle, qui ne voit que des tons cuits.
    expect(MAP_FRAGMENT_WAVES_SEASONS.indexOf(SEASON_GLSL.main)).toBeGreaterThan(
      MAP_FRAGMENT_WAVES_SEASONS.indexOf(WAVE_GLSL.main),
    );
    // Les dates et les réglages arrivent par des textures et des uniformes.
    for (const uniform of [
      'uniform sampler2D uIdentity;',
      'uniform sampler2D uFoliage;',
      'uniform sampler2D uStates;',
      'uniform float uFoliageDays;',
      'uniform float uLight;',
    ]) {
      expect(SEASON_GLSL.header).toContain(uniform);
    }
    for (const [name, expression] of Object.entries(SEASON_EXPR)) {
      expect(SEASON_GLSL.main, name).toContain(expression);
    }
  });

  // Ces empreintes figent le code des saisons. On ne les met à jour que si sa logique change,
  // après avoir relancé le contrôle des pixels dans Chromium (tools/season-control/LISEZMOI.md),
  // dont on joint le résultat à la PR.
  it('fige les programmes des saisons, et laisse ceux de la carte et de l’onde tels quels', () => {
    expect(new Fingerprint().string(MAP_FRAGMENT).hex()).toBe('f1e7960c');
    expect(new Fingerprint().string(MAP_FRAGMENT_WAVES).hex()).toBe('0e9941c9');
    expect(new Fingerprint().string(MAP_FRAGMENT_SEASONS).hex()).toBe('918fbc88');
    expect(new Fingerprint().string(MAP_FRAGMENT_WAVES_SEASONS).hex()).toBe('e510aea1');
  });

  it('calcule hors du GPU les seuils, les parts et les états du calendrier de la végétation', () => {
    const transition = 12;
    for (const [x, y] of [
      [0, 0],
      [3, 7],
      [4095, 2047],
      [1023, 511],
      [2048, 77],
      [17, 1999],
    ] as const) {
      const value = evaluateGlsl(SEASON_EXPR.threshold, { leafX: x, leafY: y });
      expect(value, `${String(x)}, ${String(y)}`).toBe(leafThreshold(x, y));
    }
    // Des calendriers de toutes formes, aux jours de toute l'année, aux seuils de tout l'intervalle.
    const calendars = [
      [40, 120, 255, 200],
      [255, 30, 255, 255],
      [100, 150, 60, 140],
      [30, 30, 30, 30],
      [254, 254, 254, 254],
      [255, 255, 160, 255],
    ];
    let compared = 0;
    for (const calendar of calendars) {
      for (let phase = 0; phase < 360; phase += 2.37) {
        for (const threshold of [0.01, 0.3, 0.5, 0.77, 0.99]) {
          for (const light of [false, true]) {
            const variables: Record<string, number> = {
              leafPhase: Math.fround(phase),
              'cal.x': calendar[0] ?? 255,
              'cal.y': calendar[1] ?? 255,
              'cal.z': calendar[2] ?? 255,
              'cal.w': calendar[3] ?? 255,
              uFoliageDays: transition,
              uLight: light ? 1 : 0,
              threshold,
            };
            for (const name of [
              'leafDistance',
              'bare',
              'autumn',
              'dry',
              'light',
              'state',
            ] as const) {
              variables[name] = evaluateGlsl(SEASON_EXPR[name], variables);
            }
            const uniforms = { day: 0, transition, light };
            expect(variables.state).toBe(
              mirrorState(calendar, 0, Math.fround(phase), threshold, uniforms),
            );
            // Les parts du décor (en flottants de 64 bits), à l'arrondi près.
            const shares = foliageShares(calendar, 0, Math.fround(phase), transition);
            expect(variables.bare).toBeCloseTo(shares.bare, 5);
            expect(variables.autumn).toBeCloseTo(shares.autumn, 5);
            expect(variables.dry).toBeCloseTo(shares.dry, 5);
            expect(variables.light).toBeCloseTo(light ? shares.light : 0, 5);
            compared++;
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(9000);
  });

  it('retrouve hors du GPU la case qui prête le ton, sa phase et sa teinte', () => {
    for (const [ox, oy, px, py, code] of [
      [0, 0, 0, 0, 1],
      [0, 0, 1, 3, 12],
      [448, 192, 255, 255, 7],
      [448, 0, 254, 2, 5],
      [64, 192, 2, 253, 10],
    ] as const) {
      const variables: Record<string, number> = {
        'uOrigin.x': ox,
        'uOrigin.y': oy,
        'pixel.x': px,
        'pixel.y': py,
        code,
        'uWorldCells.x': 512,
        'uWorldCells.y': 256,
      };
      for (const name of [
        'wx',
        'wy',
        'lane',
        'rank',
        'lender',
        'cornerX',
        'cornerY',
        'sourceX',
        'sourceY',
      ] as const) {
        variables[name] = evaluateGlsl(SEASON_EXPR[name], variables);
      }
      const wx = ox * 4 + px;
      const wy = oy * 4 + py;
      expect([variables.wx, variables.wy, variables.lane]).toEqual([wx, wy, px % 4]);
      expect([variables.rank, variables.lender]).toEqual([
        (code - 1) % 3,
        Math.floor((code - 1) / 3),
      ]);
      const lender = Math.floor((code - 1) / 3);
      const sx = (((Math.floor((wx + 0.5) / 4 - 0.5) + (lender % 2)) % 512) + 512) % 512;
      const sy = Math.min(
        255,
        Math.max(0, Math.floor((wy + 0.5) / 4 - 0.5) + Math.floor(lender / 2)),
      );
      expect([variables.sourceX, variables.sourceY]).toEqual([sx, sy]);
    }
    for (const day of [0, 14.9, 15, 15.1, 194.9, 195, 359.99]) {
      for (const south of [0, 1]) {
        const phase = evaluateGlsl(SEASON_EXPR.leafPhase, {
          uDay: Math.fround(day),
          sourceSouth: south,
        });
        expect(phase).toBe(mirrorPhase(day, south === 1));
        expect(phase).toBeGreaterThanOrEqual(0);
        expect(phase).toBeLessThan(360);
      }
    }
    for (const temperature of [-30, -10, 0, 12, 18, 24, 30, 40]) {
      const variables: Record<string, number> = { sourceT: temperature };
      for (const name of ['warm', 'cold', 'tintRed', 'tintGreen', 'tintBlue'] as const) {
        variables[name] = evaluateGlsl(SEASON_EXPR[name], variables);
      }
      const warm = Math.min(1, Math.max(0, (temperature - TINT.warmFrom) / TINT.warmSpan));
      const cold = Math.min(1, Math.max(0, -temperature / TINT.coldSpan));
      expect(variables.tintRed).toBeCloseTo(1 + TINT.red * warm - TINT.red * cold, 6);
      expect(variables.tintGreen).toBeCloseTo(1 + TINT.green * warm, 6);
      expect(variables.tintBlue).toBeCloseTo(1 - TINT.blue * warm + TINT.blue * cold, 6);
    }
  });
});
