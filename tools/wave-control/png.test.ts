import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePng } from './png';

/** Le prédicteur de Paeth, tel que la norme PNG l'écrit. */
function paeth(left: number, up: number, corner: number): number {
  const estimate = left + up - corner;
  const [a, b, c] = [left, up, corner].map((value) => Math.abs(estimate - value)) as [
    number,
    number,
    number,
  ];
  return a <= b && a <= c ? left : b <= c ? up : corner;
}

/** Un fichier PNG de `width` pixels de large, une ligne par entrée de `pixels`, filtrée. */
function encode(
  width: number,
  pixels: readonly number[][],
  channels: 3 | 4,
  filters: readonly number[],
  header: { depth?: number; color?: number; interlace?: number } = {},
): Uint8Array {
  const stride = width * channels;
  const lines = pixels.map((line) => Uint8Array.from(line));
  const raw: number[] = [];
  lines.forEach((line, y) => {
    const filter = filters[y % filters.length] ?? 0;
    raw.push(filter);
    const above = lines[y - 1] ?? new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? (line[i - channels] ?? 0) : 0;
      const up = above[i] ?? 0;
      const corner = i >= channels ? (above[i - channels] ?? 0) : 0;
      const predicted =
        [0, left, up, Math.floor((left + up) / 2), paeth(left, up, corner)][filter] ?? 0;
      raw.push(((line[i] ?? 0) - predicted + 256) & 255);
    }
  });
  const chunk = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length);
    new DataView(out.buffer).setUint32(0, body.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(body, 8);
    // Le décodeur ne vérifie pas les sommes de contrôle : celles-ci restent nulles.
    return out;
  };
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, pixels.length);
  ihdr.set(
    [header.depth ?? 8, header.color ?? (channels === 3 ? 2 : 6), 0, 0, header.interlace ?? 0],
    8,
  );
  const parts = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Uint8Array.from(raw))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const file = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    file.set(part, offset);
    offset += part.length;
  }
  return file;
}

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
