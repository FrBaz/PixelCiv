import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE } from '../core/world';
import { TILE_PX } from './camera';
import { bakeTestChunk, CHUNK_PX } from './testGrid';

const grid = { columns: 8, rows: 4 };

function chunk(column: number, row: number, paint: [number, number, number][] = []) {
  const cells = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
  for (const [x, y, value] of paint) cells[y * CHUNK_SIZE + x] = value;
  return { column, row, cells };
}

function pixel(pixels: Uint8Array, x: number, y: number): number[] {
  const offset = (y * CHUNK_PX + x) * 4;
  return Array.from(pixels.subarray(offset, offset + 4));
}

describe('bakeTestChunk', () => {
  it('donne un bloc opaque de 256 × 256 pixels', () => {
    const pixels = bakeTestChunk(chunk(3, 1), grid);
    expect(pixels.length).toBe(CHUNK_PX * CHUNK_PX * 4);
    expect(pixels.filter((_, index) => index % 4 === 3).every((alpha) => alpha === 255)).toBe(true);
  });

  it('marque la couture sur le bord ouest de la colonne 0 seulement', () => {
    const seam = pixel(bakeTestChunk(chunk(0, 1), grid), 1, 10);
    const other = pixel(bakeTestChunk(chunk(1, 1), grid), 1, 10);
    expect(seam).toEqual([196, 48, 36, 255]);
    expect(other).not.toEqual(seam);
  });

  it('peint les cases de la couche, sur TILE_PX × TILE_PX pixels', () => {
    const pixels = bakeTestChunk(chunk(2, 1, [[10, 20, 4]]), grid);
    for (let dy = 1; dy < TILE_PX; dy++) {
      for (let dx = 1; dx < TILE_PX; dx++) {
        expect(pixel(pixels, 10 * TILE_PX + dx, 20 * TILE_PX + dy)).toEqual([120, 190, 110, 255]);
      }
    }
  });

  it("trace l'équateur", () => {
    // Monde de 4 rangées de blocs : l'équateur est la première ligne de la rangée 2.
    expect(pixel(bakeTestChunk(chunk(3, 2), grid), 9, 0)).toEqual([192, 154, 69, 255]);
  });
});
