/**
 * Image à la demande (tâche 2b.4 ; ADR 0010 et ADR 0015). PixiJS redessine d'ordinaire toute
 * la scène à chaque image, même en pause, même quand rien n'a changé. Ici, l'image ne se
 * redessine que si sa signature change : ce que lit chaque calque qui dessine (la caméra, la
 * taille et la densité de l'écran, l'instant affiché, la version de la carte et de ses
 * textures, le pas de la mer animée quand elle se voit, la version du calque des individus),
 * ou après une invalidation, quand la page a perdu l'image (contexte WebGL rendu, retour au
 * premier plan). Tout calque qui dessine expose une version que la signature lit : ce qu'elle
 * ne voit pas resterait figé jusqu'à l'image suivante.
 */

/** Ce qui décide de redessiner l'image : sa signature, et les invalidations. */
export class FrameGate {
  private last: readonly unknown[] | undefined;
  private invalid = true;

  /**
   * L'image dont la signature est `parts` diffère-t-elle de la dernière, ou a-t-elle été
   * invalidée depuis ? Les parties se comparent une à une, NaN égal à NaN.
   */
  changed(parts: readonly unknown[]): boolean {
    const last = this.last;
    const same =
      !this.invalid &&
      last?.length === parts.length &&
      parts.every((part, index) => Object.is(part, last[index]));
    this.last = parts.slice();
    this.invalid = false;
    return !same;
  }

  /** La prochaine image se redessine, quelle que soit sa signature. */
  invalidate(): void {
    this.invalid = true;
  }
}

/** Ce que l'invalidation écoute : le canvas, le document et la fenêtre. */
export interface PageEvents {
  readonly canvas: EventTarget;
  readonly document: EventTarget & { readonly visibilityState: DocumentVisibilityState };
  readonly window: EventTarget;
}

/**
 * Invalide l'image quand la page ne la garde plus : contexte WebGL rendu après sa perte,
 * onglet revenu au premier plan, page reprise du cache de l'historique.
 */
export function invalidateOnRestore(gate: FrameGate, page: PageEvents): void {
  const invalidate = () => {
    gate.invalidate();
  };
  page.canvas.addEventListener('webglcontextrestored', invalidate);
  page.document.addEventListener('visibilitychange', () => {
    if (page.document.visibilityState === 'visible') gate.invalidate();
  });
  page.window.addEventListener('pageshow', invalidate);
}
