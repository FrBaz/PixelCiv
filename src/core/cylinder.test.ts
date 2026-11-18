import { describe, expect, it } from 'vitest';
import { deltaX, distance, wrapNearX, wrapX } from './cylinder';
import { CHUNK_SIZE, chunkGrid, WORLD_SIZES } from './world';

describe('wrapX', () => {
  it('ramène toute coordonnée dans [0, largeur)', () => {
    expect(wrapX(0, 512)).toBe(0);
    expect(wrapX(511, 512)).toBe(511);
    expect(wrapX(512, 512)).toBe(0);
    expect(wrapX(-1, 512)).toBe(511);
    expect(wrapX(-512, 512)).toBe(0);
    expect(wrapX(-1537, 512)).toBe(511);
    expect(wrapX(1030.5, 512)).toBe(6.5);
  });

  it('ne renvoie jamais -0', () => {
    expect(Object.is(wrapX(-0, 512), 0)).toBe(true);
    expect(Object.is(wrapX(-512, 512), 0)).toBe(true);
  });

  it('rend inchangée une valeur déjà dans le monde, et reste idempotente', () => {
    for (const x of [0.1, 6.5, 511.75, 1e-300]) {
      expect(wrapX(x, 512)).toBe(x);
      expect(wrapX(wrapX(-x, 512), 512)).toBe(wrapX(-x, 512));
    }
  });

  it('donne NaN pour une coordonnée non finie, au lieu de la colonne 0', () => {
    expect(wrapX(Number.NaN, 512)).toBeNaN();
    expect(wrapX(Number.POSITIVE_INFINITY, 512)).toBeNaN();
    expect(wrapX(Number.NEGATIVE_INFINITY, 512)).toBeNaN();
    expect(deltaX(Number.NaN, 0, 512)).toBeNaN();
  });

  it('reste sous la largeur pour un reste négatif infime', () => {
    expect(wrapX(-1e-14, 512)).toBe(0);
    expect(wrapX(-Number.MIN_VALUE, 512)).toBe(0);
    expect(wrapX(-1e-14, 512)).toBeLessThan(512);
  });
});

describe('wrapNearX', () => {
  it('donne le même résultat que wrapX à moins d’une largeur du monde (F-11)', () => {
    for (const width of [512, 768, 7]) {
      for (let x = -width; x < 2 * width; x++) {
        expect(wrapNearX(x, width)).toBe(wrapX(x, width));
      }
    }
  });
});

describe('deltaX', () => {
  it('prend le plus court chemin, à travers la couture', () => {
    expect(deltaX(10, 20, 512)).toBe(10);
    expect(deltaX(20, 10, 512)).toBe(-10);
    expect(deltaX(510, 2, 512)).toBe(4);
    expect(deltaX(2, 510, 512)).toBe(-4);
  });

  it('reste dans [-largeur/2, largeur/2)', () => {
    expect(deltaX(0, 256, 512)).toBe(-256);
    expect(deltaX(0, 255, 512)).toBe(255);
  });
});

describe('distance', () => {
  it('passe par la couture quand elle est plus courte', () => {
    expect(distance(511, 0, 1, 0, 512)).toBe(2);
    expect(distance(0, 0, 3, 4, 512)).toBe(5);
  });
});

describe('tailles du monde', () => {
  it('sont au format 2:1 et découpées en blocs entiers', () => {
    for (const size of Object.values(WORLD_SIZES)) {
      expect(size.width).toBe(size.height * 2);
      expect(size.width % CHUNK_SIZE).toBe(0);
      expect(size.height % CHUNK_SIZE).toBe(0);
    }
    expect(chunkGrid(WORLD_SIZES.small)).toEqual({ columns: 8, rows: 4 });
  });
});
