/**
 * Caméra de la carte (ADR 0002 et 0012).
 *
 * Elle vise un point de la carte, en pixels de carte (une case vaut TILE_PX pixels),
 * et l'affiche à une échelle donnée en pixels physiques de l'écran par pixel de
 * carte. L'abscisse boucle d'est en ouest ; l'ordonnée reste entre les pôles.
 * L'échelle est continue sous 1 et procède par paliers entiers au-delà, pour garder
 * des pixels nets ; les positions à l'écran sont entières.
 *
 * Pour le joueur, le zoom se compte en pixels CSS par pixel de carte (tâche 2b.1) : le
 * zoom 2 montre un pixel de carte sur 2 pixels CSS, quelle que soit la densité de
 * l'écran. La caméra, elle, tient son zoom en pixels physiques : zoom CSS × densité,
 * ramené à l'échelle affichée la plus proche (physicalZoom).
 */
import { wrapX } from '../core/cylinder';

/** Côté d'une case, en pixels de carte (REN-01). */
export const TILE_PX = 4;

/** Zoom le plus fort, en pixels CSS par pixel de carte (2b.1). */
export const MAX_ZOOM = 24;

/** Zoom d'une partie qui s'ouvre, en pixels CSS par pixel de carte (2b.1). */
export const DEFAULT_ZOOM = { desktop: 2, phone: 3 } as const;

export interface Camera {
  /** Point visé, au centre de l'écran, en pixels de carte. */
  readonly x: number;
  readonly y: number;
  /**
   * Zoom demandé, en pixels physiques par pixel de carte ; l'échelle affichée en découle
   * (displayScale).
   */
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

/** Bornes du zoom de la caméra, en pixels physiques par pixel de carte. */
export interface ZoomLimits {
  readonly min: number;
  readonly max: number;
}

/**
 * Bornes du zoom pour un écran de `viewport` pixels physiques, à `resolution` pixels
 * physiques par pixel CSS, et un monde de `world` pixels de carte (2b.1, ADR 0012).
 *
 * Au plus faible, la carte remplit l'écran en hauteur, sans rien montrer au-delà des
 * pôles : l'échelle vaut la hauteur de l'écran sur celle du monde quand elle tombe sous 1,
 * où l'échelle est continue ; au-delà, c'est le premier palier entier qui l'atteint, car
 * une échelle de 1,05 mêlerait des pixels de carte d'un et de deux pixels physiques. Au
 * plus fort, le dernier palier qui ne dépasse pas MAX_ZOOM pixels CSS par pixel de carte :
 * 66 à la densité 2,75, mais 26 à la densité 1,1 (23,6 pixels CSS), car 27 en ferait 24,5.
 * Ces bornes suivent la taille de l'écran et sa densité : les commandes les recalculent à
 * chaque image, donc à chaque redimensionnement.
 */
export function zoomLimits(viewport: Extent, world: Extent, resolution: number): ZoomLimits {
  const fit = viewport.height / world.height;
  // Un écran encore sans hauteur, avant la mise en page, n'a rien à remplir : le zoom le
  // plus faible vaut alors 1, ce qui laisse le zoom par défaut tel quel.
  const min = !(fit > 0 && Number.isFinite(fit)) ? 1 : fit <= 1 ? fit : Math.ceil(fit);
  // La marge absorbe l'arrondi du produit : 24 × 2/3 donne 15,999…, qui vaut bien 16.
  const top = MAX_ZOOM * resolution;
  const max = top < 1 ? top : Math.floor(top + 1e-9);
  return { min, max: Math.max(min, max) };
}

/**
 * Zoom de la caméra, en pixels physiques par pixel de carte, pour un zoom de `zoom`
 * pixels CSS par pixel de carte sur un écran de `resolution` pixels physiques par pixel
 * CSS : l'échelle affichée la plus proche (displayScale), au palier entier le plus proche
 * à partir de 1, et telle quelle en dessous. À la densité 2,75, le zoom 3 donne 8 pixels
 * physiques par pixel de carte, soit 2,9 pixels CSS.
 */
export function physicalZoom(zoom: number, resolution: number): number {
  return displayScale(zoom * resolution);
}

/** Le zoom ramené entre ses bornes. */
export function clampZoom(zoom: number, limits: ZoomLimits): number {
  return Math.min(limits.max, Math.max(limits.min, zoom));
}

/**
 * Ramène la caméra dans le monde : zoom entre ses bornes (zoomLimits), x modulo la
 * largeur, et y de sorte que les pôles ne quittent pas les bords de l'écran. Au zoom le
 * plus faible sous 1, le monde remplit tout juste la hauteur : il est alors centré.
 */
export function constrain(
  camera: Camera,
  viewport: Extent,
  world: Extent,
  resolution: number,
): Camera {
  const zoom = clampZoom(camera.zoom, zoomLimits(viewport, world, resolution));
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

/**
 * La caméra, au même zoom, qui montre le point (mapX, mapY) de la carte, en pixels de
 * carte, au point (screenX, screenY) de l'écran, en pixels physiques : au milieu de la
 * partie visible de la carte, par exemple, plutôt qu'au centre de l'écran.
 */
export function showAt(
  camera: Camera,
  viewport: Extent,
  mapX: number,
  mapY: number,
  screenX: number,
  screenY: number,
): Camera {
  const scale = displayScale(camera.zoom);
  return {
    ...camera,
    x: mapX - (screenX - viewport.width / 2) / scale,
    y: mapY - (screenY - viewport.height / 2) / scale,
  };
}

/**
 * Case du monde sous un point de la carte, en pixels de carte, pour un monde de `columns`
 * colonnes : la colonne est ramenée dans le monde (wrapX), quelle que soit la copie du
 * monde touchée, comme le veut le monde cylindrique ; la ligne peut tomber au-delà des
 * pôles, hors du monde.
 */
export function cellAt(mapX: number, mapY: number, columns: number): { x: number; y: number } {
  return { x: wrapX(Math.floor(mapX / TILE_PX), columns), y: Math.floor(mapY / TILE_PX) };
}

/** Déplace la caméra d'un glissement à l'écran : la carte suit le doigt. */
export function pan(camera: Camera, deltaX: number, deltaY: number): Camera {
  const scale = displayScale(camera.zoom);
  return { ...camera, x: camera.x - deltaX / scale, y: camera.y - deltaY / scale };
}

/**
 * Change le zoom d'un facteur, entre ses bornes, en gardant fixe le point de la carte sous
 * (screenX, screenY).
 */
export function zoomAt(
  camera: Camera,
  factor: number,
  viewport: Extent,
  screenX: number,
  screenY: number,
  limits: ZoomLimits,
): Camera {
  const anchor = screenToMap(camera, viewport, screenX, screenY);
  const zoom = clampZoom(camera.zoom * factor, limits);
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
