/**
 * Cuisson de la carte en pixels (tâches 1.7 et 1.8 ; REN-01, REN-02, REN-09 ; ADR 0010).
 *
 * Chaque case occupe 4 × 4 pixels. Sa tuile tire ses pixels de la palette du biome
 * (ombre, base, lumière) selon un motif propre au biome : herbe, forêt, sable, roche,
 * glace, marais, eau. Puis :
 * - les limites entre tuiles s'arrondissent et se découpent : chaque pixel prend la
 *   tuile qui domine autour de lui, et une case plus haute déborde sur ses voisines
 *   plus basses, d'autant plus loin que l'écart est grand ; les terres débordent ainsi
 *   sur l'eau, ce qui découpe les côtes ;
 * - un ombrage suit la pente d'un relief interpolé au pixel, sous une lumière du
 *   nord-est, et une teinte thermique réchauffe les terres chaudes et bleuit les froides ;
 * - l'eau prend sa teinte selon sa profondeur, interpolée au pixel et tramée ;
 * - les rivières suivent une courbe lissée par les centres de leurs cases, un peu
 *   décalés pour qu'elles serpentent, de 2 ou 3 pixels de large selon leur classe ; le
 *   lit d'un fleuve garde les terres de ses rives. Les ruisseaux, d'un pixel, sont
 *   seulement marqués : le shader ne les montre que de près.
 *
 * Tout se calcule en coordonnées de pixel du monde, x bouclant d'est en ouest : deux
 * blocs voisins se raccordent sans couture, y compris de part et d'autre de la couture.
 *
 * Les pixels portent des données pour le shader (tâche 1.8) : le bit de poids faible du
 * rouge vaut 1 sur la terre et 0 sur l'eau, celui du vert marque les ruisseaux, et
 * l'alpha code l'ombrage, de 0,5 (0) à 1,5 (255). Une moyenne de pixels, comme celle des
 * mipmaps, garde un ombrage valable ; les bits, eux, ne se lisent qu'au niveau 0.
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
  /** Indice du biome « rivière », lit des fleuves, dont la palette colore les rivières. */
  readonly riverBiome: number;
}

/** Ce que portent les bits d'un pixel cuit. */
export interface PixelData {
  readonly land: boolean;
  readonly stream: boolean;
  /** Ombrage, de 0,5 à 1,5. */
  readonly shade: number;
}

/** Données du pixel d'indice `index` (en pixels) d'une région cuite. */
export function pixelData(pixels: Uint8Array, index: number): PixelData {
  const offset = index * 4;
  return {
    land: ((pixels[offset] ?? 0) & 1) === 1,
    stream: ((pixels[offset + 1] ?? 0) & 1) === 1,
    shade: (pixels[offset + 3] ?? 0) / 255 + 0.5,
  };
}

/** Ombrage : force de la pente, et bornes. */
const SHADE_STRENGTH = 0.2;
const SHADE_MIN = 0.55;
const SHADE_MAX = 1.45;
/** Exposant de l'altitude dans le relief d'ombrage : les plaines gardent leurs ondulations. */
const RELIEF_EXPONENT = 0.6;

/**
 * Débordement : avantage d'une case plus haute sur ses voisines, ajouté au poids de sa
 * tuile au pixel. Il croît jusqu'à NEAR pour un écart de NEAR_RANGE mètres, puis, des
 * FAR_START aux FAR_START + FAR_RANGE mètres, jusqu'à NEAR + FAR : assez pour déborder
 * d'un second pixel.
 */
const LIFT_NEAR = 0.3;
const LIFT_NEAR_RANGE = 120;
const LIFT_FAR = 0.38;
const LIFT_FAR_START = 300;
const LIFT_FAR_RANGE = 1200;
/** Hauteur de l'eau pour le débordement : une terre au niveau de la mer la domine de 60 m. */
const WATER_LIFT_HEIGHT = -60;
/** Amplitude du bruit qui découpe les limites entre tuiles. */
const EDGE_NOISE = 0.34;

