/**
 * Disposition des membres d'un groupe sur la carte (tâche 2.9 ; REN-04) : quel motif
 * dessine chacun, et où il se tient autour de la case du groupe. Fonctions pures, sans
 * PixiJS.
 */
import { AGE_CLASSES } from '../core/visual';

/** Motif d'une classe d'âge et d'un sexe, à l'image `step` (0 ou 1) de sa marche. */
export function spriteName(age: number, sex: number, step: number): string {
  const kind = AGE_CLASSES[age] ?? 'adult';
  if (kind === 'baby') return `sprites/baby-${String(step)}`;
  if (kind === 'child') return `sprites/child-${String(step)}`;
  return `sprites/adult-${sex === 0 ? 'female' : 'male'}-${String(step)}`;
}

/** Angle d'or, en radians : les membres successifs se répartissent sans s'aligner. */
const GOLDEN_ANGLE = 2.39996;
/** Écart, en pixels de carte, entre deux anneaux de la grappe. */
const SPACING = 3.2;
/** Aplatissement vertical de la grappe, vue de trois quarts. */
const FLATTENING = 0.6;

/**
 * Place, en pixels de carte, du membre `index` d'un groupe autour de son centre : une
 * spirale de grappe, serrée et stable d'une image à l'autre.
 */
export function clusterOffset(index: number): { readonly dx: number; readonly dy: number } {
  if (index === 0) return { dx: 0, dy: 0 };
  const radius = SPACING * Math.sqrt(index);
  const angle = index * GOLDEN_ANGLE;
  return {
    dx: Math.round(radius * Math.cos(angle)),
    dy: Math.round(radius * FLATTENING * Math.sin(angle)),
  };
}
