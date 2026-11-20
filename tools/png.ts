/**
 * Décodeur PNG minimal des outils (ADR 0015, ADR 0016) : images de 8 bits par canal, en RGB ou en
 * RGBA, non entrelacées, comme celles que Chromium capture et comme les planches de sprites/.
 * Il rend les pixels en RGBA, quatre octets par pixel, ligne par ligne, sans aucune conversion
 * de couleur : les octets mêmes du fichier, l'alpha à 255 pour une image sans alpha.
 */
import { inflateSync } from 'node:zlib';

/** Une image en RGBA : quatre octets par pixel, ligne par ligne. */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Le prédicteur de Paeth du filtre 4. */
function paeth(left: number, up: number, corner: number): number {
  const estimate = left + up - corner;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toCorner = Math.abs(estimate - corner);
  if (toLeft <= toUp && toLeft <= toCorner) return left;
  return toUp <= toCorner ? up : corner;
}

/** Décode le fichier PNG `file` ; lève une erreur sur un format que les outils ne lisent pas. */
export function decodeRgba(file: Uint8Array): RgbaImage {
  if (SIGNATURE.some((byte, index) => file[index] !== byte)) throw new Error('pas un fichier PNG');
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Uint8Array[] = [];
  for (let offset = SIGNATURE.length; offset + 8 <= file.length;) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...file.subarray(offset + 4, offset + 8));
    const body = file.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      const [depth, color, , , interlace] = body.subarray(8, 13);
      if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6)) {
        throw new Error('PNG non lu : 8 bits par canal, RGB ou RGBA, non entrelacé seulement');
      }
      channels = color === 2 ? 3 : 4;
    } else if (type === 'IDAT') {
      data.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (channels === 0) throw new Error('PNG sans en-tête');
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error('PNG tronqué');
  const rgba = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const filter = raw[start];
    const current = new Uint8Array(stride);
    for (let index = 0; index < stride; index++) {
      const left = index >= channels ? (current[index - channels] ?? 0) : 0;
      const up = previous[index] ?? 0;
      const corner = index >= channels ? (previous[index - channels] ?? 0) : 0;
      const byte = raw[start + 1 + index] ?? 0;
      let value: number;
      switch (filter) {
        case 0:
          value = byte;
          break;
        case 1:
          value = byte + left;
          break;
        case 2:
          value = byte + up;
          break;
        case 3:
          value = byte + Math.floor((left + up) / 2);
          break;
        case 4:
          value = byte + paeth(left, up, corner);
          break;
        default:
          throw new Error(`filtre PNG inconnu : ${String(filter)}`);
      }
      current[index] = value & 255;
    }
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      rgba.set(current.subarray(x * channels, x * channels + 3), at);
      rgba[at + 3] = channels === 4 ? (current[x * channels + 3] ?? 0) : 255;
    }
    previous = current;
  }
  return { width, height, rgba };
}
