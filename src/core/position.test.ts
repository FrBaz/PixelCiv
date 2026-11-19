import { describe, expect, it } from 'vitest';
import {
  carriedSide,
  cellOf,
  deltaFixedX,
  FIXED,
  fromFixed,
  legAt,
  toFixed,
  wrapFixedX,
} from './position';

describe('positions en virgule fixe (ADR 0014)', () => {
  const width = 512;
  const span = width * FIXED;

  it('compte en 1/65 536 de case, et revient aux cases', () => {
    expect(FIXED).toBe(65_536);
    expect(toFixed(2.37)).toBe(Math.round(2.37 * 65_536));
    expect(fromFixed(toFixed(1.68))).toBeCloseTo(1.68, 4);
    expect(toFixed(0.5)).toBe(32_768);
  });

  it('ramène une abscisse dans le monde, à travers la couture, sans jamais sortir', () => {
    expect(wrapFixedX(-1, width)).toBe(span - 1);
    expect(wrapFixedX(span, width)).toBe(0);
    expect(wrapFixedX(span + 5, width)).toBe(5);
    expect(wrapFixedX(-span - 3, width)).toBe(span - 3);
    for (const x of [-3 * span + 7, -1, 0, 1, span - 1, span, 5 * span + 11]) {
      const wrapped = wrapFixedX(x, width);
      expect(wrapped).toBeGreaterThanOrEqual(0);
      expect(wrapped).toBeLessThan(span);
      expect(Number.isInteger(wrapped)).toBe(true);
    }
  });

  it('prend tout écart horizontal au plus court, à travers la couture', () => {
    expect(deltaFixedX(toFixed(511.75), toFixed(0.25), width)).toBe(toFixed(0.5));
    expect(deltaFixedX(toFixed(0.25), toFixed(511.75), width)).toBe(-toFixed(0.5));
    expect(deltaFixedX(toFixed(10), toFixed(20), width)).toBe(toFixed(10));
    // Dans [−largeur / 2, largeur / 2[.
    expect(deltaFixedX(0, span / 2, width)).toBe(-span / 2);
    expect(deltaFixedX(span / 2, 0, width)).toBe(-span / 2);
    for (let from = 0; from < span; from += Math.floor(span / 7)) {
      for (let to = 0; to < span; to += Math.floor(span / 11)) {
        const delta = deltaFixedX(from, to, width);
        expect(delta).toBeGreaterThanOrEqual(-span / 2);
        expect(delta).toBeLessThan(span / 2);
        expect(wrapFixedX(from + delta, width)).toBe(wrapFixedX(to, width));
      }
    }
  });

  it('trouve la case d’une position : [i, i + 1[ × [j, j + 1[', () => {
    expect(cellOf(toFixed(2.37), toFixed(1.68), width)).toBe(1 * width + 2);
    expect(cellOf(toFixed(3), toFixed(1), width)).toBe(width + 3);
    expect(cellOf(toFixed(3) - 1, toFixed(1) - 1, width)).toBe(2);
    expect(cellOf(span - 1, 0, width)).toBe(width - 1);
  });

  it('donne aux jours entiers les entiers exacts d’une étape, et les interpole entre deux', () => {
    const start = toFixed(511.5);
    const step = toFixed(0.4) + 3;
    // Le worker ajoute le pas chaque jour, en ramenant l'abscisse dans le monde.
    let x = start;
    for (let day = 0; day <= 7; day++) {
      expect(wrapFixedX(legAt(start, step, 7, day), width)).toBe(x);
      x = wrapFixedX(x + step, width);
    }
    // Bornée au départ et à la fin de l'étape.
    expect(legAt(start, step, 7, -2)).toBe(start);
    expect(legAt(start, step, 7, 12)).toBe(start + 7 * step);
    // Entre deux jours, sur le segment du jour.
    expect(legAt(start, step, 7, 2.5)).toBe(start + 2.5 * step);
  });

  it('porte un nourrisson du côté que dit son identifiant, le même à chaque fois', () => {
    const sides = Array.from({ length: 1000 }, (_, id) => carriedSide(id + 1));
    expect(new Set(sides)).toEqual(new Set([1, -1]));
    const east = sides.filter((side) => side === 1).length;
    expect(east).toBeGreaterThan(400);
    expect(east).toBeLessThan(600);
    expect(carriedSide(4242)).toBe(carriedSide(4242));
  });
});
