/**
 * Décodeur PNG du contrôle des pixels de la mer animée (tools/wave-control/LISEZMOI.md,
 * ADR 0015) : celui des outils (tools/png.ts), rendu en RGB, trois octets par pixel, ligne par
 * ligne, sans aucune conversion de couleur : les octets mêmes que l'écran a montrés.
 */
import { decodeRgba } from '../png.ts';

/** Une image en RGB : trois octets par pixel, ligne par ligne. */
export interface RgbImage {
  readonly width: number;
  readonly height: number;
  readonly rgb: Uint8Array;
}

/** Décode le fichier PNG `file` ; lève une erreur sur un format que le contrôle ne lit pas. */
export function decodePng(file: Uint8Array): RgbImage {
  const { width, height, rgba } = decodeRgba(file);
  const rgb = new Uint8Array(width * height * 3);
  for (let index = 0; index < width * height; index++) {
    rgb.set(rgba.subarray(index * 4, index * 4 + 3), index * 3);
  }
  return { width, height, rgb };
}
