/**
 * Focus des panneaux qui se déclarent dialogues, la fiche et l'outil d'apparition (U-14 ;
 * WCAG 2.4.3) : à son ouverture, ou quand il change de cible, le panneau porte le focus
 * sur son titre, qu'un lecteur d'écran annonce ; Échap le ferme, et le focus revient alors
 * à l'élément d'où il s'était ouvert, s'il est encore là. Ces panneaux ne sont pas modaux :
 * la carte reste à portée, et le focus peut en sortir ; Échap les ferme alors aussi
 * (escape.ts).
 *
 * Le focus revient après le rendu qui suit la fermeture : sur petit écran, l'origine, un
 * fait de la chronique par exemple, reste cachée sous la fiche jusqu'à ce rendu, et
 * focus() n'agit pas sur un élément qui n'est pas affiché.
 */

/** Un élément qui peut recevoir le focus : un HTMLElement, ou son imitation dans les tests. */
type Focusable = Pick<HTMLElement, 'focus' | 'isConnected' | 'ownerDocument' | 'getClientRects'>;

function isFocusable(element: unknown): element is Focusable {
  if (typeof element !== 'object' || element === null) return false;
  const candidate = element as Partial<Focusable>;
  return typeof candidate.focus === 'function' && typeof candidate.getClientRects === 'function';
}

/**
 * Rappelle `callback` après le rendu qui suit : Preact rend dans une microtâche, avant
 * l'image suivante. Hors du navigateur, dans les tests sous Node, à la tâche suivante.
 */
function afterRender(callback: () => void): void {
  if ('requestAnimationFrame' in globalThis) requestAnimationFrame(callback);
  else setTimeout(callback, 0);
}

export class DialogFocus {
  /** Élément qui avait le focus quand le panneau s'est ouvert. */
  private origin: Focusable | undefined;
  /** Titres dans la page : un, ou deux le temps qu'une fiche change de cible. */
  private shown = 0;

  /**
   * Ref du titre, à poser telle quelle : une fonction stable, que Preact n'appelle que
   * lorsqu'un titre entre dans la page, puis avec null quand il la quitte. Un titre qui en
   * remplace un autre dans le même rendu, quand la fiche change de cible, garde l'origine
   * du premier ; un titre qui s'en va sans remplaçant ferme le panneau, et l'oublie.
   */
  readonly title = (element: Focusable | null): void => {
    if (element === null) {
      this.shown = Math.max(0, this.shown - 1);
      queueMicrotask(() => {
        if (this.shown === 0) this.origin = undefined;
      });
      return;
    }
    this.shown++;
    const document = element.ownerDocument;
    const active = document.activeElement;
    if (this.origin === undefined && active !== document.body && isFocusable(active)) {
      this.origin = active;
    }
    element.focus({ preventScroll: true });
  };

  /**
   * Ferme le panneau par `close`, puis, après le rendu qui suit, rend le focus à son
   * origine : si elle est encore dans la page et affichée, et si le focus n'est pas allé
   * ailleurs entre-temps. Le titre, parti avec le panneau, l'a laissé au corps de la page.
   */
  close(close: () => void): void {
    const origin = this.origin;
    this.origin = undefined;
    close();
    if (origin === undefined) return;
    afterRender(() => {
      const { activeElement, body } = origin.ownerDocument;
      const free = activeElement === null || activeElement === body;
      if (free && origin.isConnected && origin.getClientRects().length > 0) {
        origin.focus({ preventScroll: true });
      }
    });
  }

  /** Touche pressée dans le panneau : Échap le ferme. */
  keyDown(
    event: Pick<KeyboardEvent, 'key' | 'preventDefault' | 'stopPropagation'>,
    close: () => void,
  ): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    this.close(close);
  }
}
