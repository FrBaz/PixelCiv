/**
 * Encodeur PNG des tests des décodeurs (tools/png.test.ts, tools/wave-control/png.test.ts) :
 * des images de 8 bits par canal, chaque ligne filtrée par le filtre qu'on lui donne, pour
 * vérifier que le décodeur défait chacun ; l'en-tête se règle pour fabriquer des formats que le
 * décodeur refuse.
 */
import { deflateSync } from 'node:zlib';

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
export function encodePng(
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
