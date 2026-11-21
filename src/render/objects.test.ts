import { describe, expect, it } from 'vitest';
import { CHUNK_PX } from './bake';
import { visibleChunks, type Camera } from './camera';
import { mapOrigin, ObjectList, PALETTE_KEYS } from './objects';

describe('liste des objets du calque commun (ADR 0017, § 7)', () => {
  it('range ses objets par leurs pieds, puis par ordre d’ajout, et grandit sans rien perdre', () => {
    const list = new ObjectList();
    // Plus d'objets que la place de départ, aux pieds mêlés, et beaucoup d'égalités.
    const feet = Array.from({ length: 700 }, (_, index) => ((index * 37) % 23) - 11);
    feet.forEach((value, index) => {
      list.push(index, 100 - index, value, 3, 4, index % 5, index % 7, 2, index % 2);
    });
    list.sort();
    expect(list.count).toBe(feet.length);
    const order = Array.from(list.order.subarray(0, list.count));
    const expected = feet
      .map((value, index) => ({ value, index }))
      .sort((a, b) => a.value - b.value || a.index - b.index)
      .map(({ index }) => index);
    expect(order).toEqual(expected);
    // Chaque colonne a gardé ce que l'ajout y a mis.
    for (const index of [0, 255, 256, 699]) {
      expect([
        list.left[index],
        list.top[index],
        list.feet[index],
        list.width[index],
        list.height[index],
        list.motif[index],
        list.slot[index],
        list.unit[index],
        list.flags[index],
      ]).toEqual([index, 100 - index, feet[index], 3, 4, index % 5, index % 7, 2, index % 2]);
    }
    // Vidée, elle se remplit de nouveau depuis le premier rang.
    list.clear();
    expect(list.push(5, 5, 5, 1, 1, 0, 0, 1)).toBe(0);
  });

  it('range des pieds négatifs et lointains, à leur rang exact', () => {
    const list = new ObjectList();
    for (const value of [2 ** 20, -(2 ** 20), 0, -1, 1, 2 ** 20 - 1]) {
      list.push(0, 0, value, 1, 1, 0, 0, 1);
    }
    list.sort();
    expect(Array.from(list.order.subarray(0, list.count))).toEqual([1, 3, 2, 4, 5, 0]);
  });

  it('pose l’origine de la carte là où camera.ts pose ses blocs, au pixel près', () => {
    const viewport = { width: 1280, height: 721 };
    const grid = { columns: 8, rows: 4 };
    for (const camera of [
      { x: 100.3, y: 50.7, zoom: 3 },
      { x: -17.25, y: 300.5, zoom: 8 },
      { x: 2047.9, y: 1.1, zoom: 24 },
    ] satisfies Camera[]) {
      const origin = mapOrigin(camera, viewport);
      for (const chunk of visibleChunks(camera, viewport, grid, CHUNK_PX)) {
        // Le bloc de la colonne visible i a son bord gauche à i blocs de l'origine.
        const column = Math.round((chunk.left - origin.x) / (CHUNK_PX * Math.round(camera.zoom)));
        expect(chunk.left).toBe(origin.x + column * CHUNK_PX * Math.round(camera.zoom));
        expect(chunk.top).toBe(origin.y + chunk.row * CHUNK_PX * Math.round(camera.zoom));
      }
    }
  });

  it('donne à chaque source des clés de palettes à part', () => {
    const ranges = Object.values(PALETTE_KEYS).toSorted((a, b) => a[0] - b[0]);
    for (const [index, [low, high]] of ranges.entries()) {
      expect(low).toBeLessThan(high);
      const next = ranges.at(index + 1);
      if (next !== undefined) expect(high).toBeLessThanOrEqual(next[0]);
    }
    // Les apparences des humains tiennent sous la première clé du décor.
    expect(PALETTE_KEYS.humans[1]).toBeLessThanOrEqual(PALETTE_KEYS.decor[0]);
  });
});
