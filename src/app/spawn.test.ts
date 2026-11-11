import { describe, expect, it } from 'vitest';
import { emptyLayers, type WorldSize } from '../core/world';
import { walkCost } from '../sim/terrain';
import { testData } from '../sim/testing';
import { spawnTarget } from './spawn';

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

describe("outil d'apparition (CRE-03)", () => {
  it('ramène x dans le monde avant de juger la case, au-delà de la couture (W-3, U-2)', () => {
    const { size, layers } = world();
    // À gauche de la couture, la dernière colonne de la même rangée, et non de la rangée
    // du dessus : la prairie (7, 2) se prend, le lac (7, 1) se refuse.
    expect(spawnTarget(layers, size, -1, 2, testData)).toEqual({ x: 7, y: 2 });
    expect(spawnTarget(layers, size, -1, 1, testData)).toEqual({ refusal: 'creator.water' });
    // À droite, la première colonne de la même rangée, et non de la rangée du dessous.
    expect(spawnTarget(layers, size, 8, 1, testData)).toEqual({ x: 0, y: 1 });
    expect(spawnTarget(layers, size, 8, 0, testData)).toEqual({ refusal: 'creator.water' });
    // D'une copie à l'autre du monde, la même case.
    for (let copy = -2; copy <= 2; copy++) {
      expect(spawnTarget(layers, size, 3 + copy * size.width, 2, testData)).toEqual({ x: 3, y: 2 });
    }
  });

  it('refuse un sommet infranchissable et ce qui est hors du monde, avec sa raison (W-13)', () => {
    const { size, layers } = world();
    // Le glacier se traverse, mais pas à 4 200 m : c'est l'étage qui le rend infranchissable.
    expect(walkCost(layers, 3 * size.width, testData)).toBe(Number.POSITIVE_INFINITY);
    expect(spawnTarget(layers, size, 0, 3, testData)).toEqual({ refusal: 'creator.summit' });
    expect(spawnTarget(layers, size, 16, 3, testData)).toEqual({ refusal: 'creator.summit' });
    for (const y of [-1, 4, 40]) {
      expect(spawnTarget(layers, size, 2, y, testData)).toEqual({ refusal: 'creator.outside' });
    }
    expect(spawnTarget(layers, size, Number.NaN, 2, testData)).toEqual({
      refusal: 'creator.outside',
    });
  });
});
