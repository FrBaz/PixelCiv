import { describe, expect, it } from 'vitest';
import type { ChronicleView, GroupsFrame } from '../core/protocol';
import { emptyLayers, type WorldSize } from '../core/world';
import { walkCost } from '../sim/terrain';
import { testData } from '../sim/testing';
import { OccupiedCells, spawnTarget } from './spawn';

/** Indice d'un biome des données. */
function biome(id: string): number {
  const index = testData.biomes.indexOf(id);
  if (index === undefined) throw new Error(`biome inconnu : ${id}`);
  return index;
}

/**
 * Un petit monde de 8 × 4 cases, dont les rangées diffèrent : une case lue dans la rangée
 * voisine se verrait. Rangée 0 : océan ; 1 : prairie, sauf un lac en dernière colonne ;
 * 2 : prairie ; 3 : prairie, sauf un sommet enneigé en première colonne.
 */
function world() {
  const size: WorldSize = { width: 8, height: 4 };
  const layers = emptyLayers(size);
  layers.elevation.fill(120);
  layers.biome.fill(biome('grassland'));
  for (let x = 0; x < size.width; x++) {
    layers.biome[x] = biome('ocean');
    layers.elevation[x] = -2000;
  }
  layers.biome[size.width + 7] = biome('lake');
  layers.biome[3 * size.width] = biome('glacier');
  layers.elevation[3 * size.width] = 4200;
  return { size, layers };
}

/** Aucune case occupée. */
const none: ReadonlySet<number> = new Set();

/** Le refus d'une case occupée. */
const OCCUPIED = { refusal: 'creator.occupied' };

/** Une image du worker : pour chaque groupe, identifiant, x, y, membres et culture. */
function frame(...cells: (readonly [x: number, y: number])[]): GroupsFrame {
  const groups = cells.flatMap(([x, y], index) => [index + 1, x, y, 20, 0]);
  return { groups: Uint32Array.from(groups), sprites: new Uint16Array(20 * cells.length) };
}

/** Le fait d'une apparition, à la case (x, y). */
function appeared(x: number, y: number): ChronicleView {
  const fact = { index: 0, tick: 0, groupId: 1, group: '', other: '', count: 20 };
  return { ...fact, kind: 'groupAppeared', x, y };
}

