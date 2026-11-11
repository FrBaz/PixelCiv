import { describe, expect, it, vi } from 'vitest';
import { DialogFocus } from './dialog';

/** Un document imité : l'élément qui a le focus, et le corps de la page. */
class FakeDocument {
  readonly body: FakeElement;
  activeElement: FakeElement;

  constructor() {
    this.body = new FakeElement(this, 'body');
    this.activeElement = this.body;
  }
}

class FakeElement {
  isConnected = true;
  readonly ownerDocument: FakeDocument;
  readonly name: string;

  constructor(ownerDocument: FakeDocument, name: string) {
    this.ownerDocument = ownerDocument;
    this.name = name;
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }
}

/** Le focus d'un panneau, et ce qu'il voit : un document, un bouton d'origine, deux titres. */
function setup() {
  const document = new FakeDocument();
  const origin = new FakeElement(document, 'origine');
  const first = new FakeElement(document, 'premier titre');
  const second = new FakeElement(document, 'second titre');
  const focus = new DialogFocus();
  const title = (element: FakeElement | null) => {
    focus.title(element as unknown as HTMLElement | null);
  };
  return { document, origin, first, second, focus, title };
}

const tick = () =>
  new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });

describe('focus des dialogues (U-14)', () => {
  it("passe au titre à l'ouverture, puis revient à l'origine à la fermeture", () => {
    const { document, origin, first, focus, title } = setup();
    origin.focus();
    title(first);
    expect(document.activeElement).toBe(first);
    const close = vi.fn();
    focus.close(close);
    expect(close).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(origin);
  });

  it("garde l'origine quand la fiche change de cible, dans un sens comme dans l'autre", async () => {
    const { document, origin, first, second, focus, title } = setup();
    origin.focus();
    title(first);
    // Le nouveau titre remplace l'ancien dans le même rendu ; le focus était dans la fiche.
    title(null);
    document.activeElement = document.body;
    title(second);
    expect(document.activeElement).toBe(second);
    await tick();
    // Et dans l'autre ordre : le nouveau titre d'abord, l'ancien ensuite.
    title(first);
    title(null);
    await tick();
    focus.close(() => undefined);
    expect(document.activeElement).toBe(origin);
  });

  it("oublie l'origine d'un panneau fermé d'ailleurs, et ne rend pas le focus à un élément parti", async () => {
    const { document, origin, first, second, focus, title } = setup();
    origin.focus();
    title(first);
    // La fiche se ferme seule (sa cible n'est plus) : l'origine s'oublie.
    title(null);
    await tick();
    // Une fiche ouverte depuis la carte, le focus sur le corps de la page.
    document.activeElement = document.body;
    title(second);
    focus.close(() => undefined);
    expect(document.activeElement).toBe(second);
    // Un élément d'origine retiré de la page ne reprend pas le focus.
    origin.focus();
    title(first);
    origin.isConnected = false;
    focus.close(() => undefined);
    expect(document.activeElement).toBe(first);
  });

  it('ferme le panneau par Échap, et laisse passer les autres touches', () => {
    const { focus } = setup();
    const close = vi.fn();
    const key = (name: string) => ({
      key: name,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    const tab = key('Tab');
    focus.keyDown(tab, close);
    expect(close).not.toHaveBeenCalled();
    expect(tab.preventDefault).not.toHaveBeenCalled();
    const escape = key('Escape');
    focus.keyDown(escape, close);
    expect(close).toHaveBeenCalledTimes(1);
    expect(escape.preventDefault).toHaveBeenCalled();
    expect(escape.stopPropagation).toHaveBeenCalled();
  });
});
