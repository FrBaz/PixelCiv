/**
 * Code d'apparence d'un individu sur la carte (tâche 2.9 ; REN-04) : ce qu'un mini-sprite
 * en montre, sur 16 bits, que le worker calcule et que le rendu lit.
 *
 *   bit 0       sexe (0 féminin, 1 masculin)
 *   bits 1 à 2  âge : nourrisson, enfant, adulte, aîné
 *   bits 3 à 6  teint, de 0 (clair) à 15 (foncé)
 *   bits 7 à 9  couleur des cheveux : indice de l'allèle exprimé du locus « hair »
 *   bit 10      cheveux gris
 */

export const AGE_CLASSES = ['baby', 'child', 'adult', 'elder'] as const;
export type AgeClass = (typeof AGE_CLASSES)[number];

export interface Visual {
  readonly sex: number;
  readonly age: number;
  readonly skin: number;
  readonly hair: number;
  readonly grey: boolean;
}

/** Nuances de teint d'un code. */
export const SKIN_TONES = 16;

export function encodeVisual(visual: Visual): number {
  return (
    (visual.sex & 1) |
    ((visual.age & 3) << 1) |
    ((visual.skin & 15) << 3) |
    ((visual.hair & 7) << 7) |
    ((visual.grey ? 1 : 0) << 10)
  );
}

export function decodeVisual(code: number): Visual {
  return {
    sex: code & 1,
    age: (code >> 1) & 3,
    skin: (code >> 3) & 15,
    hair: (code >> 7) & 7,
    grey: ((code >> 10) & 1) === 1,
  };
}

/**
 * Rôles de teinte des sources pixel art (AST-04, REN-09) : le caractère qui désigne chacun
 * dans une source (assets/pixel/), dans l'ordre de leur code.
 */
export const ROLE_CHARACTERS = '.oSszHhyCcxewm';

/** Codes des rôles de teinte. */
export const ROLE = {
  transparent: 0,
  outline: 1,
  skinShadow: 2,
  skin: 3,
  skinLight: 4,
  hairShadow: 5,
  hair: 6,
  hairLight: 7,
  clothShadow: 8,
  cloth: 9,
  clothLight: 10,
  eye: 11,
  white: 12,
  mouth: 13,
} as const;
