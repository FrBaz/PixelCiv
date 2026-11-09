/**
 * Géométrie du monde cylindrique (ADR 0002) : x boucle d'est en ouest, y non.
 * Toute coordonnée x passe par wrapX, toute distance horizontale par deltaX.
 */

/** Ramène x dans [0, width), y compris quand x est négatif. */
export function wrapX(x: number, width: number): number {
  return ((x % width) + width) % width;
}

/** Écart horizontal signé le plus court de `from` vers `to`, dans [-width/2, width/2). */
export function deltaX(from: number, to: number, width: number): number {
  const delta = wrapX(to - from, width);
  return delta >= width / 2 ? delta - width : delta;
}

/** Distance entre deux points, par le plus court chemin à travers la couture. */
export function distance(ax: number, ay: number, bx: number, by: number, width: number): number {
  const dx = deltaX(ax, bx, width);
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}
