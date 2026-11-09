/**
 * Cuisson de la carte en pixels (tâche 1.7 ; REN-01, REN-02, REN-09).
 *
 * Chaque case occupe 4 × 4 pixels. Sa tuile tire ses pixels de la palette du biome
 * (ombre, base, lumière) selon un motif propre au biome : herbe, forêt, sable, roche,
 * glace, marais, eau. Puis :
 * - le relief se lit par un léger débordement des cases hautes sur les cases plus
 *   basses, qui déborde aussi des terres sur l'eau ;
 * - un ombrage suit la pente d'un relief interpolé au pixel, sous une lumière du
 *   nord-est, et une teinte thermique réchauffe les terres chaudes et bleuit les froides ;
 * - les rivières se dessinent au pixel, d'un centre de case à l'autre, d'autant plus
 *   larges que leur classe est haute.
 *
 * Tout se calcule en coordonnées de pixel du monde, x bouclant d'est en ouest : deux
 * blocs voisins se raccordent sans couture, y compris de part et d'autre de la couture.
 *
 * Le canal alpha ne porte pas de transparence, mais des données pour le shader des
 * saisons (tâche 1.8) : le bit 7 vaut 1 sur la terre et 0 sur l'eau, les 7 autres
 * codent l'ombrage, de 0,5 (0) à 1,5 (127).
 *
 * Fonctions pures, sans PixiJS : elles tournent dans le worker de cuisson.
 */
import type { Biome } from '../core/data/schemas';
import {
  CHUNK_SIZE,
  flowDirection,
  riverClass,
  type WorldLayers,
  type WorldSize,
} from '../core/world';
import { TILE_PX } from './camera';

/** Côté d'un bloc, en pixels de carte. */
export const CHUNK_PX = CHUNK_SIZE * TILE_PX;

export type Rgb = readonly [number, number, number];