/** Décalage maximal du centre d'une case de rivière, en pixels : la rivière serpente. */
const RIVER_JITTER = 1.1;
/** Marge du masque des rivières autour de la région, en pixels. */
const RIVER_MARGIN = 3;
/** Assombrissement des rives d'une rivière. */
const BANK_SHADE = 0.86;

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

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Avantage de débordement d'une case qui domine de `rise` mètres. */
function lift(rise: number): number {
  if (rise <= 0) return 0;
  return (
    LIFT_NEAR * clamp01(rise / LIFT_NEAR_RANGE) +
    LIFT_FAR * clamp01((rise - LIFT_FAR_START) / LIFT_FAR_RANGE)
  );
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
  const riverPalette = biomes.at(world.riverBiome);
  const worldWidthPx = size.width * TILE_PX;
  // Fenêtre de cases : la région, plus trois cases de marge de chaque côté (rivières).
  const margin = 3;
  const cellLeft = Math.floor(left / TILE_PX) - margin;
  const cellTop = Math.floor(top / TILE_PX) - margin;
  const cols = Math.ceil((left + width) / TILE_PX) + margin - cellLeft;
  const rowsCount = Math.ceil((top + height) / TILE_PX) + margin - cellTop;
  const wrapCellX = (x: number) => ((x % size.width) + size.width) % size.width;
  const clampCellY = (y: number) => Math.min(size.height - 1, Math.max(0, y));
  const cellIndex = (x: number, y: number) => clampCellY(y) * size.width + wrapCellX(x);
  const isWaterBiome = (biome: number) =>
    biome !== world.riverBiome && biomes.at(biome)?.style === 'water';

  // Données de la fenêtre, case par case.
  const windowCount = cols * rowsCount;
  const winTile = new Uint8Array(windowCount);
  const winWater = new Uint8Array(windowCount);
  const winLift = new Float32Array(windowCount);
  const winRelief = new Float32Array(windowCount);
  const winDepth = new Float32Array(windowCount);
  const winDensity = new Float32Array(windowCount);
  const winTemperature = new Float32Array(windowCount);
  const winNoise = new Float32Array(windowCount);
  const winDrainage = new Uint8Array(windowCount);
  for (let wy = 0; wy < rowsCount; wy++) {
    for (let wx = 0; wx < cols; wx++) {
      const cx = cellLeft + wx;
      const cy = cellTop + wy;
      const index = cellIndex(cx, cy);
      const slot = wy * cols + wx;
      const biome = layers.biome[index] ?? 0;
      const depth = layers.waterDepth[index] ?? 0;
      const elevation = layers.elevation[index] ?? 0;
      // Le lit d'un fleuve garde les terres de ses rives : la tuile la plus fréquente de
      // ses voisines de terre, l'eau s'il n'en a pas.
      let tile = biome;
      let water = isWaterBiome(biome);
      if (biome === world.riverBiome) {
        tile = bankTile(cx, cy) ?? biome;
        water = tile === biome;
      }
      winTile[slot] = tile;
      winWater[slot] = water ? 1 : 0;
      winDepth[slot] = water ? depth : 0;
      winLift[slot] = water ? WATER_LIFT_HEIGHT : Math.max(0, elevation);
      // Relief d'ombrage : la surface de l'eau est plate ; les terres comptent leur altitude.
      const surface = water ? Math.max(0, elevation + depth) : Math.max(0, elevation);
      winRelief[slot] = Math.pow(surface, RELIEF_EXPONENT);
      winDensity[slot] = (layers.trees[index] ?? 0) / 255;
      winTemperature[slot] = (layers.temperature[index] ?? 0) / 10;
      winNoise[slot] = hash(wrapCellX(cx), clampCellY(cy), 7);
      winDrainage[slot] = layers.drainage[index] ?? 0;
    }
  }
  const slotOf = (cx: number, cy: number) => (cy - cellTop) * cols + (cx - cellLeft);

  /** Tuile des rives de la case (cx, cy) : celle qui revient le plus parmi ses voisines. */
  function bankTile(cx: number, cy: number): number | undefined {
    const counts = new Map<number, number>();
    for (const [dx, dy] of DIRECTION_STEPS) {
      const neighbor = layers.biome[cellIndex(cx + dx, cy + dy)] ?? 0;
      if (neighbor === world.riverBiome || isWaterBiome(neighbor)) continue;
      counts.set(neighbor, (counts.get(neighbor) ?? 0) + 1);
    }
    let best: number | undefined;
    let bestCount = 0;
    for (const [neighbor, count] of counts) {
      if (count > bestCount) {
        best = neighbor;
        bestCount = count;
      }
    }
    return best;
  }

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

  const rivers = riverMask(world, {
    left: left - RIVER_MARGIN,
    top: top - RIVER_MARGIN,
    width: width + 2 * RIVER_MARGIN,
    height: height + 2 * RIVER_MARGIN,
    cellLeft,
    cellTop,
    cols,
    rows: rowsCount,
    drainage: winDrainage,
    water: winWater,
  });
  const maskWidth = width + 2 * RIVER_MARGIN;
  const riverAt = (x: number, y: number) =>
    rivers[(y + RIVER_MARGIN) * maskWidth + x + RIVER_MARGIN] ?? 0;

  const pixels = new Uint8Array(width * height * 4);
  const weights = [0, 0, 0, 0];
  const slots = [0, 0, 0, 0];
  for (let y = 0; y < height; y++) {
    const py = top + y;
    const cy = Math.floor(py / TILE_PX);
    const fy = (py + 0.5) / TILE_PX - 0.5;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const pxRaw = left + x;
      const px = ((pxRaw % worldWidthPx) + worldWidthPx) % worldWidthPx;
      const cx = Math.floor(pxRaw / TILE_PX);
      const fx = (pxRaw + 0.5) / TILE_PX - 0.5;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const own = slotOf(cx, cy);
      slots[0] = slotOf(x0, y0);
      slots[1] = slotOf(x0 + 1, y0);
      slots[2] = slotOf(x0, y0 + 1);
      slots[3] = slotOf(x0 + 1, y0 + 1);
      weights[0] = (1 - tx) * (1 - ty);
      weights[1] = tx * (1 - ty);
      weights[2] = (1 - tx) * ty;
      weights[3] = tx * ty;

      // La tuile qui domine le pixel : poids des cases qui l'entourent, avantage des plus
      // hautes, et un bruit qui découpe les limites.
      const ownLift = winLift[own] ?? 0;
      let source = own;
      let best = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < 4; i++) {
        const tile = winTile[slots[i] ?? 0] ?? 0;
        let seen = false;
        for (let j = 0; j < i; j++) if (winTile[slots[j] ?? 0] === tile) seen = true;
        if (seen) continue;
        let weight = 0;
        let advantage = 0;
        let candidate = slots[i] ?? 0;
        let candidateWeight = -1;
        for (let j = i; j < 4; j++) {
          const slot = slots[j] ?? 0;
          if (winTile[slot] !== tile) continue;
          const w = weights[j] ?? 0;
          weight += w;
          if (slot !== own) advantage = Math.max(advantage, lift((winLift[slot] ?? 0) - ownLift));
          // La case qui prête ses détails (densité, bruit) : la case du pixel, sinon la
          // plus proche.
          if (slot === own) {
            candidate = own;
            candidateWeight = 2;
          } else if (w > candidateWeight) {
            candidate = slot;
            candidateWeight = w;
          }
        }
        const noise =
          EDGE_NOISE *
          (0.65 * hash(px >> 1, py >> 1, 30 + tile) + 0.35 * hash(px, py, 31 + tile) - 0.5);
        const score = weight + advantage + noise;
        if (score > best) {
          best = score;
          source = candidate;
        }
      }

      let water = (winWater[source] ?? 0) === 1;
      // Profondeur de l'eau interpolée entre les cases d'eau voisines : un fond sans marches.
      let depth = 0;
      if (water) {
        let total = 0;
        for (let i = 0; i < 4; i++) {
          const slot = slots[i] ?? 0;
          if ((winWater[slot] ?? 0) !== 1) continue;
          depth += (weights[i] ?? 0) * (winDepth[slot] ?? 0);
          total += weights[i] ?? 0;
        }
        depth = total > 0 ? depth / total : (winDepth[source] ?? 0);
      }
      const biome = biomes.at(winTile[source] ?? 0);
      let color: Rgb =
        biome === undefined
          ? [0, 0, 0]
          : tileColor(biome, px, py, winNoise[source] ?? 0, winDensity[source] ?? 0, depth);

      const river = riverAt(x, y);
      let stream = false;
      let bank = false;
      if (!water && river >= 2 && riverPalette !== undefined) {
        // Rivières et fleuves : l'eau, avec quelques reflets sur les plus larges.
        color = river >= 3 && hash(px, py, 5) > 0.93 ? riverPalette.light : riverPalette.base;
        water = true;
      } else if (!water && river === 1) {
        stream = true;
      } else if (!water) {
        bank =
          riverAt(x - 1, y) >= 2 ||
          riverAt(x + 1, y) >= 2 ||
          riverAt(x, y - 1) >= 2 ||
          riverAt(x, y + 1) >= 2;
      }

      // Ombrage selon la pente, lumière du nord-est.
      const center = (y + 1) * reliefWidth + (x + 1);
      const gx = ((relief[center + 1] ?? 0) - (relief[center - 1] ?? 0)) / 2;
      const gy = ((relief[center + reliefWidth] ?? 0) - (relief[center - reliefWidth] ?? 0)) / 2;
      const lit = (gy - gx) * Math.SQRT1_2;
      let shade = water ? 1 : Math.min(SHADE_MAX, Math.max(SHADE_MIN, 1 + SHADE_STRENGTH * lit));
      if (bank) shade *= BANK_SHADE;

      // Teinte thermique des terres : plus chaude au chaud, plus bleue au froid.
      let red = color[0] * shade;
      let green = color[1] * shade;
      let blue = color[2] * shade;
      if (!water) {
        const temperature = winTemperature[source] ?? 0;
        const warm = clamp01((temperature - 18) / 12);
        const cold = clamp01(-temperature / 20);
        red *= 1 + 0.05 * warm - 0.05 * cold;
        green *= 1 + 0.01 * warm;
        blue *= 1 - 0.06 * warm + 0.06 * cold;
      }
      const offset = (y * width + x) * 4;
      const byte = (value: number) => Math.min(255, Math.max(0, Math.round(value)));
      pixels[offset] = (byte(red) & 0xfe) | (water ? 0 : 1);
      pixels[offset + 1] = (byte(green) & 0xfe) | (stream ? 1 : 0);
      pixels[offset + 2] = byte(blue);
      pixels[offset + 3] = byte((Math.min(SHADE_MAX, shade) - 0.5) * 255);
    }
  }
  return pixels;
}

