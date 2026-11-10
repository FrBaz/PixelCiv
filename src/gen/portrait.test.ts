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
});
