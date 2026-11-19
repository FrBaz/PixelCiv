import { describe, expect, it } from 'vitest';
import { PAGE, ShelfPacker, TexturePages } from './pages';

describe('atlas dynamique des textures recolorées (ADR 0014)', () => {
  it('range les motifs en étagères, sans recouvrement, avec un pixel de marge', () => {
    const packer = new ShelfPacker(24);
    const placed: [number, number, number, number][] = [];
    for (const [width, height] of [
      [6, 9],
      [6, 10],
      [4, 6],
      [7, 8],
      [6, 9],
      [4, 7],
    ] as const) {
      const at = packer.place(width, height);
      if (at === undefined) throw new Error('page pleine trop tôt');
      placed.push([at.x, at.y, width, height]);
    }
    for (const [index, [x, y, w, h]] of placed.entries()) {
      expect(x + w).toBeLessThanOrEqual(24);
      expect(y + h).toBeLessThanOrEqual(24);
      for (const [ox, oy, ow, oh] of placed.slice(index + 1)) {
        // Un pixel de marge entre deux motifs : aucun ne touche son voisin.
        const apart = x + w + 1 <= ox || ox + ow + 1 <= x || y + h + 1 <= oy || oy + oh + 1 <= y;
        expect(apart).toBe(true);
      }
    }
    // La page pleine le dit ; un motif plus grand qu'elle est refusé.
    expect(packer.place(24, 24)).toBeUndefined();
    expect(() => new ShelfPacker(8).place(9, 2)).toThrow(RangeError);
  });

  it('découpe chaque motif dans une page partagée, et en ouvre une autre quand elle est pleine', () => {
    const pages = new TexturePages(8);
    const rgba = (width: number, height: number, value: number) =>
      new Uint8ClampedArray(width * height * 4).fill(value);
    const first = pages.add(rgba(3, 3, 10), 3, 3);
    const second = pages.add(rgba(3, 3, 20), 3, 3);
    expect(pages.count).toBe(1);
    // Deux textures, une seule source : elles se dessinent dans le même lot.
    expect(first.source).toBe(second.source);
    expect([first.frame.x, first.frame.y, first.frame.width]).toEqual([0, 0, 3]);
    expect([second.frame.x, second.frame.y]).toEqual([4, 0]);
    // Les pixels sont rangés à leur place, rangée par rangée.
    const resource = first.source.resource as Uint8ClampedArray;
    expect(resource[(1 * 8 + 1) * 4]).toBe(10);
    expect(resource[(2 * 8 + 5) * 4]).toBe(20);
    expect(resource[(0 * 8 + 3) * 4]).toBe(0);
    pages.add(rgba(3, 3, 30), 3, 3);
    const fourth = pages.add(rgba(6, 6, 40), 6, 6);
    expect(pages.count).toBe(2);
    expect(fourth.source).not.toBe(first.source);
    expect(pages.sources).toHaveLength(2);
    pages.flush();
    pages.destroy();
    expect(pages.count).toBe(0);
    expect(PAGE).toBe(256);
  });
});