/** Ce que le tracé des rivières lit de la fenêtre de cases. */
interface RiverWindow {
  /** Région du masque, en pixels du monde non bouclés. */
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** Fenêtre de cases et ses données. */
  readonly cellLeft: number;
  readonly cellTop: number;
  readonly cols: number;
  readonly rows: number;
  readonly drainage: Uint8Array;
  readonly water: Uint8Array;
}

/**
 * Masque des rivières, une classe par pixel. Chaque rivière suit une courbe de Bézier
 * quadratique d'un milieu à l'autre entre les centres décalés des cases, ce qui en fait
 * une B-spline continue d'une case à la suivante ; un affluent rejoint ainsi le cours
 * principal en douceur. Les ruisseaux tracent un trait d'un pixel sans marche en L.
 */
function riverMask(world: BakeWorld, window: RiverWindow): Uint8Array {
  const { size } = world;
  const { cellLeft, cellTop, cols, rows, drainage, water } = window;
  const mask = new Uint8Array(window.width * window.height);
  const slotOf = (cx: number, cy: number) => (cy - cellTop) * cols + (cx - cellLeft);
  const wrapX = (x: number) => ((x % size.width) + size.width) % size.width;
  /** Centre décalé de la case (cx, cy), en pixels du masque. */
  const control = (cx: number, cy: number): [number, number] => {
    const jx = (hash(wrapX(cx), cy, 41) - 0.5) * 2 * RIVER_JITTER;
    const jy = (hash(wrapX(cx), cy, 42) - 0.5) * 2 * RIVER_JITTER;
    return [
      cx * TILE_PX + TILE_PX / 2 + jx - window.left,
      cy * TILE_PX + TILE_PX / 2 + jy - window.top,
    ];
  };
  const mix = (a: [number, number], b: [number, number], t: number): [number, number] => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
  ];
  for (let wy = 1; wy < rows - 1; wy++) {
    for (let wx = 1; wx < cols - 1; wx++) {
      const cx = cellLeft + wx;
      const cy = cellTop + wy;
      if (cy < 0 || cy >= size.height) continue;
      const slot = slotOf(cx, cy);
      const code = drainage[slot] ?? 0;
      const river = riverClass(code);
      const direction = flowDirection(code);
      if (river === 0 || direction > 7 || (water[slot] ?? 0) === 1) continue;
      const [dx, dy] = DIRECTION_STEPS[direction] ?? [0, 0];
      const here = control(cx, cy);
      const next = control(cx + dx, cy + dy);
      const downstream = slotOf(cx + dx, cy + dy);
      // Vers l'eau, la rivière entre dans la case d'eau, au-delà des terres qui y
      // débordent ; ailleurs, elle s'arrête au milieu de deux cases, où la suivante la
      // reprend (sous un glacier, elle s'y arrête tout court).
      const end = mix(here, next, (water[downstream] ?? 0) === 1 ? 0.85 : 0.5);
      // Affluents : chacun arrive du milieu de sa case et de celle-ci ; le plus fort,
      // ou une eau qui s'écoule, porte la largeur de la case.
      const upstreams: { start: [number, number]; river: number }[] = [];
      let main = -1;
      let mainRiver = -1;
      for (let d = 0; d < 8; d++) {
        const [ux, uy] = DIRECTION_STEPS[d] ?? [0, 0];
        const sx = cx + ux;
        const sy = cy + uy;
        if (sy < 0 || sy >= size.height) continue;
        const upstream = slotOf(sx, sy);
        const upCode = drainage[upstream] ?? 0;
        const upDirection = flowDirection(upCode);
        if (upDirection > 7) continue;
        const [vx, vy] = DIRECTION_STEPS[upDirection] ?? [0, 0];
        if (sx + vx !== cx || sy + vy !== cy) continue;
        const fromWater = (water[upstream] ?? 0) === 1;
        const upRiver = fromWater ? river : riverClass(upCode);
        if (upRiver === 0) continue;
        const there = control(sx, sy);
        upstreams.push({
          start: fromWater ? mix(here, there, 0.85) : mix(there, here, 0.5),
          river: Math.min(river, upRiver),
        });
        if (upRiver > mainRiver) {
          main = upstreams.length - 1;
          mainRiver = upRiver;
        }
      }
      // Une source naît au centre de sa case.
      if (upstreams.length === 0) drawCurve(mask, window, here, here, end, river);
      upstreams.forEach((upstream, index) => {
        drawCurve(mask, window, upstream.start, here, end, index === main ? river : upstream.river);
      });
    }
  }
  return mask;
}

