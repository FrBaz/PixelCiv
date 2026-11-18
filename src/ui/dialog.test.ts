import { describe, expect, it, vi } from 'vitest';
import { DialogFocus } from './dialog';
import { FakeDocument, FakeElement, nextFrame } from './testing';

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

/** Le rendu de Preact, dans une microtâche après la fermeture : `changes` y a lieu. */
const render = (changes: () => void) => () => {
  queueMicrotask(changes);
};

describe('focus des dialogues (U-14)', () => {
  it("passe au titre à l'ouverture, puis revient à l'origine après le rendu qui ferme", async () => {
    const { document, origin, first, focus, title } = setup();
    origin.focus();
    title(first);
    expect(document.activeElement).toBe(first);
    const close = vi.fn(
      render(() => {
        first.remove();
      }),
    );
    focus.close(close);
    expect(close).toHaveBeenCalledTimes(1);
    await nextFrame();
    expect(document.activeElement).toBe(origin);
  });

  it("rend le focus à une origine que la fiche cachait, une fois qu'elle reparaît (petit écran)", async () => {
    const { document, origin, first, focus, title } = setup();
    origin.focus();
    title(first);
    // Sur petit écran, la fiche recouvre la chronique d'où elle s'est ouverte : le fait
    // d'origine n'est plus affiché, et ne reprend le focus qu'après le rendu qui le découvre.
    origin.displayed = false;
    focus.close(
      render(() => {
        first.remove();
        origin.displayed = true;
      }),
    );
    // Avant ce rendu, le focus ne bouge pas.
    expect(document.activeElement).toBe(first);
    await nextFrame();
    expect(document.activeElement).toBe(origin);
  });

  it('ne prend pas le focus parti ailleurs, et ne le rend pas à une origine cachée ou partie', async () => {
    const { document, origin, first, second, focus, title } = setup();
    origin.focus();
    title(first);
    // Le joueur a mis le focus ailleurs avant l'image suivante : il y reste.
    focus.close(
      render(() => {
        first.remove();
        second.focus();
      }),
    );
    await nextFrame();
    expect(document.activeElement).toBe(second);
    // Une origine qui reste cachée après le rendu : le focus reste au corps de la page.
    const hidden = new FakeElement(document, 'titre');
    origin.focus();
    title(hidden);
    origin.displayed = false;
    const attempts = vi.spyOn(origin, 'focus');
    focus.close(
      render(() => {
        hidden.remove();
      }),
    );
    await nextFrame();
    expect(document.activeElement).toBe(document.body);
    expect(attempts).not.toHaveBeenCalled();
    // Une origine retirée de la page ne reprend pas le focus.
    origin.displayed = true;
    const gone = new FakeElement(document, 'titre');
    origin.focus();
    title(gone);
    attempts.mockClear();
    focus.close(
      render(() => {
        gone.remove();
        origin.remove();
      }),
    );
    await nextFrame();
    expect(document.activeElement).toBe(document.body);
    expect(attempts).not.toHaveBeenCalled();
  });

  it("garde l'origine quand la fiche change de cible, dans un sens comme dans l'autre", async () => {
    const { document, origin, first, second, focus, title } = setup();
    origin.focus();
    title(first);
    // Le nouveau titre remplace l'ancien dans le même rendu ; le focus était dans la fiche.
    title(null);
    first.remove();
    title(second);
    expect(document.activeElement).toBe(second);
    await tick();
    // Et dans l'autre ordre : le nouveau titre d'abord, l'ancien ensuite.
    const third = new FakeElement(document, 'troisième titre');
    title(third);
    title(null);
    second.remove();
    await tick();
    focus.close(
      render(() => {
        third.remove();
      }),
    );
    await nextFrame();
    expect(document.activeElement).toBe(origin);
  });

  it("oublie l'origine d'un panneau fermé d'ailleurs, ou ouvert depuis la carte", async () => {
    const { document, origin, first, second, focus, title } = setup();
    origin.focus();
    title(first);
    // La fiche se ferme seule (sa cible n'est plus) : l'origine s'oublie.
    title(null);
    first.remove();
    await tick();
    // Une fiche ouverte depuis la carte, le focus sur le corps de la page : aucune origine.
    title(second);
    expect(document.activeElement).toBe(second);
    focus.close(
      render(() => {
        second.remove();
      }),
    );
    await nextFrame();
    expect(document.activeElement).toBe(document.body);
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
