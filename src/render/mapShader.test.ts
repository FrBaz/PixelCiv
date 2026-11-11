import { describe, expect, it } from 'vitest';
import { COVER_RAMPS, coverShare } from '../core/seasons';
import { glslFloat, MAP_FRAGMENT } from './mapShader';

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
