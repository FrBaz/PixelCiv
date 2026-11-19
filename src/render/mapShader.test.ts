import { describe, expect, it } from 'vitest';
import { loadGameData } from '../core/data';
import { Fingerprint } from '../core/hash';
import { COVER_RAMPS, coverShare, seasonFactor } from '../core/seasons';
import { bakedWaterTone } from '../core/waves';
import { glslFloat, MAP_FRAGMENT, MAP_FRAGMENT_WAVES, WAVE_ANCHORS } from './mapShader';
import { WAVE_GLSL, waveNoise, wavePhase, wavePixel, waveTable } from './waves';

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

  // Vitest ne voit pas le shader : ces deux empreintes figent son code et le motif de son
  // miroir. N'en mettre une à jour qu'après avoir relancé le contrôle des pixels dans Chromium
  // (ADR 0015 : shader et miroir comparés pixel à pixel, mois forcé, calme partiel compris),
  // et en joindre le résultat à la PR.
  it('fige le code de l’onde et le motif de son miroir', () => {
    expect(new Fingerprint().string(MAP_FRAGMENT_WAVES).hex()).toBe('01c90fa3');
    const biomes = loadGameData().biomes.entries;
    const table = waveTable(biomes, 1);
    const noise = waveNoise();
    const worldPx = 2048;
    // Chaque ton cuit de chaque eau, et une terre, sur une grille ; des cases de tous les
    // drapeaux, à des températures de part et d'autre des seuils, en un mois de calme partiel.
    const colors = [
      ...biomes
        .filter((biome) => biome.family === 'water')
        .flatMap((biome) => [biome.palette.shadow, biome.palette.base, biome.palette.light])
        .map(bakedWaterTone),
      0x6b8a3b,
    ];
    const temperatures = [-12, -7, -6, -5.5, -5, -4.5, -1, -0.5, 0, 0.5, 1, 4, 22];
    const view = {
      season: Math.fround(seasonFactor(1.37)),
      fine: true,
      natural: true,
      streams: true,
    };
    const fingerprint = new Fingerprint();
    let changed = 0;
    for (let step = 0; step < 64; step++) {
      const frame = { table, noise, phase: wavePhase(step, worldPx), worldPx };
      for (let y = 0; y < 96; y++) {
        for (let x = 0; x < 96; x++) {
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
          const tone = wavePixel(frame, view, worldPx - 48 + x, y, pixel);
          if (tone === undefined) continue;
          changed++;
          fingerprint.uint32(step).uint32(x).uint32(y).uint32(tone);
        }
      }
    }
    expect(changed).toBeGreaterThan(500);
    expect(fingerprint.hex()).toBe('3385c578');
  });
});
