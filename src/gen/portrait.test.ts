import { describe, expect, it } from 'vitest';
import { ROLE } from '../core/visual';
import { PORTRAIT_SIZE, portraitRoles, type PortraitInput } from './portrait';

const adult: PortraitInput = { sex: 0, age: 30, face: 'oval', nose: 'straight', variant: 12345 };

/** Pixels d'un rôle. */
function count(roles: Uint8Array, role: number): number {
  return roles.reduce((total, value) => total + (value === role ? 1 : 0), 0);
}

/** Silhouette de la peau : les pixels de peau, d'ombre et de lumière comprises. */
function skin(roles: Uint8Array): number[] {
  const skinRoles: number[] = [ROLE.skin, ROLE.skinShadow, ROLE.skinLight];
  return Array.from(roles, (role) => (skinRoles.includes(role) ? 1 : 0));
}

describe('portraits (REN-07)', () => {
  it('dessine un portrait de 64 × 64 rôles, toujours le même pour un même individu', () => {
    const roles = portraitRoles(adult);
    expect(roles).toHaveLength(PORTRAIT_SIZE * PORTRAIT_SIZE);
    expect(Array.from(portraitRoles(adult))).toEqual(Array.from(roles));
    expect(count(roles, ROLE.outline)).toBeGreaterThan(50);
    expect(count(roles, ROLE.eye)).toBe(8);
    expect(Math.max(...roles)).toBeLessThanOrEqual(ROLE.mouth);
  });

  it('suit les gènes : la forme du visage change avec son allèle, pas avec le reste', () => {
    const round = portraitRoles({ ...adult, face: 'round' });
    const long = portraitRoles({ ...adult, face: 'long' });
    expect(skin(round)).not.toEqual(skin(long));
    // Deux nez différents sur un même visage : la silhouette ne change presque pas.
    const broad = portraitRoles({ ...adult, nose: 'broad' });
    const differences = skin(broad).filter(
      (value, index) => value !== skin(portraitRoles(adult))[index],
    );
    expect(differences.length).toBeLessThan(8);
  });

  it('vieillit : rides et cheveux du dessus changent, le visage reste le sien', () => {
    const young = portraitRoles({ ...adult, sex: 1, age: 25, variant: 48 });
    const old = portraitRoles({ ...adult, sex: 1, age: 70, variant: 48 });
    expect(Array.from(old)).not.toEqual(Array.from(young));
    // La calvitie dégarnit le sommet du crâne : moins de cheveux.
    const hair = (roles: Uint8Array) =>
      count(roles, ROLE.hair) + count(roles, ROLE.hairShadow) + count(roles, ROLE.hairLight);
    expect(hair(old)).toBeLessThan(hair(young));
    // Un enfant a une tête plus petite.
    const child = portraitRoles({ ...adult, age: 4 });
    expect(skin(child).reduce((a, b) => a + b, 0)).toBeLessThan(
      skin(portraitRoles(adult)).reduce((a, b) => a + b, 0),
    );
  });

  it('ride le front et creuse les pattes d’oie des deux côtés, chevelu ou non (A-2)', () => {
    // Pixels d'ombre de peau au milieu du front, au-dessus des sourcils (rangée 22 chez
    // l'adulte), loin du côté de l'ombre du visage.
    const forehead = (roles: Uint8Array) => {
      let total = 0;
      for (let y = 10; y <= 21; y++) {
        for (let x = 27; x <= 37; x++)
          if (roles[y * PORTRAIT_SIZE + x] === ROLE.skinShadow) total++;
      }
      return total;
    };
    // Pixels changés d'un âge à l'autre autour des yeux, d'un côté du visage.
    const eyes = (before: Uint8Array, after: Uint8Array, side: -1 | 1) => {
      let total = 0;
      for (let y = 22; y <= 28; y++) {
        for (let x = 16; x <= 48; x++) {
          const index = y * PORTRAIT_SIZE + x;
          if (Math.sign(x - 31.5) === side && before[index] !== after[index]) total++;
        }
      }
      return total;
    };
    // Femmes et hommes de chaque visage ; variantes à cheveux longs ou courts, à frange, à
    // barbe, à calvitie.
    for (const sex of [0, 1]) {
      for (const face of ['oval', 'round', 'square', 'long']) {
        for (const variant of [0, 1, 7, 8, 48, 64, 128, 192, 0x2c5f3e91]) {
          const at = (age: number) => portraitRoles({ ...adult, sex, face, variant, age });
          const where = `sexe ${String(sex)}, ${face}, variante ${String(variant)}`;
          expect(forehead(at(40)), where).toBeGreaterThan(forehead(at(39)));
          expect(forehead(at(60)), where).toBeGreaterThan(forehead(at(40)));
          expect(forehead(at(30)), where).toBe(0);
          expect(eyes(at(44), at(45), -1), where).toBeGreaterThan(0);
          expect(eyes(at(44), at(45), 1), where).toBeGreaterThan(0);
        }
      }
    }
  });
});
