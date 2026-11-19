import { describe, expect, it } from 'vitest';
import { encodePng as encode } from '../png-encode';
import { decodePng } from './png';

/** Des pixels variés, dont des octets extrêmes, sur `height` lignes de `width` pixels. */
const sample = (width: number, height: number, channels: number) =>
  Array.from({ length: height }, (_, y) =>
    Array.from({ length: width * channels }, (_, i) => (37 * i + 101 * y + (i % 7) * 40) % 256),
  );

describe('décodeur PNG du contrôle des pixels (ADR 0015)', () => {
  it('rend les octets RGB de chaque pixel, sous chacun des cinq filtres', () => {
    for (const channels of [3, 4] as const) {
      const pixels = sample(5, 6, channels);
      for (const filters of [[0], [1], [2], [3], [4], [0, 1, 2, 3, 4, 2]]) {
        const image = decodePng(encode(5, pixels, channels, filters));
        expect([image.width, image.height]).toEqual([5, 6]);
        const expected = pixels.flatMap((line) =>
          line.filter((_, i) => channels === 3 || i % 4 !== 3),
        );
        expect(Array.from(image.rgb)).toEqual(expected);
      }
    }
  });

  it('refuse ce qu’il ne sait pas lire', () => {
    const pixels = sample(2, 2, 3);
    expect(() => decodePng(Uint8Array.from([1, 2, 3]))).toThrow(/pas un fichier PNG/);
    expect(() => decodePng(encode(2, pixels, 3, [0], { depth: 16 }))).toThrow(/8 bits/);
    expect(() => decodePng(encode(2, pixels, 3, [0], { color: 3 }))).toThrow(/RGB/);
    expect(() => decodePng(encode(2, pixels, 3, [0], { interlace: 1 }))).toThrow(/entrelacé/);
    expect(() => decodePng(encode(2, pixels, 3, [5]))).toThrow(/filtre PNG inconnu : 5/);
  });
});
