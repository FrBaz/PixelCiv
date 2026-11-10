import { describe, expect, it } from 'vitest';
import { frameOf } from './atlas';
import { clusterOffset, spriteName } from './crowd';

describe('grappe des membres d’un groupe (tâche 2.9)', () => {
  it('place chacun à une position entière, stable, sans superposer les premiers', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 50; index++) {
      const { dx, dy } = clusterOffset(index);
      expect(Number.isInteger(dx) && Number.isInteger(dy)).toBe(true);
      expect(clusterOffset(index)).toEqual({ dx, dy });
      // Une grappe serrée : cinquante personnes tiennent à quelques cases du centre.
      expect(Math.abs(dx)).toBeLessThanOrEqual(24);
      expect(Math.abs(dy)).toBeLessThanOrEqual(15);
      if (index < 20) seen.add(`${String(dx)},${String(dy)}`);
    }
    expect(seen.size).toBe(20);
  });

  it('a un motif dans l’atlas pour chaque âge, chaque sexe et chaque pas', () => {
    for (let age = 0; age < 4; age++) {
      for (let sex = 0; sex < 2; sex++) {
        for (let step = 0; step < 2; step++) {
          expect(() => frameOf(spriteName(age, sex, step))).not.toThrow();
        }
      }
    }
    expect(spriteName(2, 0, 1)).toBe('sprites/adult-female-1');
    expect(spriteName(3, 1, 0)).toBe('sprites/adult-male-0');
    expect(spriteName(0, 1, 0)).toBe('sprites/baby-0');
  });
});