describe("outil d'apparition (CRE-03)", () => {
  it('ramène x dans le monde avant de juger la case, au-delà de la couture (W-3, U-2)', () => {
    const { size, layers } = world();
    // À gauche de la couture, la dernière colonne de la même rangée, et non de la rangée
    // du dessus : la prairie (7, 2) se prend, le lac (7, 1) se refuse.
    expect(spawnTarget(layers, size, -1, 2, testData, none)).toEqual({ x: 7, y: 2 });
    expect(spawnTarget(layers, size, -1, 1, testData, none)).toEqual({ refusal: 'creator.water' });
    // À droite, la première colonne de la même rangée, et non de la rangée du dessous.
    expect(spawnTarget(layers, size, 8, 1, testData, none)).toEqual({ x: 0, y: 1 });
    expect(spawnTarget(layers, size, 8, 0, testData, none)).toEqual({ refusal: 'creator.water' });
    // D'une copie à l'autre du monde, la même case.
    for (let copy = -2; copy <= 2; copy++) {
      expect(spawnTarget(layers, size, 3 + copy * size.width, 2, testData, none)).toEqual({
        x: 3,
        y: 2,
      });
    }
  });

  it('refuse un sommet infranchissable et ce qui est hors du monde, avec sa raison (W-13)', () => {
    const { size, layers } = world();
    // Le glacier se traverse, mais pas à 4 200 m : c'est l'étage qui le rend infranchissable.
    expect(walkCost(layers, 3 * size.width, testData)).toBe(Number.POSITIVE_INFINITY);
    expect(spawnTarget(layers, size, 0, 3, testData, none)).toEqual({ refusal: 'creator.summit' });
    expect(spawnTarget(layers, size, 16, 3, testData, none)).toEqual({ refusal: 'creator.summit' });
    for (const y of [-1, 4, 40]) {
      expect(spawnTarget(layers, size, 2, y, testData, none)).toEqual({
        refusal: 'creator.outside',
      });
    }
    expect(spawnTarget(layers, size, Number.NaN, 2, testData, none)).toEqual({
      refusal: 'creator.outside',
    });
  });

  it("refuse une case occupée par un groupe de l'image, même par un x hors du monde (9-navigateur/P2)", () => {
    const { size, layers } = world();
    // Deux groupes : sur la prairie (7, 2), au bord est du monde, et sur la prairie (1, 2),
    // dont la case (2, 1) prendrait la place si x et y s'échangeaient.
    const occupied = new OccupiedCells();
    occupied.reset(frame([7, 2], [1, 2]), size);
    // La case (7, 2), d'une copie à l'autre du monde, et par la couture à l'ouest de (0, 2).
    for (const x of [7, -1, 15, -9, 23]) {
      expect(spawnTarget(layers, size, x, 2, testData, occupied)).toEqual(OCCUPIED);
    }
    expect(spawnTarget(layers, size, 1, 2, testData, occupied)).toEqual(OCCUPIED);
    // Ses voisines : à l'ouest, à l'est par la couture, au-dessous ; et la case (2, 1).
    expect(spawnTarget(layers, size, 6, 2, testData, occupied)).toEqual({ x: 6, y: 2 });
    expect(spawnTarget(layers, size, 8, 2, testData, occupied)).toEqual({ x: 0, y: 2 });
    expect(spawnTarget(layers, size, -8, 2, testData, occupied)).toEqual({ x: 0, y: 2 });
    expect(spawnTarget(layers, size, 7, 3, testData, occupied)).toEqual({ x: 7, y: 3 });
    expect(spawnTarget(layers, size, 2, 1, testData, occupied)).toEqual({ x: 2, y: 1 });
    // L'eau garde sa raison.
    expect(spawnTarget(layers, size, 7, 1, testData, occupied)).toEqual({
      refusal: 'creator.water',
    });
    // Chaque image remplace la précédente.
    occupied.update(frame([6, 2]), [], size);
    expect(spawnTarget(layers, size, -1, 2, testData, occupied)).toEqual({ x: 7, y: 2 });
    expect(spawnTarget(layers, size, 6, 2, testData, occupied)).toEqual(OCCUPIED);
  });

  it("compte une apparition envoyée jusqu'à l'image qui la montre (9-navigateur/P2)", () => {
    const { size, layers } = world();
    const occupied = new OccupiedCells();
    occupied.reset(frame(), size);
    expect(spawnTarget(layers, size, 3, 2, testData, occupied)).toEqual({ x: 3, y: 2 });
    occupied.add(3, 2, size);
    expect(spawnTarget(layers, size, 3, 2, testData, occupied)).toEqual(OCCUPIED);
    // Une image calculée avant que le worker ne reçoive la commande : ni le groupe ni son
    // fait. L'apparition reste en attente.
    occupied.update(frame([5, 3]), [], size);
    expect(spawnTarget(layers, size, 3, 2, testData, occupied)).toEqual(OCCUPIED);
    expect(spawnTarget(layers, size, 5, 3, testData, occupied)).toEqual(OCCUPIED);
    // L'image qui la montre : le groupe, parti de sa case dans le mois, ne l'occupe plus.
    occupied.update(frame([4, 2], [5, 3]), [appeared(3, 2)], size);
    expect(spawnTarget(layers, size, 3, 2, testData, occupied)).toEqual({ x: 3, y: 2 });
    expect(spawnTarget(layers, size, 4, 2, testData, occupied)).toEqual(OCCUPIED);
    // Un autre fait, même à sa case, ne la montre pas.
    occupied.add(6, 1, size);
    occupied.update(frame(), [{ ...appeared(6, 1), kind: 'groupSplit' }], size);
    expect(spawnTarget(layers, size, 6, 1, testData, occupied)).toEqual(OCCUPIED);
    // Une commande refusée par le worker, ou une autre partie, efface les apparitions en
    // attente ; l'instantané donne ses groupes.
    occupied.refused();
    expect(spawnTarget(layers, size, 6, 1, testData, occupied)).toEqual({ x: 6, y: 1 });
    occupied.add(6, 1, size);
    occupied.reset(frame([2, 2]), size);
    expect(spawnTarget(layers, size, 6, 1, testData, occupied)).toEqual({ x: 6, y: 1 });
    expect(spawnTarget(layers, size, 2, 2, testData, occupied)).toEqual(OCCUPIED);
  });
});
