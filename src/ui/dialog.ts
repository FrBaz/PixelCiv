/**
 * Focus des panneaux qui se déclarent dialogues, la fiche et l'outil d'apparition (U-14 ;
 * WCAG 2.4.3) : à son ouverture, ou quand il change de cible, le panneau porte le focus
 * sur son titre, qu'un lecteur d'écran annonce ; Échap le ferme, et le focus revient alors
 * à l'élément d'où il s'était ouvert, s'il est encore là. Ces panneaux ne sont pas modaux :
 * la carte reste à portée, et le focus peut en sortir.
 */

/** Un élément qui peut recevoir le focus : un HTMLElement, ou son imitation dans les tests. */
type Focusable = Pick<HTMLElement, 'focus' | 'isConnected' | 'ownerDocument'>;

function isFocusable(element: unknown): element is Focusable {
  return (
    typeof element === 'object' &&
    element !== null &&
    typeof (element as Partial<Focusable>).focus === 'function'
  );
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

  /** Ferme le panneau par `close`, puis rend le focus à son origine, si elle est encore là. */
  close(close: () => void): void {
    const origin = this.origin;
    this.origin = undefined;
    close();
    if (origin?.isConnected === true) origin.focus({ preventScroll: true });
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