/**
 * Trace dans le masque la courbe de Bézier quadratique de `a` à `b`, de point de
 * contrôle `c`, avec un pinceau de 1 à 3 pixels selon la classe.
 */
function drawCurve(
  mask: Uint8Array,
  window: { readonly width: number; readonly height: number },
  a: readonly [number, number],
  c: readonly [number, number],
  b: readonly [number, number],
  river: number,
): void {
  const length = Math.hypot(c[0] - a[0], c[1] - a[1]) + Math.hypot(b[0] - c[0], b[1] - c[1]);
  const steps = Math.max(2, Math.ceil(length * 4));
  const points: number[] = [];
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    const u = 1 - t;
    const x = Math.floor(u * u * a[0] + 2 * u * t * c[0] + t * t * b[0]);
    const y = Math.floor(u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]);
    const count = points.length;
    if (count >= 2 && points[count - 2] === x && points[count - 1] === y) continue;
    points.push(x, y);
  }
  // Un trait d'un pixel sans marche : un pixel dont les voisins sur le trait se touchent
  // en diagonale est en trop.
  const keep = new Uint8Array(points.length / 2).fill(1);
  if (river === 1) {
    for (let i = 1; i + 1 < points.length / 2; i++) {
      const ax = points[2 * (i - 1)] ?? 0;
      const ay = points[2 * (i - 1) + 1] ?? 0;
      const bx = points[2 * (i + 1)] ?? 0;
      const by = points[2 * (i + 1) + 1] ?? 0;
      if (Math.abs(ax - bx) === 1 && Math.abs(ay - by) === 1 && keep[i - 1] === 1) keep[i] = 0;
    }
  }
  const { width, height } = window;
  const put = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const slot = y * width + x;
    if ((mask[slot] ?? 0) < river) mask[slot] = river;
  };
  for (let i = 0; i < points.length / 2; i++) {
    if (keep[i] === 0) continue;
    const x = points[2 * i] ?? 0;
    const y = points[2 * i + 1] ?? 0;
    put(x, y);
    if (river === 2) {
      put(x + 1, y);
      put(x, y + 1);
      put(x + 1, y + 1);
    } else if (river >= 3) {
      put(x - 1, y);
      put(x + 1, y);
      put(x, y - 1);
      put(x, y + 1);
    }
  }
}
