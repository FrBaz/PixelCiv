import { describe, expect, it } from 'vitest';
import { previewPixels } from './preview';

const colors = [
  [20, 40, 120],
  [100, 160, 60],
] as const;

function pixel(pixels: Uint8ClampedArray, width: number, x: number, y: number): number[] {
  const offset = (y * width + x) * 4;
  return Array.from(pixels.subarray(offset, offset + 4));
}

describe("aperçu de l'écran de création", () => {
  it('peint chaque case de la couleur de son biome, sans ombre sur le plat ni sur la mer', () => {
    const size = { width: 4, height: 2 };
    const biome = new Uint8Array([0, 0, 1, 1, 0, 0, 1, 1]);
    const elevation = new Int16Array([-300, -300, 200, 200, -300, -300, 200, 200]);
    const pixels = previewPixels(size, biome, elevation, colors);
    expect(pixels).toHaveLength(4 * 2 * 4);
    expect(pixel(pixels, 4, 0, 0)).toEqual([20, 40, 120, 255]);
    // Une case de mer voisine d'une terre reste plate : seules les terres sont ombrées.
    expect(pixel(pixels, 4, 1, 1)).toEqual([20, 40, 120, 255]);
  });

  it('éclaire les pentes tournées vers le nord-est, assombrit les autres', () => {
    const size = { width: 6, height: 3 };
    const biome = new Uint8Array(18).fill(1);
    // Une crête nord-sud au milieu : la pente est (x = 3) descend vers l'est, éclairée.
    const elevation = new Int16Array([
      100, 600, 1500, 600, 100, 50, 100, 600, 1500, 600, 100, 50, 100, 600, 1500, 600, 100, 50,
    ]);
    const pixels = previewPixels(size, biome, elevation, colors);
    const east = pixel(pixels, 6, 3, 1);
    const west = pixel(pixels, 6, 1, 1);
    expect(east[1]).toBeGreaterThan(160);
    expect(west[1]).toBeLessThan(160);
    expect(east[3]).toBe(255);
  });

  it('boucle à la couture : la colonne 0 voit la dernière comme voisine', () => {
    const size = { width: 4, height: 1 };
    const biome = new Uint8Array(4).fill(1);
    const rising = previewPixels(size, biome, new Int16Array([800, 400, 400, 1600]), colors);
    const flat = previewPixels(size, biome, new Int16Array([800, 400, 400, 400]), colors);
    // À l'ouest de la colonne 0 se dresse la colonne 3 : sa pente change avec elle.
    expect(pixel(rising, 4, 0, 0)).not.toEqual(pixel(flat, 4, 0, 0));
  });
});
