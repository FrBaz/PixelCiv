/**
 * Géométrie du monde cylindrique (ADR 0002) : x boucle d'est en ouest, y non.
 * Toute coordonnée x passe par wrapX, toute distance horizontale par deltaX.
 */

/**
 * Ramène x dans [0, width), y compris quand x est négatif ; ne renvoie jamais -0.
 * Le reste de `%` est exact : une valeur déjà dans [0, width) revient inchangée.
 */
export function wrapX(x: number, width: number): number {
  const rest = x % width;
  // -0 >= 0 : `+ 0` en fait un zéro positif.
  if (rest >= 0) return rest + 0;
  // Un reste négatif infime donne rest + width arrondi à width, qui vaut 0 sur le cercle.
  const wrapped = rest + width;
  return wrapped < width ? wrapped : 0;
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
