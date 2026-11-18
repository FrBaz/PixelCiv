import { describe, expect, it } from 'vitest';
import { DAYS_PER_MONTH } from './time';
import { walkArrival, walking, walkPosition, walkTotal, type WalkData } from './walk';

/** Marches d'un monde de `width` colonnes : pour chacune, son groupe, ses cases (x, y), ses coûts et son budget. */
function walks(
  width: number,
  ...list: { group: number; path: [number, number][]; costs: number[]; budget: number }[]
): WalkData {
  const ends: number[] = [];
  let length = 0;
  for (const entry of list) {
    length += entry.path.length;
    ends.push(length);
  }
  return {
    groups: Uint32Array.from(list.map((entry) => entry.group)),
    ends: Uint32Array.from(ends),
    cells: Uint32Array.from(list.flatMap((entry) => entry.path.map(([x, y]) => y * width + x))),
    costs: Float64Array.from(list.flatMap((entry) => entry.costs)),
    budgets: Float64Array.from(list.map((entry) => entry.budget)),
  };
}

function at(data: WalkData, index: number, k: number, width: number): [number, number] {
  const out = [0, 0];
  walkPosition(data, index, k, width, out);
  return [out[0] ?? 0, out[1] ?? 0];
}

describe('marche jour après jour (ADR 0013)', () => {
  it('avance à allure constante, un trentième du budget par jour, de centre en centre', () => {
    // Six cases de plaine en ligne droite, d'un coût de 1, et un budget de 30 : une case par
    // jour, puis le camp au bout du chemin.
    const path: [number, number][] = [0, 1, 2, 3, 4, 5].map((step) => [10 + step, 7]);
    const data = walks(64, { group: 4, path, costs: [0, 1, 2, 3, 4, 5], budget: 30 });
    for (let k = 0; k <= 5; k += 0.25) {
      expect(at(data, 0, k, 64)).toEqual([10.5 + k, 7.5]);
    }
    // Le budget double : deux cases par jour.
    const fast = walks(64, { group: 4, path, costs: [0, 1, 2, 3, 4, 5], budget: 60 });
    expect(at(fast, 0, 1.5, 64)).toEqual([13.5, 7.5]);
    // Une diagonale coûte √2 fois la case où l'on entre : la marche y passe plus de temps.
    const diagonal = walks(64, {
      group: 1,
      path: [
        [3, 3],
        [4, 4],
        [5, 4],
      ],
      costs: [0, Math.SQRT2, Math.SQRT2 + 1],
      budget: 30,
    });
    const [x, y] = at(diagonal, 0, 1, 64);
    expect(x).toBeCloseTo(3.5 + 1 / Math.SQRT2, 12);
    expect(y).toBeCloseTo(3.5 + 1 / Math.SQRT2, 12);
    const [cornerX, cornerY] = at(diagonal, 0, Math.SQRT2, 64);
    expect(cornerX).toBeCloseTo(4.5, 12);
    expect(cornerY).toBeCloseTo(4.5, 12);
  });

  it('arrive au plus tard le trentième jour, puis campe au centre de sa case', () => {
    const path: [number, number][] = [
      [2, 2],
      [3, 2],
      [4, 2],
    ];
    // Un chemin qui coûte tout le budget : l'arrivée tombe le trentième jour, pas avant.
    const full = walks(16, { group: 2, path, costs: [0, 15, 30], budget: 30 });
    expect(walkTotal(full, 0)).toBe(30);
    expect(walkArrival(full, 0)).toBe(DAYS_PER_MONTH);
    expect(walking(full, 0, 29.9)).toBe(true);
    expect(walking(full, 0, 30)).toBe(false);
    expect(at(full, 0, 30, 16)).toEqual([4.5, 2.5]);
    // Un chemin plus court : l'arrivée, puis le repos, au centre de la dernière case.
    const short = walks(16, { group: 2, path, costs: [0, 2, 4], budget: 30 });
    expect(walkArrival(short, 0)).toBe(4);
    expect(walking(short, 0, 3.99)).toBe(true);
    for (const k of [4, 4.5, 12, 29, 30, 31, 1000]) {
      expect(walking(short, 0, k)).toBe(false);
      expect(at(short, 0, k, 16)).toEqual([4.5, 2.5]);
    }
    // Avant le départ, au centre de la case de départ.
    for (const k of [0, -1]) expect(at(short, 0, k, 16)).toEqual([2.5, 2.5]);
    // Chaque marche a son budget et son chemin, l'une après l'autre dans les tableaux.
    const both = walks(
      16,
      {
        group: 1,
        path: [
          [0, 0],
          [1, 0],
        ],
        costs: [0, 1],
        budget: 30,
      },
      { group: 2, path, costs: [0, 2, 4], budget: 15 },
    );
    expect(at(both, 0, 0.5, 16)).toEqual([1, 0.5]);
    expect(at(both, 1, 4, 16)).toEqual([3.5, 2.5]);
    expect(walkArrival(both, 0)).toBe(1);
    expect(walkArrival(both, 1)).toBe(8);
  });

  it('passe la couture au plus court, sans quitter le monde', () => {
    const width = 8;
    // D'ouest en est : de la dernière colonne à la première, puis la suivante.
    const east = walks(width, {
      group: 9,
      path: [
        [7, 2],
        [0, 2],
        [1, 3],
      ],
      costs: [0, 1, 1 + Math.SQRT2],
      budget: 30,
    });
    // Et d'est en ouest.
    const west = walks(width, {
      group: 9,
      path: [
        [0, 5],
        [7, 5],
        [6, 5],
      ],
      costs: [0, 1, 2],
      budget: 30,
    });
    for (const [data, direction] of [
      [east, 1],
      [west, -1],
    ] as const) {
      let [previousX] = at(data, 0, 0, width);
      for (let k = 0.05; k <= 2.5; k += 0.05) {
        const [x] = at(data, 0, k, width);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(width);
        // Au plus court : un petit pas dans le sens de la marche, jamais le tour du monde.
        let dx = x - previousX;
        if (dx > width / 2) dx -= width;
        if (dx < -width / 2) dx += width;
        expect(Math.sign(dx) === direction || dx === 0).toBe(true);
        expect(Math.abs(dx)).toBeLessThanOrEqual(0.05 + 1e-9);
        previousX = x;
      }
    }
    expect(at(east, 0, 0.4, width)[0]).toBeCloseTo(7.9, 12);
    expect(at(east, 0, 0.5, width)[0]).toBe(0);
    expect(at(east, 0, 0.8, width)[0]).toBeCloseTo(0.3, 12);
    expect(at(west, 0, 0.7, width)[0]).toBeCloseTo(7.8, 12);
  });
});
