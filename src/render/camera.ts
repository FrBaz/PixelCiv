/**
 * Caméra de la carte (ADR 0002).
 *
 * Elle vise un point de la carte, en pixels de carte (une case vaut TILE_PX pixels),
 * et l'affiche à une échelle donnée en pixels physiques de l'écran par pixel de
 * carte. L'abscisse boucle d'est en ouest ; l'ordonnée reste entre les pôles.
 * L'échelle est continue sous 1 et procède par paliers entiers au-delà, pour garder
 * des pixels nets ; les positions à l'écran sont entières.
 */
import { wrapX } from '../core/cylinder';

/** Côté d'une case, en pixels de carte (REN-01). */
export const TILE_PX = 4;

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 12;

export interface Camera {
  /** Point visé, au centre de l'écran, en pixels de carte. */
  readonly x: number;
  readonly y: number;
  /** Zoom demandé ; l'échelle affichée en découle (displayScale). */
  readonly zoom: number;
}

/** Dimensions en pixels physiques (écran) ou en pixels de carte (monde). */
export interface Extent {
  readonly width: number;
  readonly height: number;
}

/** Échelle affichée : continue sous 1, par paliers entiers au-delà. */
export function displayScale(zoom: number): number {
  return zoom < 1 ? zoom : Math.round(zoom);
}

/**
 * Ramène la caméra dans le monde : x modulo la largeur, et y de sorte que les pôles
 * ne quittent pas les bords de l'écran (ou que le monde soit centré s'il tient en
 * entier dans la hauteur).
 */
export function constrain(camera: Camera, viewport: Extent, world: Extent): Camera {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.zoom));
  const halfHeight = viewport.height / 2 / displayScale(zoom);
  const y =
    2 * halfHeight >= world.height
      ? world.height / 2
      : Math.min(world.height - halfHeight, Math.max(halfHeight, camera.y));
  return { x: wrapX(camera.x, world.width), y, zoom };
}

/** Point de la carte sous un point de l'écran. */
export function screenToMap(
  camera: Camera,
  viewport: Extent,
  screenX: number,
  screenY: number,
): { x: number; y: number } {
  const scale = displayScale(camera.zoom);
  return {
    x: camera.x + (screenX - viewport.width / 2) / scale,
    y: camera.y + (screenY - viewport.height / 2) / scale,
  };
}

/** Déplace la caméra d'un glissement à l'écran : la carte suit le doigt. */
export function pan(camera: Camera, deltaX: number, deltaY: number): Camera {
  const scale = displayScale(camera.zoom);
  return { ...camera, x: camera.x - deltaX / scale, y: camera.y - deltaY / scale };
}

/** Change le zoom en gardant fixe le point de la carte sous (screenX, screenY). */
export function zoomAt(
  camera: Camera,
  factor: number,
  viewport: Extent,
  screenX: number,
  screenY: number,
): Camera {
  const anchor = screenToMap(camera, viewport, screenX, screenY);
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.zoom * factor));
  const scale = displayScale(zoom);
  return {
    x: anchor.x - (screenX - viewport.width / 2) / scale,
    y: anchor.y - (screenY - viewport.height / 2) / scale,
    zoom,
  };
}

/** Emplacement à l'écran d'un bloc visible, en pixels physiques entiers. */
export interface ChunkPlacement {
  /** Bloc affiché, ramené dans la grille : la colonne boucle. */
  readonly column: number;
  readonly row: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Blocs à dessiner pour remplir l'écran. Les colonnes visibles se suivent sans fin ;
 * la colonne i affiche le bloc i modulo le nombre de colonnes. Les bords de chaque
 * bloc sont arrondis au pixel, ceux de deux blocs voisins tombant au même endroit :
 * ni trou ni recouvrement, à la couture comme ailleurs.
 */
export function visibleChunks(
  camera: Camera,
  viewport: Extent,
  grid: { readonly columns: number; readonly rows: number },
  chunkPx: number,
): ChunkPlacement[] {
  const scale = displayScale(camera.zoom);
  const originX = viewport.width / 2 - camera.x * scale;
  const originY = viewport.height / 2 - camera.y * scale;
  const edgeX = (index: number) => Math.round(originX + index * chunkPx * scale);
  const edgeY = (index: number) => Math.round(originY + index * chunkPx * scale);
  const first = Math.floor(-originX / (chunkPx * scale));
  const last = Math.floor((viewport.width - originX) / (chunkPx * scale));
  const top = Math.max(0, Math.floor(-originY / (chunkPx * scale)));
  const bottom = Math.min(
    grid.rows - 1,
    Math.floor((viewport.height - originY) / (chunkPx * scale)),
  );
  const placements: ChunkPlacement[] = [];
  for (let row = top; row <= bottom; row++) {
    for (let index = first; index <= last; index++) {
      placements.push({
        column: wrapX(index, grid.columns),
        row,
        left: edgeX(index),
        top: edgeY(row),
        width: edgeX(index + 1) - edgeX(index),
        height: edgeY(row + 1) - edgeY(row),
      });
    }
  }
  return placements;
}
