/**
 * Partie visible de la carte (U-5) : l'écran, moins les panneaux qui le couvrent. Centrer
 * la carte sur un lieu, depuis la chronique ou une fiche, le met au milieu de cette partie,
 * et non sous la fiche qui s'ouvre, comme au téléphone, où les panneaux couvrent le centre
 * de l'écran.
 */

/** Un rectangle de l'écran, en pixels CSS. */
export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

function area(rect: Rect): number {
  return Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);
}

/**
 * Le rectangle de `screen` que ne couvre aucun des rectangles de `covers`, trouvé de proche
 * en proche, du plus grand panneau au plus petit : chacun retranche la bande qu'il occupe,
 * à gauche, à droite, en haut ou en bas, celle qui laisse le plus de carte. Les panneaux
 * vides, ou hors de ce qui reste, ne retranchent rien. Si rien ne reste, tout l'écran.
 */
export function visibleArea(screen: Rect, covers: readonly Rect[]): Rect {
  // Les côtés se lisent un à un : ceux d'un DOMRect sont des accesseurs, qu'une
  // décomposition ({ ...rect }) ne copierait pas.
  const { left, top, right, bottom } = screen;
  let free: Rect = { left, top, right, bottom };
  const sorted = covers.filter((cover) => area(cover) > 0).sort((a, b) => area(b) - area(a));
  for (const cover of sorted) {
    const overlaps =
      cover.left < free.right &&
      cover.right > free.left &&
      cover.top < free.bottom &&
      cover.bottom > free.top;
    if (!overlaps) continue;
    const { left, top, right, bottom } = free;
    const bands: Rect[] = [
      { left, top, right: Math.max(left, cover.left), bottom },
      { left: Math.min(right, cover.right), top, right, bottom },
      { left, top, right, bottom: Math.max(top, cover.top) },
      { left, top: Math.min(bottom, cover.bottom), right, bottom },
    ];
    free = bands.reduce((best, band) => (area(band) > area(best) ? band : best));
  }
  return area(free) > 0 ? free : { left, top, right, bottom };
}

/** Centre d'un rectangle. */
export function centerOf(rect: Rect): { readonly x: number; readonly y: number } {
  return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
}
