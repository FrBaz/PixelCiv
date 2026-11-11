/**
 * Portrait à l'écran (tâche 2.8 ; CLAUDE.md, « Pixel art ») : un nombre entier de pixels
 * physiques par pixel du portrait, quelle que soit la densité de l'écran, dans un canevas
 * dont chaque pixel est un pixel physique, agrandi par le code. Agrandi par le navigateur
 * de 2 pixels CSS par pixel, le portrait avait, sur un écran de densité 1,25 ou 2,75, des
 * pixels de deux tailles. Fonctions pures.
 *
 * Le navigateur place le canevas au pixel physique près, et sa taille ne change pas si
 * elle tombe juste sur un nombre entier de pixels physiques : chaque pixel du canevas est
 * alors un pixel de l'écran, où que la mise en page le pose.
 */
import type { Rgb } from '../render/bake';

/** Taille voulue d'un pixel du portrait, en pixels CSS. */
export const PORTRAIT_CSS_PIXEL = 2;

/**
 * Mise en place, à l'écran, d'une image carrée de `size` pixels, pour une densité d'écran
 * (pixels physiques par pixel CSS) : `factor`, le nombre entier de pixels physiques par
 * pixel de l'image, sans dépasser PORTRAIT_CSS_PIXEL pixels CSS, pour que le portrait ne
 * déborde jamais de sa place ; `side`, le côté du canevas, `size` × `factor` pixels
 * physiques ; `css`, ce même côté en pixels CSS. Il compte 1/256 de pixel physique de
 * plus, que la mise en page, au 1/64 de pixel près, efface en tronquant comme en
 * arrondissant : le canevas fait ainsi `side` pixels physiques tout juste, malgré
 * l'arrondi des flottants.
 */
export function portraitScale(
  density: number,
  size: number,
): { factor: number; side: number; css: number } {
  // La marge absorbe l'arrondi des flottants : 2 × 1,5 vaut bien 3.
  const factor = Math.max(1, Math.floor(PORTRAIT_CSS_PIXEL * density + 1e-6));
  const side = size * factor;
  return { factor, side, css: (side + 1 / 256) / density };
}

/**
 * Pixels RGBA d'une image carrée de `size` pixels de côté, agrandie `factor` fois au plus
 * proche, au centre d'une toile de `width` × `height` pixels, sur le fond `backdrop` : les
 * pixels transparents de l'image prennent le fond, eux aussi. Sur une toile trop petite,
 * l'agrandissement se réduit, sans tomber sous 1.
 */
export function enlarge(
  pixels: ArrayLike<number>,
  size: number,
  factor: number,
  width: number,
  height: number,
  backdrop: Rgb,
): Uint8ClampedArray<ArrayBuffer> {
  const scale = Math.max(1, Math.min(factor, Math.floor(Math.min(width, height) / size)));
  const left = Math.floor((width - size * scale) / 2);
  const top = Math.floor((height - size * scale) / 2);
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = Math.floor((y - top) / scale);
    for (let x = 0; x < width; x++) {
      const column = Math.floor((x - left) / scale);
      const target = (y * width + x) * 4;
      const source = (row * size + column) * 4;
      const inside = row >= 0 && row < size && column >= 0 && column < size;
      const opaque = inside && pixels[source + 3] === 255;
      out[target] = opaque ? (pixels[source] ?? 0) : backdrop[0];
      out[target + 1] = opaque ? (pixels[source + 1] ?? 0) : backdrop[1];
      out[target + 2] = opaque ? (pixels[source + 2] ?? 0) : backdrop[2];
      out[target + 3] = 255;
    }
  }
  return out;
}
