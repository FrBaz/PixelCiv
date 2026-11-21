import { describe, expect, it } from 'vitest';
import { KEPT, recolorRole } from './humans';
import { DECOR_LEGEND, legendRole, legendRoles, regionCode, type RoleLegend } from './legend';

describe('légendes des grilles de rôles (ADR 0017, § 3 et 7)', () => {
  it('codent les rôles comme les humains : le contour, puis 16 + région × 8 + rang', () => {
    const roles = legendRoles(DECOR_LEGEND);
    expect(roles.get(DECOR_LEGEND.outline)).toBe(KEPT);
    expect(roles.get(DECOR_LEGEND.empty)).toBe(0);
    DECOR_LEGEND.regions.forEach((region, code) => {
      expect(regionCode(DECOR_LEGEND, region.id)).toBe(code);
      for (let rank = 0; rank < 4; rank++) {
        expect(legendRole(DECOR_LEGEND, region.id, rank)).toBe(recolorRole(code, 0, rank));
        const char = region.chars.charAt(rank);
        if (char !== '') expect(roles.get(char)).toBe(recolorRole(code, 0, rank));
      }
    });
    // L'ombre n'a pas de caractère : le build l'ajoute.
    expect(DECOR_LEGEND.regions.find((region) => region.id === 'shadow')?.chars).toBe('');
  });

  it('refusent un caractère pris deux fois, et une région inconnue', () => {
    const twice: RoleLegend = {
      name: 'essai',
      empty: '.',
      outline: 'o',
      regions: [
        { id: 'a', chars: 'AaBb' },
        { id: 'b', chars: 'Cbcd' },
      ],
    };
    expect(() => legendRoles(twice)).toThrow(/« b » deux fois/);
    expect(() => legendRole(DECOR_LEGEND, 'coat', 0)).toThrow(/région coat inconnue/);
  });
});
