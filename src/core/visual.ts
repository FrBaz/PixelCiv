/**
 * Code d'apparence d'un individu sur la carte (tâche 2.9 ; REN-04) : ce qu'un mini-sprite
 * en montre, sur 16 bits, que le worker calcule et que le rendu lit.
 *
 *   bit 0         sexe (0 féminin, 1 masculin)
 *   bits 1 à 2    classe d'âge, son rang dans AGE_CLASSES (core/life.ts)
 *   bits 3 à 6    teint, de 0 (clair) à 15 (foncé)
 *   bits 7 à 10   couleur des cheveux : indice de l'allèle exprimé du locus du rôle « hair »,
 *                 sur 4 bits, autant que les allèles d'un locus (MAX_ALLELES, core/data/people.ts)
 *   bits 11 à 12  grisonnement des cheveux, de 0 à GREY_LEVELS − 1 (core/life.ts) : le même
 *                 que celui du portrait
 */

/** Classes d'âge, dans l'ordre de leur code : nourrisson, enfant, adulte, aîné. */
export const AGE_CLASSES = ['baby', 'child', 'adult', 'elder'] as const;
export type AgeClass = (typeof AGE_CLASSES)[number];

/** Rang de chaque classe d'âge dans AGE_CLASSES, et dans le code. */
export const AGE_CODE = Object.fromEntries(
  AGE_CLASSES.map((name, index) => [name, index]),
) as Readonly<Record<AgeClass, number>>;

/** Crans du grisonnement : aucun, un tiers, deux tiers, tout gris. */
export const GREY_LEVELS = 4;

export interface Visual {
  readonly sex: number;
  readonly age: number;
  readonly skin: number;
  readonly hair: number;
  readonly grey: number;
}

/** Nuances de teint d'un code. */
export const SKIN_TONES = 16;

export function encodeVisual(visual: Visual): number {
  return visualCode(visual.sex, visual.age, visual.skin, visual.hair, visual.grey);
}

/** Code d'apparence, des mêmes valeurs qu'encodeVisual, sans objet intermédiaire. */
export function visualCode(
  sex: number,
  age: number,
  skin: number,
  hair: number,
  grey: number,
): number {
  return (
    (sex & 1) | ((age & 3) << 1) | ((skin & 15) << 3) | ((hair & 15) << 7) | ((grey & 3) << 11)
  );
}

export function decodeVisual(code: number): Visual {
  return {
    sex: code & 1,
    age: (code >> 1) & 3,
    skin: (code >> 3) & 15,
    hair: (code >> 7) & 15,
    grey: (code >> 11) & 3,
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
