/**
 * Disposition des groupes sur la carte (tâche 2.9 ; REN-03, REN-04, REN-08) : quel motif
 * dessine chaque membre, où il se tient autour de la case du groupe, jusqu'où s'étend ce
 * qui se dessine autour de la case, et à quelle densité de pixels se montre la bannière
 * d'un groupe vu de loin. Fonctions pures, sans PixiJS.
 */
import { AGE_CLASSES } from '../core/visual';
import type { Rgb } from './bake';
import type { Extent } from './camera';

/** Motif d'une classe d'âge et d'un sexe, à l'image `step` (0 ou 1) de sa marche. */
export function spriteName(age: number, sex: number, step: number): string {
  const kind = AGE_CLASSES[age] ?? 'adult';
  if (kind === 'baby') return `sprites/baby-${String(step)}`;
  if (kind === 'child') return `sprites/child-${String(step)}`;
  return `sprites/adult-${sex === 0 ? 'female' : 'male'}-${String(step)}`;
}

/** Tous les motifs de mini-sprites que spriteName peut nommer. */
export function spriteNames(): string[] {
  const names = new Set<string>();
  for (let age = 0; age < AGE_CLASSES.length; age++) {
    for (const sex of [0, 1]) for (const step of [0, 1]) names.add(spriteName(age, sex, step));
  }
  return [...names];
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

/**
 * Étendue d'un dessin autour d'un point de l'écran, de chaque côté, en unités (pixels de
 * carte, ou pixels d'icône) : à gauche, à droite, au-dessus et au-dessous. Les bords
 * droit et bas sont exclus.
 */
export interface Reach {
  readonly left: number;
  readonly right: number;
  readonly up: number;
  readonly down: number;
}

/**
 * Étendue, en pixels de carte, des mini-sprites d'un groupe de `size` membres autour du
 * centre de sa case : la grappe de clusterOffset, et des motifs d'au plus `width` ×
 * `height` pixels posés les pieds sur la case, comme les place PeopleLayer. Elle grandit
 * avec le groupe : une marge fixe ferait disparaître au bord de l'écran les membres
 * extérieurs d'un grand groupe.
 */
export function clusterReach(size: number, width: number, height: number): Reach {
  const radius = Math.ceil(SPACING * Math.sqrt(Math.max(0, size - 1)));
  const vertical = Math.ceil(radius * FLATTENING);
  const half = Math.floor(width / 2);
  return {
    left: radius + half,
    right: radius + width - half,
    up: vertical + height - 2,
    down: vertical + 2,
  };
}

/**
 * Un dessin d'étendue `reach`, en unités de `unit` pixels physiques autour du point (x, y)
 * de l'écran, touche-t-il l'écran ? Un pixel de marge couvre l'arrondi des positions.
 */
export function onScreen(
  x: number,
  y: number,
  reach: Reach,
  unit: number,
  viewport: Extent,
): boolean {
  return (
    x + reach.right * unit > -1 &&
    x - reach.left * unit < viewport.width + 1 &&
    y + reach.down * unit > -1 &&
    y - reach.up * unit < viewport.height + 1
  );
}

/** Taille d'un pixel d'icône, en pixels CSS, quand l'icône devient un marqueur d'interface. */
export const ICON_CSS_PIXEL = 2;

/**
 * Pixels physiques par pixel d'une icône de la carte, comme la bannière d'un groupe vu de
 * loin (REN-08). Quand l'échelle de la carte, `scale` pixels physiques par pixel de carte,
 * donne au moins la taille voulue, ICON_CSS_PIXEL pixels CSS par pixel d'icône, l'icône
 * est à la densité de la carte : un pixel d'icône par pixel de carte, sans mélange. Plus
 * loin, la carte est trop fine pour qu'une icône y reste lisible à sa densité : l'icône
 * devient un marqueur d'interface, à ICON_CSS_PIXEL pixels CSS par pixel, arrondis en
 * pixels physiques entiers. Sa taille à l'écran ne dépend alors pas de la densité de
 * l'écran (`resolution`, pixels physiques par pixel CSS).
 */
export function iconPixel(scale: number, resolution: number): number {
  const marker = Math.max(1, Math.round(ICON_CSS_PIXEL * resolution));
  // Au-delà de 1, l'échelle de la carte procède par paliers entiers (camera.ts).
  return scale >= marker ? scale : marker;
}

/**
 * Clé d'une texture recolorée, dans le cache du rendu : le motif, le code d'apparence et
 * la couleur de l'habit, et non la culture : deux cultures de même habit partagent leurs
 * textures.
 */
export function textureKey(name: string, code: number, cloth: Rgb): string {
  return `${name}|${String(code)}|${cloth.join(',')}`;
}