/** Couleur #rrggbb en composantes. */
export function parseColor(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** Ce que la cuisson retient d'un biome. */
export interface BakeBiome {
  readonly shadow: Rgb;
  readonly base: Rgb;
  readonly light: Rgb;
  readonly style: Biome['tile'];
}

export function bakeBiomes(biomes: readonly Biome[]): BakeBiome[] {
  return biomes.map((biome) => ({
    shadow: parseColor(biome.palette.shadow),
    base: parseColor(biome.palette.base),
    light: parseColor(biome.palette.light),
    style: biome.tile,
  }));
}

/** Ce que la cuisson lit du monde. */
export interface BakeWorld {
  readonly size: WorldSize;
  readonly layers: WorldLayers;
  readonly biomes: readonly BakeBiome[];
  /** Palette des rivières : celle du biome « rivière ». */
  readonly river: BakeBiome;
}

/** Ombrage : force de la pente, et bornes. */
const SHADE_STRENGTH = 0.2;
const SHADE_MIN = 0.55;
const SHADE_MAX = 1.45;
/** Exposant de l'altitude dans le relief d'ombrage : les plaines gardent leurs ondulations. */
const RELIEF_EXPONENT = 0.6;

/** Débordement : écart d'altitude minimal entre deux terres (m). */
const OVERFLOW_MIN = 40;
/** Écart à partir duquel le débordement gagne un second pixel. */
const OVERFLOW_DEEP = 400;

/** Matrice de Bayer 4 × 4, pour tramer sans sortir de la palette. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(
  (value) => (value + 0.5) / 16,
);

/** Pas des huit directions d'écoulement (src/worldgen/grid.ts). */
const DIRECTION_STEPS: readonly (readonly [number, number])[] = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

/** Hachage d'un pixel du monde, dans [0, 1) ; `salt` donne des tirages indépendants. */
function hash(x: number, y: number, salt: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(salt, 1013904223);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Couleur d'un pixel de tuile, selon le motif du biome. */
function tileColor(
  biome: BakeBiome,
  wx: number,
  wy: number,
  cellNoise: number,
  density: number,
  depth: number,
): Rgb {
  const v = hash(wx, wy, 1);
  switch (biome.style) {
    case 'grass': {
      const shift = (cellNoise - 0.5) * 0.12;
      if (v < 0.16 + shift) return biome.shadow;
      if (v > 0.86 + shift) return biome.light;
      return biome.base;
    }
    case 'forest': {
      // Des houppiers : des taches d'ombre par deux pixels, plus serrées si la forêt est dense.
      const clump = 0.6 * hash(wx >> 1, wy >> 1, 2) + 0.4 * v;
      if (clump < 0.14 + 0.36 * density) return biome.shadow;
      if (clump > 0.9) return biome.light;
      return biome.base;
    }
    case 'sand':
      if (v < 0.08) return biome.shadow;
      if (v > 0.74) return biome.light;
      return biome.base;
    case 'rock': {
      const block = hash(wx >> 1, wy >> 1, 3);
      if (block < 0.3) return biome.shadow;
      if (block > 0.74) return biome.light;
      return biome.base;
    }
    case 'ice':
      if (v < 0.07) return biome.shadow;
      if (v > 0.35) return biome.light;
      return biome.base;
    case 'marsh': {
      const clump = 0.5 * hash(wx >> 1, wy >> 1, 4) + 0.5 * v;
      if (clump < 0.24) return biome.shadow;
      if (clump > 0.86) return biome.light;
      return biome.base;
    }
    case 'water': {
      // Trois teintes selon la profondeur, tramées : clair, base, sombre.
      const t = Math.min(1, Math.log2(1 + depth / 8) / Math.log2(1 + 4000 / 8));
      const threshold = BAYER[(wy & 3) * 4 + (wx & 3)] ?? 0.5;
      const level = t * 2;
      let color: Rgb;
      if (level < 1) color = level > threshold ? biome.base : biome.light;
      else color = level - 1 > threshold ? biome.shadow : biome.base;
      // Quelques reflets, en eau peu profonde.
      if (t < 0.5 && v > 0.985) return biome.light;
      return color;
    }
  }
}

/** Pixels RGBA du bloc (column, row). */
export function bakeChunk(world: BakeWorld, column: number, row: number): Uint8Array<ArrayBuffer> {
  return bakeRegion(world, column * CHUNK_PX, row * CHUNK_PX, CHUNK_PX, CHUNK_PX);
}

/**
 * Pixels RGBA de la région de `width` × `height` pixels dont le coin nord-ouest est le
 * pixel (left, top) du monde ; `left` boucle d'est en ouest, la région reste entre les
 * pôles.
 */
export function bakeRegion(
  world: BakeWorld,
  left: number,
  top: number,
  width: number,
  height: number,
): Uint8Array<ArrayBuffer> {
  const { size, layers, biomes } = world;
  const worldWidthPx = size.width * TILE_PX;
  // Fenêtre de cases : la région, plus deux cases de marge de chaque côté.
  const margin = 2;
  const cellLeft = Math.floor(left / TILE_PX) - margin;
  const cellTop = Math.floor(top / TILE_PX) - margin;
  const cols = Math.ceil((left + width) / TILE_PX) + margin - cellLeft;
  const rowsCount = Math.ceil((top + height) / TILE_PX) + margin - cellTop;
  const wrapCellX = (x: number) => ((x % size.width) + size.width) % size.width;
  const clampCellY = (y: number) => Math.min(size.height - 1, Math.max(0, y));
  const cellIndex = (x: number, y: number) => clampCellY(y) * size.width + wrapCellX(x);

  // Données de la fenêtre, case par case.
  const windowCount = cols * rowsCount;
  const winBiome = new Uint8Array(windowCount);
  const winWater = new Uint8Array(windowCount);
  const winHeight = new Float32Array(windowCount);
  const winRelief = new Float32Array(windowCount);
  const winDepth = new Float32Array(windowCount);
  const winDensity = new Float32Array(windowCount);
  const winTemperature = new Float32Array(windowCount);
  const winNoise = new Float32Array(windowCount);
  for (let wy = 0; wy < rowsCount; wy++) {
    for (let wx = 0; wx < cols; wx++) {
      const cx = cellLeft + wx;
      const cy = cellTop + wy;
      const index = cellIndex(cx, cy);
      const slot = wy * cols + wx;
      const biome = layers.biome[index] ?? 0;
      const depth = layers.waterDepth[index] ?? 0;
      const water = biomes.at(biome)?.style === 'water';
      const elevation = layers.elevation[index] ?? 0;
      winBiome[slot] = biome;
      winWater[slot] = water ? 1 : 0;
      winDepth[slot] = depth;
      // Hauteur de débordement : l'eau au plus bas, les terres à leur altitude.
      winHeight[slot] = water ? -100000 + elevation : elevation;
      // Relief d'ombrage : la surface de l'eau est plate ; les terres comptent leur altitude.
      const surface = water ? Math.max(0, elevation + depth) : Math.max(0, elevation);
      winRelief[slot] = Math.pow(surface, RELIEF_EXPONENT);
      winDensity[slot] = (layers.trees[index] ?? 0) / 255;
      winTemperature[slot] = (layers.temperature[index] ?? 0) / 10;
      winNoise[slot] = hash(wrapCellX(cx), clampCellY(cy), 7);
    }
  }
  const slotOf = (cx: number, cy: number) => (cy - cellTop) * cols + (cx - cellLeft);

  // Relief au pixel, interpolé entre les centres des cases, sur la région et un pixel de
  // marge, pour l'ombrage.
  const reliefWidth = width + 2;
  const reliefHeight = height + 2;
  const relief = new Float32Array(reliefWidth * reliefHeight);
  for (let ry = 0; ry < reliefHeight; ry++) {
    const py = top - 1 + ry;
    const fy = (py + 0.5) / TILE_PX - 0.5;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    for (let rx = 0; rx < reliefWidth; rx++) {
      const px = left - 1 + rx;
      const fx = (px + 0.5) / TILE_PX - 0.5;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const a = winRelief[slotOf(x0, y0)] ?? 0;
      const b = winRelief[slotOf(x0 + 1, y0)] ?? 0;
      const c = winRelief[slotOf(x0, y0 + 1)] ?? 0;
      const d = winRelief[slotOf(x0 + 1, y0 + 1)] ?? 0;
      relief[ry * reliefWidth + rx] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
  }

  // Rivières : un masque de leur classe, au pixel.
  const rivers = new Uint8Array(width * height);
  for (let wy = 1; wy < rowsCount - 1; wy++) {
    for (let wx = 1; wx < cols - 1; wx++) {
      const cx = cellLeft + wx;
      const cy = cellTop + wy;
      if (cy < 0 || cy >= size.height) continue;
      const drainage = layers.drainage[cellIndex(cx, cy)] ?? 0;
      const river = riverClass(drainage);
      const direction = flowDirection(drainage);
      if (river === 0 || direction > 7) continue;
      const [dx, dy] = DIRECTION_STEPS[direction] ?? [0, 0];
      // Une rivière qui finit sous un glacier s'arrête à son bord : la case aval, sans
      // rivière ni eau, ne la dessine pas.
      const target = cellIndex(cx + dx, cy + dy);
      const ends =
        riverClass(layers.drainage[target] ?? 0) === 0 &&
        biomes.at(layers.biome[target] ?? 0)?.style !== 'water';
      const reach = ends ? 0.5 : 1;
      drawSegment(
        rivers,
        { width, height, left, top },
        cx,
        cy,
        cx + dx * reach,
        cy + dy * reach,
        river,
      );
    }
  }

  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const py = top + y;
    const cy = Math.floor(py / TILE_PX);
    const sy = py - cy * TILE_PX;
    for (let x = 0; x < width; x++) {
      const pxRaw = left + x;
      const px = ((pxRaw % worldWidthPx) + worldWidthPx) % worldWidthPx;
      const cx = Math.floor(pxRaw / TILE_PX);
      const sx = pxRaw - cx * TILE_PX;
      const source = overflowSource(px, py, cx, cy, sx, sy);
      const biome = biomes.at(winBiome[source] ?? 0) ?? world.river;
      let color = tileColor(
        biome,
        px,
        py,
        winNoise[source] ?? 0,
        winDensity[source] ?? 0,
        winDepth[source] ?? 0,
      );
      let water = (winWater[source] ?? 0) === 1;
      const river = rivers[y * width + x] ?? 0;
      if (river !== 0 && !water) {
        color = river === 1 ? world.river.light : world.river.base;
        water = true;
      }

      // Ombrage selon la pente, lumière du nord-est.
      const center = (y + 1) * reliefWidth + (x + 1);
      const gx = ((relief[center + 1] ?? 0) - (relief[center - 1] ?? 0)) / 2;
      const gy = ((relief[center + reliefWidth] ?? 0) - (relief[center - reliefWidth] ?? 0)) / 2;
      const lit = (gy - gx) * Math.SQRT1_2;
      const shade = water ? 1 : Math.min(SHADE_MAX, Math.max(SHADE_MIN, 1 + SHADE_STRENGTH * lit));

      // Teinte thermique des terres : plus chaude au chaud, plus bleue au froid.
      let red = color[0] * shade;
      let green = color[1] * shade;
      let blue = color[2] * shade;
      if (!water) {
        const temperature = winTemperature[source] ?? 0;
        const warm = Math.min(1, Math.max(0, (temperature - 18) / 12));
        const cold = Math.min(1, Math.max(0, -temperature / 20));
        red *= 1 + 0.05 * warm - 0.05 * cold;
        green *= 1 + 0.01 * warm;
        blue *= 1 - 0.06 * warm + 0.06 * cold;
      }
      const offset = (y * width + x) * 4;
      pixels[offset] = Math.min(255, Math.max(0, Math.round(red)));
      pixels[offset + 1] = Math.min(255, Math.max(0, Math.round(green)));
      pixels[offset + 2] = Math.min(255, Math.max(0, Math.round(blue)));
      const level = Math.min(127, Math.max(0, Math.round((shade - 0.5) * 127)));
      pixels[offset + 3] = (water ? 0 : 128) | level;
    }
  }
  return pixels;

  /**
   * Case dont le pixel (px, py) prend la tuile : la sienne, ou une voisine plus haute qui
   * déborde sur son bord. Une terre déborde sur l'eau une fois sur deux ; entre terres,
   * d'autant plus souvent que l'écart est grand, et sur un second pixel pour les plus
   * grands écarts. Les tirages ne dépendent que du pixel : le résultat est le même d'un
   * bloc à l'autre.
   */
  function overflowSource(
    px: number,
    py: number,
    cx: number,
    cy: number,
    sx: number,
    sy: number,
  ): number {
    let source = slotOf(cx, cy);
    const own = winHeight[source] ?? 0;
    const ownWater = (winWater[source] ?? 0) === 1;
    const edgeX = sx === 0 ? -1 : sx === TILE_PX - 1 ? 1 : 0;
    const edgeY = sy === 0 ? -1 : sy === TILE_PX - 1 ? 1 : 0;
    if (edgeX !== 0 || edgeY !== 0) {
      let best = own;
      // Voisins du bord : côté, puis dessus ou dessous, puis la diagonale d'un coin.
      for (let candidate = 0; candidate < 3; candidate++) {
        const ox = candidate === 1 ? 0 : edgeX;
        const oy = candidate === 0 ? 0 : edgeY;
        if (ox === 0 && oy === 0) continue;
        if (candidate === 2 && (edgeX === 0 || edgeY === 0)) continue;
        const slot = slotOf(cx + ox, cy + oy);
        const other = winHeight[slot] ?? 0;
        const rise = other - own;
        if (rise < OVERFLOW_MIN || other <= best) continue;
        const coast = ownWater && (winWater[slot] ?? 0) === 0;
        const weight = candidate === 2 ? 0.7 : 1;
        const chance = (coast ? 0.5 : Math.min(0.7, 0.2 + (rise - OVERFLOW_MIN) / 500)) * weight;
        if (hash(px, py, 11 + ox * 3 + oy) < chance) {
          best = other;
          source = slot;
        }
      }
      return source;
    }
    // Au cœur de la case, les plus grands écarts entre terres débordent d'un second pixel.
    const towardX = sx === 1 ? -1 : 1;
    const towardY = sy === 1 ? -1 : 1;
    for (let candidate = 0; candidate < 2; candidate++) {
      const ox = candidate === 0 ? towardX : 0;
      const oy = candidate === 0 ? 0 : towardY;
      const slot = slotOf(cx + ox, cy + oy);
      const rise = (winHeight[slot] ?? 0) - own;
      if (
        !ownWater &&
        rise >= OVERFLOW_DEEP &&
        hash(px, py, 17 + ox + 2 * oy) < Math.min(0.35, (rise - OVERFLOW_DEEP) / 1500)
      ) {
        source = slot;
        break;
      }
    }
    return source;
  }
}

/** Région d'un masque de pixels, dans les coordonnées de pixel du monde. */
interface MaskRegion {
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly top: number;
}

/**
 * Trace dans le masque des rivières le segment qui joint le centre de la case (ax, ay)
 * à celui de la case (bx, by), en coordonnées de cases non bouclées : un tampon carré
 * de 1 à 3 pixels, selon la classe, le long du segment.
 */
function drawSegment(
  mask: Uint8Array,
  region: MaskRegion,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  river: number,
): void {
  const { width, height, left, top } = region;
  const center = (TILE_PX - 1) / 2;
  const startX = ax * TILE_PX + center - left;
  const startY = ay * TILE_PX + center - top;
  const endX = bx * TILE_PX + center - left;
  const endY = by * TILE_PX + center - top;
  const brush = river;
  const offset = Math.floor((brush - 1) / 2);
  const steps = TILE_PX * 4;
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    const px = Math.round(startX + (endX - startX) * t) - offset;
    const py = Math.round(startY + (endY - startY) * t) - offset;
    for (let dy = 0; dy < brush; dy++) {
      const y = py + dy;
      if (y < 0 || y >= height) continue;
      for (let dx = 0; dx < brush; dx++) {
        const x = px + dx;
        if (x < 0 || x >= width) continue;
        const slot = y * width + x;
        if ((mask[slot] ?? 0) < river) mask[slot] = river;
      }
    }
  }
}
