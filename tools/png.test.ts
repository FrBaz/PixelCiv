import { describe, expect, it } from 'vitest';
import { decodeRgba } from './png';
import { encodePng } from './png-encode';

/** Des pixels variés, dont des octets extrêmes et des alphas de 0 à 255. */
const sample = (width: number, height: number, channels: number) =>
  Array.from({ length: height }, (_, y) =>
    Array.from({ length: width * channels }, (_, i) => (53 * i + 89 * y + (i % 5) * 61) % 256),
  );

describe('décodeur PNG des outils (ADR 0015, ADR 0016)', () => {
  it('rend les octets RGBA de chaque pixel, sous chacun des cinq filtres', () => {
    const pixels = sample(7, 5, 4);
    for (const filters of [[0], [1], [2], [3], [4], [4, 3, 2, 1, 0]]) {
      const image = decodeRgba(encodePng(7, pixels, 4, filters));
      expect([image.width, image.height]).toEqual([7, 5]);
      expect(Array.from(image.rgba)).toEqual(pixels.flat());
    }
  });

  it('rend une image sans alpha avec l’alpha plein', () => {
    const pixels = sample(4, 3, 3);
    const image = decodeRgba(encodePng(4, pixels, 3, [0, 1, 4]));
    const expected = pixels.flatMap((line) =>
      Array.from({ length: 4 }, (_, x) => [...line.slice(x * 3, x * 3 + 3), 255]).flat(),
    );
    expect(Array.from(image.rgba)).toEqual(expected);
  });

  it('refuse ce qu’il ne sait pas lire : entrelacé, 16 bits, palette, filtre inconnu, pas un PNG', () => {
    const pixels = sample(2, 2, 4);
    expect(() => decodeRgba(Uint8Array.from([1, 2, 3]))).toThrow(/pas un fichier PNG/);
    expect(() => decodeRgba(encodePng(2, pixels, 4, [0], { interlace: 1 }))).toThrow(/entrelacé/);
    expect(() => decodeRgba(encodePng(2, pixels, 4, [0], { depth: 16 }))).toThrow(/8 bits/);
    expect(() => decodeRgba(encodePng(2, pixels, 4, [0], { color: 3 }))).toThrow(/RGBA/);
    expect(() => decodeRgba(encodePng(2, pixels, 4, [6]))).toThrow(/filtre PNG inconnu : 6/);
  });
});
