import { describe, expect, it } from 'vitest';
import { enlarge, PORTRAIT_CSS_PIXEL, portraitScale } from './portraitCanvas';

/** Densités courantes : PC à 100, 125, 150 et 175 %, téléphones, zoom du navigateur. */
const DENSITIES = [0.5, 0.8, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.25, 2.625, 2.75, 3, 3.5, 4];

describe('portrait à l’écran (tâche 2.8, A-3, U-10)', () => {
  it('compte un nombre entier de pixels physiques par pixel du portrait, à toute densité', () => {
    for (const density of DENSITIES) {
      const { factor, side, css } = portraitScale(density, 64);
      expect(Number.isInteger(factor) && factor >= 1, String(density)).toBe(true);
      expect(side).toBe(64 * factor);
      // Le canevas couvre tout juste `side` pixels physiques : la mise en page, au 1/64 de
      // pixel près, en tronquant comme en arrondissant, retombe sur ce nombre entier.
      expect(css * density - side, String(density)).toBeGreaterThan(0);
      expect(css * density - side, String(density)).toBeLessThan(1 / 128);
      // Au plus PORTRAIT_CSS_PIXEL pixels CSS par pixel : le portrait garde sa place.
      expect(css).toBeLessThanOrEqual(64 * PORTRAIT_CSS_PIXEL + 0.01);
      expect(factor).toBeLessThanOrEqual(PORTRAIT_CSS_PIXEL * density + 1e-9);
      expect(factor).toBeGreaterThan(PORTRAIT_CSS_PIXEL * density - 1);
    }
    expect(portraitScale(1, 64)).toMatchObject({ factor: 2, side: 128 });
    expect(portraitScale(1.25, 64)).toMatchObject({ factor: 2, side: 128 });
    expect(portraitScale(1.5, 64)).toMatchObject({ factor: 3, side: 192 });
    expect(portraitScale(2.75, 64)).toMatchObject({ factor: 5, side: 320 });
    expect(portraitScale(3, 64)).toMatchObject({ factor: 6, side: 384 });
  });

  it('agrandit chaque pixel en un carré de même taille, au centre, sur le fond', () => {
    // Image de 2 × 2 : rouge, transparent, vert, bleu.
    const image = [255, 0, 0, 255, 0, 0, 0, 0, 0, 255, 0, 255, 0, 0, 255, 255];
    const backdrop = [9, 9, 9] as const;
    const width = 7;
    const height = 6;
    const pixels = enlarge(image, 2, 3, width, height, backdrop);
    expect(pixels).toHaveLength(width * height * 4);
    const at = (x: number, y: number) =>
      Array.from(pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4));
    // Des carrés de 3 × 3 ; la toile a une colonne de plus que l'image, laissée au fond.
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) expect(at(x, y)).toEqual([255, 0, 0, 255]);
      // Le pixel transparent prend le fond.
      for (let x = 3; x < 6; x++) expect(at(x, y)).toEqual([9, 9, 9, 255]);
    }
    for (let y = 3; y < 6; y++) {
      for (let x = 0; x < 3; x++) expect(at(x, y)).toEqual([0, 255, 0, 255]);
      for (let x = 3; x < 6; x++) expect(at(x, y)).toEqual([0, 0, 255, 255]);
    }
    for (let y = 0; y < height; y++) expect(at(6, y)).toEqual([9, 9, 9, 255]);
    // Une toile trop petite réduit l'agrandissement : 2 × 2 agrandi 2 fois sur 4 × 5.
    const small = enlarge(image, 2, 3, 4, 5, backdrop);
    const pixel = (x: number, y: number) =>
      Array.from(small.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4));
    expect(pixel(1, 1)).toEqual([255, 0, 0, 255]);
    expect(pixel(2, 0)).toEqual([9, 9, 9, 255]);
    expect(pixel(1, 2)).toEqual([0, 255, 0, 255]);
    expect(pixel(3, 3)).toEqual([0, 0, 255, 255]);
    expect(pixel(0, 4)).toEqual([9, 9, 9, 255]);
  });

  it('donne à chaque pixel du portrait le même nombre de pixels physiques', () => {
    // Un damier de 64 × 64, agrandi pour chaque densité dans l'emplacement qu'elle donne :
    // toutes les cases d'une rangée ont la même longueur.
    const checker = new Uint8ClampedArray(64 * 64 * 4);
    for (let index = 0; index < 64 * 64; index++) {
      const value = ((index % 64) + Math.floor(index / 64)) % 2 === 0 ? 0 : 255;
      checker.set([value, value, value, 255], index * 4);
    }
    for (const density of DENSITIES) {
      const { factor, side } = portraitScale(density, 64);
      const pixels = enlarge(checker, 64, factor, side, side, [128, 128, 128]);
      const row = Math.floor(side / 2);
      // Longueurs des cases noires et blanches de la rangée, le fond mis à part.
      const runs: number[] = [];
      let length = 0;
      let previous = -1;
      for (let x = 0; x <= side; x++) {
        const value = x < side ? (pixels[(row * side + x) * 4] ?? 0) : -1;
        if (value === previous) length++;
        else {
          if (previous === 0 || previous === 255) runs.push(length);
          previous = value;
          length = 1;
        }
      }
      expect(runs.length, String(density)).toBe(64);
      expect(new Set(runs), String(density)).toEqual(new Set([factor]));
    }
  });
});
