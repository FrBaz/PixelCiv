import { describe, expect, it } from 'vitest';
import { FIXED } from '../core/position';
import { NO_CARRIER, type ChronicleView, type GroupsFrame } from '../core/protocol';
import { emptyLayers, type WorldSize } from '../core/world';
import { walkCost } from '../sim/terrain';
import { testData } from '../sim/testing';
import { SPAWN_COUNT } from '../sim/commands';
import { CrowdTimeline } from './frames';
import { crowdCells, crowdGroups, CROWD_GROUP, OccupiedCells, spawnTarget } from './spawn';

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

/** Cases occupées par des groupes, comptées comme cellIndex dans un monde de 8 colonnes. */
function cells(...list: (readonly [x: number, y: number])[]): Set<number> {
  return new Set(list.map(([x, y]) => y * 8 + x));
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

  it('refuse une case où se tient quelqu’un, même par un x hors du monde (9-navigateur/P2)', () => {
    const { size, layers } = world();
    // Deux individus : sur la prairie (7, 2), au bord est du monde, et sur la prairie (1, 2),
    // dont la case (2, 1) prendrait la place si x et y s'échangeaient.
    const occupied = new OccupiedCells();
    occupied.setStanding(cells([7, 2], [1, 2]));
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
    // Les cases d'un appui remplacent celles du précédent : on a marché.
    occupied.setStanding(cells([6, 2]));
    expect(spawnTarget(layers, size, -1, 2, testData, occupied)).toEqual({ x: 7, y: 2 });
    expect(spawnTarget(layers, size, 6, 2, testData, occupied)).toEqual(OCCUPIED);
  });

  it("compte une apparition envoyée jusqu'au delta qui la montre (9-navigateur/P2)", () => {
    const { size, layers } = world();
    const occupied = new OccupiedCells();
    occupied.reset();
    expect(spawnTarget(layers, size, 3, 2, testData, occupied)).toEqual({ x: 3, y: 2 });
    occupied.add(3, 2, size);
    expect(spawnTarget(layers, size, 3, 2, testData, occupied)).toEqual(OCCUPIED);
    // Un delta parti avant que le worker ne reçoive la commande : ni le groupe ni son fait.
    // L'apparition reste en attente.
    occupied.update([], size);
    occupied.setStanding(cells([5, 3]));
    expect(spawnTarget(layers, size, 3, 2, testData, occupied)).toEqual(OCCUPIED);
    expect(spawnTarget(layers, size, 5, 3, testData, occupied)).toEqual(OCCUPIED);
    // Le delta qui la montre : son fait la retire de l'attente, et le groupe, parti de sa
    // case, ne l'occupe plus.
    occupied.update([appeared(3, 2)], size);
    occupied.setStanding(cells([4, 2], [5, 3]));
    expect(spawnTarget(layers, size, 3, 2, testData, occupied)).toEqual({ x: 3, y: 2 });
    expect(spawnTarget(layers, size, 4, 2, testData, occupied)).toEqual(OCCUPIED);
    // Un autre fait, même à sa case, ne la montre pas.
    occupied.add(6, 1, size);
    occupied.update([{ ...appeared(6, 1), kind: 'groupSplit' }], size);
    expect(spawnTarget(layers, size, 6, 1, testData, occupied)).toEqual(OCCUPIED);
    // Une commande refusée par le worker, ou une autre partie, efface les apparitions en
    // attente ; une autre partie, aussi les groupes.
    occupied.refused();
    expect(spawnTarget(layers, size, 6, 1, testData, occupied)).toEqual({ x: 6, y: 1 });
    occupied.add(6, 1, size);
    occupied.reset();
    expect(spawnTarget(layers, size, 6, 1, testData, occupied)).toEqual({ x: 6, y: 1 });
    expect(spawnTarget(layers, size, 4, 2, testData, occupied)).toEqual({ x: 4, y: 2 });
  });

  it('lit les cases occupées sur les positions de chacun, à l’instant affiché et au dernier état reçu (ADR 0014)', () => {
    const { size, layers } = world();
    // Un groupe de deux sur la prairie (3, 2) ; l'un s'en écarte jusqu'en (4, 2). Au dernier
    // état reçu, une étape mène l'autre en (3, 3), qu'il n'a pas encore atteinte à l'écran.
    const members = [
      [3.5, 2.5],
      [4.2, 2.5],
    ];
    const frame: GroupsFrame = {
      groups: Uint32Array.of(1, 3, 2, 2, 1),
      slots: Uint32Array.of(0, 1),
      ids: Uint32Array.of(1, 2),
      sprites: new Uint16Array(2),
      statures: new Uint8Array(2).fill(96),
      positions: Int32Array.from(members.flat().map((value) => Math.round(value * FIXED))),
      carriers: new Uint32Array(2).fill(NO_CARRIER),
      activities: new Uint8Array(2),
      legs: {
        slots: new Uint32Array(0),
        days: new Uint32Array(0),
        start: new Int32Array(0),
        step: new Int32Array(0),
        count: new Uint16Array(0),
        acts: new Uint8Array(0),
      },
    };
    const timeline = new CrowdTimeline({ carry: 0.2, passable: () => true });
    timeline.reset(frame, { tick: 0, day: 0 }, size.width);
    timeline.receive(
      { tick: 0, day: 2 },
      {
        slots: Uint32Array.of(0),
        days: Uint32Array.of(1),
        start: Int32Array.of(3.5 * FIXED, 2.5 * FIXED),
        step: Int32Array.of(0, FIXED),
        count: Uint16Array.of(1),
        acts: Uint8Array.of(0),
      },
      undefined,
    );
    timeline.show(0.5);
    const occupied = new OccupiedCells();
    occupied.setStanding(timeline.occupied(0.5, size));
    for (const [x, y] of [
      [3, 2],
      [4, 2],
      [3, 3],
    ] as const) {
      expect(spawnTarget(layers, size, x, y, testData, occupied)).toEqual(OCCUPIED);
    }
    expect(spawnTarget(layers, size, 5, 2, testData, occupied)).toEqual({ x: 5, y: 2 });
  });

  it('dispose la foule de ?crowd=N par groupes de vingt, sur des cases espacées autour du centre', () => {
    expect(CROWD_GROUP).toBe(20);
    expect(crowdGroups(2000, CROWD_GROUP, SPAWN_COUNT)).toEqual(new Array(100).fill(20));
    expect(crowdGroups(45, CROWD_GROUP, SPAWN_COUNT)).toEqual([20, 20, 5]);
    expect(crowdGroups(41, CROWD_GROUP, SPAWN_COUNT)).toEqual([21, 20]);
    const { size, layers } = world();
    const passable = (cell: number) => Number.isFinite(walkCost(layers, cell, testData));
    // Sur le petit monde de huit colonnes : toutes ses cases de terre, chacune une fois,
    // d'abord celles du centre, x ramené par la couture.
    const all = crowdCells({ x: 0, y: 2 }, 100, 1, size, passable);
    expect(all[0]).toEqual({ x: 0, y: 2 });
    expect(new Set(all.map(({ x, y }) => y * size.width + x)).size).toBe(all.length);
    expect(all.every(({ x, y }) => passable(y * size.width + x))).toBe(true);
    expect(all.length).toBe(Array.from({ length: 32 }, (_, cell) => cell).filter(passable).length);
    expect(all.some(({ x }) => x === 7)).toBe(true);
    // Espacées de deux en deux, et pas plus qu'il n'en faut.
    const spaced = crowdCells({ x: 3, y: 2 }, 3, 2, size, passable);
    expect(spaced).toHaveLength(3);
    for (const { x, y } of spaced) {
      expect(Math.abs(x - 3) % 2).toBe(0);
      expect(Math.abs(y - 2) % 2).toBe(0);
    }
  });
});
