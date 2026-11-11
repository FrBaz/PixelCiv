/**
 * Disposition des groupes sur la carte (tâche 2.9 ; REN-03, REN-04, REN-08) : quel motif
 * dessine chaque membre, où il se tient autour de la case du groupe, jusqu'où s'étend ce
 * qui se dessine autour de la case, à quelle densité de pixels se montre la bannière
 * d'un groupe vu de loin, et quel groupe se trouve sous un appui. Fonctions pures, sans
 * PixiJS : PeopleLayer dessine avec elles ce que pickGroup retrouve.
 */
import { GROUP_STRIDE, type GroupsFrame } from '../core/protocol';
import { AGE_CLASSES, decodeVisual } from '../core/visual';
import type { Rgb } from './bake';
import { displayScale, TILE_PX, type Camera, type Extent } from './camera';

/** Échelle, en pixels physiques par pixel de carte, à partir de laquelle on voit les gens. */
export const SPRITE_SCALE = 3;

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

/** Largeur et hauteur, en pixels. */
export interface Size {
  readonly width: number;
  readonly height: number;
}

/** Rectangle de l'écran, en pixels physiques : bords gauche et haut compris, droit et bas exclus. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Rectangle de la bannière d'un groupe, de `banner` pixels d'icône à `pixel` pixels
 * physiques chacun : sa hampe se plante sur le point (x, y) de l'écran, centre de la case.
 */
export function bannerBox(x: number, y: number, banner: Size, pixel: number): Box {
  return {
    left: Math.round(x),
    top: Math.round(y - banner.height * pixel),
    width: banner.width * pixel,
    height: banner.height * pixel,
  };
}

/**
 * Rectangle du mini-sprite du membre `member`, de `shape` pixels de carte à `scale` pixels
 * physiques chacun : les pieds sur la case, en grappe autour du point (x, y) de l'écran,
 * centre de la case, ses pixels sur ceux de la carte.
 */
export function memberBox(x: number, y: number, member: number, shape: Size, scale: number): Box {
  const offset = clusterOffset(member);
  return {
    left: Math.round(x + (offset.dx - Math.floor(shape.width / 2)) * scale),
    top: Math.round(y + (offset.dy - shape.height + 2) * scale),
    width: shape.width * scale,
    height: shape.height * scale,
  };
}

/** Ce que voit la carte : la caméra, l'écran (pixels physiques), le monde (pixels de carte). */
export interface MapView {
  readonly camera: Camera;
  readonly viewport: Extent;
  readonly world: Extent;
  /** Pixels physiques par pixel CSS. */
  readonly resolution: number;
}

/**
 * Où se dessine le groupe de la case (column, row) : le centre de sa case à l'écran, dans
 * la copie du monde la plus proche de la caméra, la largeur `span` d'une copie du monde à
 * l'écran, et le nombre de copies à regarder de chaque côté pour un dessin d'étendue
 * `reach`, en unités de `unit` pixels physiques. Quand le monde est plus étroit que
 * l'écran, chaque groupe se voit dans chacune des copies visibles (monde cylindrique).
 */
export function groupScreen(
  column: number,
  row: number,
  view: MapView,
  reach: Reach,
  unit: number,
): { readonly x: number; readonly y: number; readonly span: number; readonly copies: number } {
  const { camera, viewport, world } = view;
  const scale = displayScale(camera.zoom);
  const span = world.width * scale;
  let mapX = column * TILE_PX + TILE_PX / 2;
  const mapY = row * TILE_PX + TILE_PX / 2;
  mapX += Math.round((camera.x - mapX) / world.width) * world.width;
  return {
    x: (mapX - camera.x) * scale + viewport.width / 2,
    y: (mapY - camera.y) * scale + viewport.height / 2,
    span,
    copies: Math.ceil((viewport.width / 2 + Math.max(reach.left, reach.right) * unit + 1) / span),
  };
}

/** Motifs que pickGroup doit connaître : la bannière, et le mini-sprite d'un code d'apparence. */
export interface PickShapes {
  readonly banner: Size;
  /** Le plus grand des mini-sprites, pour l'étendue d'une grappe. */
  readonly largest: Size;
  readonly member: (code: number) => Size;
}

/** Tolérance d'un appui autour d'un dessin, en pixels CSS : un doigt couvre plus qu'un pixel. */
export const TOUCH_SLOP = 4;

/** Écart d'un point à un rectangle, en pixels physiques : 0 dedans ou sur son bord. */
function gap(box: Box, x: number, y: number): number {
  const dx = Math.max(box.left - x, 0, x - (box.left + box.width));
  const dy = Math.max(box.top - y, 0, y - (box.top + box.height));
  return Math.max(dx, dy);
}

/**
 * Le groupe dessiné sous le point (x, y) de l'écran, en pixels physiques (W-7) : sa
 * bannière de loin, l'un de ses membres de près, aux places où PeopleLayer les dessine, à
 * l'échelle de la carte. La bannière se touche donc là où elle se voit, à tout zoom. Un
 * dessin touché l'emporte sur un dessin frôlé, à `slop` pixels au plus ; à égalité, celui
 * qui passe devant : le plus bas à l'écran, puis le dernier dessiné.
 */
export function pickGroup(
  frame: GroupsFrame,
  view: MapView,
  x: number,
  y: number,
  shapes: PickShapes,
  slop = 0,
): number | undefined {
  const scale = displayScale(view.camera.zoom);
  const close = scale >= SPRITE_SCALE;
  const icon = iconPixel(scale, view.resolution);
  const bannerReach = { left: 0, right: shapes.banner.width, up: shapes.banner.height, down: 0 };
  let best: number | undefined;
  let bestGap = Number.POSITIVE_INFINITY;
  let bestFront = Number.NEGATIVE_INFINITY;
  const consider = (id: number, box: Box, front: number) => {
    const distance = gap(box, x, y);
    if (distance > slop) return;
    if (distance < bestGap || (distance === bestGap && front >= bestFront)) {
      best = id;
      bestGap = distance;
      bestFront = front;
    }
  };
  const groups = frame.groups;
  let first = 0;
  for (let index = 0; index + GROUP_STRIDE <= groups.length; index += GROUP_STRIDE) {
    const id = groups[index] ?? 0;
    const size = groups[index + 3] ?? 0;
    const reach = close
      ? clusterReach(size, shapes.largest.width, shapes.largest.height)
      : bannerReach;
    const unit = close ? scale : icon;
    const at = groupScreen(groups[index + 1] ?? 0, groups[index + 2] ?? 0, view, reach, unit);
    for (let copy = -at.copies; copy <= at.copies; copy++) {
      const screenX = at.x + copy * at.span;
      if (!onScreen(screenX, at.y, reach, unit, view.viewport)) continue;
      if (close) {
        for (let member = 0; member < size; member++) {
          const shape = shapes.member(frame.sprites[first + member] ?? 0);
          const box = memberBox(screenX, at.y, member, shape, scale);
          consider(id, box, box.top + box.height);
        }
      } else {
        consider(id, bannerBox(screenX, at.y, shapes.banner, icon), at.y);
      }
    }
    first += size;
  }
  return best;
}

/** Taille du mini-sprite d'un code d'apparence : celle de sa première image de marche. */
export function memberShape(code: number, frameOf: (name: string) => Size): Size {
  const visual = decodeVisual(code);
  return frameOf(spriteName(visual.age, visual.sex, 0));
}
