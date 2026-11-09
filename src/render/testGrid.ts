/**
 * Grille de test de la phase 0 : cuisson d'un bloc de la couche de test en pixels.
 * Elle rend visibles la couture est-ouest (bord ouest de la colonne 0, en rouge),
 * les bords des blocs, l'équateur et les pôles : un saut à la couture s'y verrait.
 */
import type { ChunkLayer } from '../core/protocol';
import { CHUNK_SIZE, type ChunkGrid } from '../core/world';
import { TILE_PX } from './camera';

/** Côté d'un bloc, en pixels de carte. */
export const CHUNK_PX = CHUNK_SIZE * TILE_PX;

type Rgb = readonly [number, number, number];

const LIGHT: Rgb = [58, 74, 52];
const DARK: Rgb = [48, 62, 44];
const POLAR_LIGHT: Rgb = [150, 162, 176];
const POLAR_DARK: Rgb = [134, 146, 162];
const CHUNK_EDGE: Rgb = [30, 38, 28];
const SEAM: Rgb = [196, 48, 36];
const EQUATOR: Rgb = [192, 154, 69];

/** Couleurs des cases peintes : promeneurs de test (1 à 7), puis pinceau (8 et plus). */
const PAINT: readonly Rgb[] = [
  [214, 96, 77],
  [226, 170, 74],
  [232, 214, 120],
  [120, 190, 110],
  [96, 170, 210],
  [150, 120, 210],
  [210, 120, 180],
  [245, 240, 225],
];

/** Couleur d'une case : peinte, ou en damier, plus claire près des pôles. */
function cellColor(value: number, x: number, y: number, height: number): Rgb {
  if (value > 0) return PAINT[Math.min(value, PAINT.length) - 1];
  const polar = y < height / 16 || y >= height - height / 16;
  const even = (x + y) % 2 === 0;
  if (polar) return even ? POLAR_LIGHT : POLAR_DARK;
  return even ? LIGHT : DARK;
}

/**
 * Pixels RGBA d'un bloc : chaque case occupe TILE_PX × TILE_PX pixels. `grid` situe
 * le bloc dans le monde, pour placer la couture et l'équateur.
 */
export function bakeTestChunk(layer: ChunkLayer, grid: ChunkGrid): Uint8Array<ArrayBuffer> {
  const pixels = new Uint8Array(CHUNK_PX * CHUNK_PX * 4);
  const height = grid.rows * CHUNK_SIZE;
  const equator = height / 2;
  for (let cellY = 0; cellY < CHUNK_SIZE; cellY++) {
    const worldY = layer.row * CHUNK_SIZE + cellY;
    for (let cellX = 0; cellX < CHUNK_SIZE; cellX++) {
      const worldX = layer.column * CHUNK_SIZE + cellX;
      const color = cellColor(layer.cells[cellY * CHUNK_SIZE + cellX] ?? 0, worldX, worldY, height);
      for (let dy = 0; dy < TILE_PX; dy++) {
        for (let dx = 0; dx < TILE_PX; dx++) {
          const px = cellX * TILE_PX + dx;
          const py = cellY * TILE_PX + dy;
          let rgb = color;
          if (px === 0 || py === 0) rgb = CHUNK_EDGE;
          if (worldY === equator && py === cellY * TILE_PX) rgb = EQUATOR;
          if (layer.column === 0 && px < 2) rgb = SEAM;
          const offset = (py * CHUNK_PX + px) * 4;
          pixels[offset] = rgb[0];
          pixels[offset + 1] = rgb[1];
          pixels[offset + 2] = rgb[2];
          pixels[offset + 3] = 255;
        }
      }
    }
  }
  return pixels;
}
