import { describe, expect, it } from 'vitest';
import { BiomesSchema, type Biome } from '../core/data/schemas';
import { Fingerprint } from '../core/hash';
import { COVER_RAMPS, coverShare, seasonFactor } from '../core/seasons';
import {
  bakedWaterTone,
  MAX_CREST_LENGTH,
  MAX_CREST_THICKNESS,
  MAX_WAVE_BIOMES,
} from '../core/waves';
import { glslFloat, MAP_FRAGMENT, MAP_FRAGMENT_WAVES, WAVE_ANCHORS } from './mapShader';
import { WAVE_GLSL, waveNoise, wavePhase, wavePixel, waveTable } from './waves';

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

  it('trame la neige, la glace et la banquise selon les rampes que la simulation lit (F-3)', () => {
    // Les seuils de C1 (D9), inchangés depuis la tâche 1.8 : ceux qui font geler la pêche.
    expect(MAP_FRAGMENT).toContain('float snow = clamp((0.5 - monthly) / 3.0, 0.0, 1.0) * 1.0;');
    expect(MAP_FRAGMENT).toContain('float ice = clamp((-1.0 - monthly) / 3.0, 0.0, 1.0) * 0.9;');
    expect(MAP_FRAGMENT).toContain('coverage = clamp((-6.0 - monthly) / 4.0, 0.0, 1.0) * 0.85;');
    expect(MAP_FRAGMENT).not.toContain('${');
    // La même rampe, côté simulation : rien au-dessus du seuil, pleine en dessous.
    for (const ramp of Object.values(COVER_RAMPS)) {
      expect(coverShare(ramp, ramp.onset + 1)).toBe(0);
      expect(coverShare(ramp, ramp.onset - ramp.span / 2)).toBeCloseTo(ramp.full / 2, 12);
      expect(coverShare(ramp, ramp.onset - ramp.span - 1)).toBe(ramp.full);
    }
    expect(COVER_RAMPS.none.full).toBe(0);
  });
});

describe('programmes de la carte et de la mer animée (ADR 0015)', () => {
  it('garde le programme de la carte de la tâche 2b.3, à l’octet près', () => {
    expect(new Fingerprint().string(MAP_FRAGMENT).hex()).toBe('f465afb9');
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

  it('écrit le code de l’onde depuis les constantes du miroir et les rampes de core/seasons.ts', () => {
    expect(MAP_FRAGMENT_WAVES).not.toContain('${');
    // Le calme : les CALM_SPAN degrés qui précèdent la glace des rivières et la banquise.
    expect(WAVE_GLSL.main).toContain(
      `calm = clamp((${glslFloat(COVER_RAMPS.ice.onset + 2)} - monthly) / 2.0, 0.0, 1.0);`,
    );
    expect(WAVE_GLSL.main).toContain(
      `calm = clamp((${glslFloat(COVER_RAMPS['sea-ice'].onset + 2)} - monthly) / 2.0, 0.0, 1.0);`,
    );
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
  // résultat à la PR.
  it('fige le code de l’onde et le motif de son miroir, indépendamment des données', () => {
    expect(new Fingerprint().string(MAP_FRAGMENT_WAVES).hex()).toBe('01c90fa3');
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
    const view = {
      season: Math.fround(seasonFactor(1.37)),
      fine: true,
      natural: true,
      streams: true,
    };
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
    expect(fingerprint.hex()).toBe('5a74a6e6');
  });
});
