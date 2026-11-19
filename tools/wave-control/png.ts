/**
 * Décodeur PNG minimal du contrôle des pixels de la mer animée (tools/wave-control/LISEZMOI.md,
 * ADR 0015) : images de 8 bits par canal, en RGB ou en RGBA, non entrelacées, comme celles que
 * Chromium capture. Il rend les pixels en RGB, trois octets par pixel, ligne par ligne, sans
 * aucune conversion de couleur : les octets mêmes que l'écran a montrés.
 */
import { inflateSync } from 'node:zlib';

/** Une image en RGB : trois octets par pixel, ligne par ligne. */
export interface RgbImage {
  readonly width: number;
  readonly height: number;
  readonly rgb: Uint8Array;
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

/** Décode le fichier PNG `file` ; lève une erreur sur un format que le contrôle ne lit pas. */
export function decodePng(file: Uint8Array): RgbImage {
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
  const rgb = new Uint8Array(width * height * 3);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const filter = raw[start];
    const current = new Uint8Array(stride);
    for (let index = 0; index < stride; index++) {
      const left = index >= channels ? current[index - channels] : 0;
      const up = previous[index];
      const corner = index >= channels ? previous[index - channels] : 0;
      const byte = raw[start + 1 + index];
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
      rgb.set(current.subarray(x * channels, x * channels + 3), (y * width + x) * 3);
    }
    previous = current;
  }
  return { width, height, rgb };
}
