import { describe, expect, it } from 'vitest';
import { centerOf, visibleArea, type Rect } from './focus';

/**
 * Un rectangle comme getBoundingClientRect les rend : ses côtés sont des accesseurs du
 * prototype, et non des propriétés propres, qu'une décomposition ({ ...rect }) perdrait.
 */
class DomRect implements Rect {
  readonly #box: readonly [number, number, number, number];

  constructor(x: number, y: number, width: number, height: number) {
    this.#box = [x, y, width, height];
  }

  get left(): number {
    return this.#box[0];
  }

  get top(): number {
    return this.#box[1];
  }

  get right(): number {
    return this.#box[0] + this.#box[2];
  }

  get bottom(): number {
    return this.#box[1] + this.#box[3];
  }
}

const rect = (x: number, y: number, width: number, height: number) =>
  new DomRect(x, y, width, height);

describe('partie visible de la carte (U-5)', () => {
  it("est tout l'écran quand rien ne le couvre", () => {
    expect(centerOf(visibleArea(rect(0, 0, 1280, 720), []))).toEqual({ x: 640, y: 360 });
  });

  it('sur PC : à gauche de la colonne, entre les deux barres', () => {
    const covers = [
      rect(8, 8, 457, 54), // temps
      rect(473, 8, 92, 54), // débogage
      rect(952, 70, 320, 642), // colonne de droite
      rect(952, 70, 320, 146), // chronique
      rect(8, 534, 242, 54), // outils
      rect(8, 596, 342, 54), // modes de carte
      rect(8, 658, 512, 54), // menu de la partie
    ];
    const free = visibleArea(rect(0, 0, 1280, 720), covers);
    expect({ ...centerOf(free) }).toEqual({ x: 476, y: 298 });
    expect([free.left, free.top, free.right, free.bottom]).toEqual([0, 62, 952, 534]);
  });

  it('au téléphone en portrait : au-dessus de la feuille du bas', () => {
    const covers = [
      rect(8, 8, 377, 76), // temps, sur deux lignes
      rect(8, 92, 115, 44), // débogage
      rect(8, 349, 377, 308), // colonne, en bas
      rect(8, 349, 377, 308), // fiche
      rect(8, 665, 377, 54), // barre du bas, sur une ligne
    ];
    const free = visibleArea(rect(0, 0, 393, 727), covers);
    expect([free.left, free.top, free.right, free.bottom]).toEqual([0, 136, 393, 349]);
  });

  it('au téléphone en paysage : à gauche de la colonne, au-dessus de la barre du bas', () => {
    const covers = [
      rect(8, 8, 552, 54), // temps
      rect(568, 8, 115, 54), // débogage
      rect(474, 70, 320, 215), // colonne, sur toute la hauteur
      rect(474, 70, 320, 146), // chronique
      rect(8, 231, 458, 54), // barre du bas
    ];
    const free = visibleArea(rect(0, 0, 802, 293), covers);
    expect([free.left, free.top, free.right, free.bottom]).toEqual([0, 62, 474, 231]);
    expect(centerOf(free)).toEqual({ x: 237, y: 146.5 });
  });

  it("ignore les panneaux vides ou hors de ce qui reste, et rend l'écran si rien ne reste", () => {
    const screen = rect(0, 0, 800, 600);
    expect(visibleArea(screen, [rect(100, 100, 0, 0), rect(900, 0, 50, 50)])).toEqual({
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
    });
    expect(visibleArea(screen, [rect(-10, -10, 900, 700)])).toEqual({
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
    });
  });
});
