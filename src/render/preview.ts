/**
 * Image de l'aperçu de l'écran de création (tâche 1.9 ; CRE-01) : une couleur par case,
 * celle du biome, ombrée selon la pente sous la même lumière du nord-est que la carte.
 * L'aperçu est le même monde, sur une carte réduite (le bruit se règle par tour du
 * monde) : ses continents sont ceux de la partie.
 */
import type { WorldSize } from '../core/world';
import type { Rgb } from './bake';

/** Force de l'ombrage et ses bornes, sur l'altitude en kilomètres élevée à la puissance 0,6. */
const SHADE_STRENGTH = 1.6;
const SHADE_MIN = 0.62;
const SHADE_MAX = 1.38;

/** Relief ombré : altitude des terres en kilomètres, à la puissance 0,6 ; la mer est plate. */
function relief(elevation: number): number {
  return elevation > 0 ? (elevation / 1000) ** 0.6 : 0;
}

/**
 * Pixels RGBA de l'aperçu, ligne par ligne : la couleur de base du biome de chaque case,
 * ombrée sur les terres. Les colonnes bouclent : la pente de la couture suit l'autre bord.
 */
export function previewPixels(
  size: WorldSize,
  biome: Uint8Array,
  elevation: Int16Array,
  colors: readonly Rgb[],
): Uint8ClampedArray<ArrayBuffer> {
  const { width, height } = size;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const at = (x: number, y: number) => {
    const column = (x + width) % width;
    const row = Math.min(height - 1, Math.max(0, y));
    return relief(elevation[row * width + column] ?? 0);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = y * width + x;
      const color = colors.at(biome[cell] ?? 0) ?? [0, 0, 0];
      let shade = 1;
      if ((elevation[cell] ?? 0) > 0) {
        const gx = (at(x + 1, y) - at(x - 1, y)) / 2;
        const gy = (at(x, y + 1) - at(x, y - 1)) / 2;
        const lit = (gy - gx) * Math.SQRT1_2;
        shade = Math.min(SHADE_MAX, Math.max(SHADE_MIN, 1 + SHADE_STRENGTH * lit));
      }
      const offset = cell * 4;
      pixels[offset] = color[0] * shade;
      pixels[offset + 1] = color[1] * shade;
      pixels[offset + 2] = color[2] * shade;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}
