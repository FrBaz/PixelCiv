import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, emptyLayers, WORLD_SIZES } from '../core/world';
import { cellIndex, createState, takeDirtyChunks } from './state';
import { applyCommand, fingerprint, step } from './step';
import { firstCellOf, testData, testParams, testState } from './testing';

const land = (family: string) => family !== 'water';

describe('cases', () => {
  it("bouclent d'est en ouest et n'existent pas au-delà des pôles", () => {
    const state = testState();
    const { width, height } = state.size;
    expect(cellIndex(state.size, -1, 10)).toBe(10 * width + width - 1);
    expect(cellIndex(state.size, width, 10)).toBe(10 * width);
    expect(cellIndex(state.size, 5, -1)).toBeUndefined();
    expect(cellIndex(state.size, 5, height)).toBeUndefined();
  });

  it('prennent la partie entière avant de boucler, et refusent un point non fini', () => {
    const state = testState();
    const { width } = state.size;
    expect(cellIndex(state.size, -1e-14, 4)).toBe(4 * width + width - 1);
    expect(cellIndex(state.size, 2.75, 6.5)).toBe(6 * width + 2);
    for (const x of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(cellIndex(state.size, x, 3)).toBeUndefined();
      expect(cellIndex(state.size, 3, x)).toBeUndefined();
    }
  });
});

describe('pinceau de biome', () => {
  it("change le biome d'une case de terre, et marque son bloc comme modifié", () => {
    const state = testState();
    const cell = firstCellOf(state, land);
    applyCommand(state, { type: 'paintBiome', ...cell, biome: 'desert' }, testData);
    const index = cell.y * state.size.width + cell.x;
    expect(state.world.biome[index]).toBe(testData.biomes.indexOf('desert'));
    const chunks = takeDirtyChunks(state);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.column).toBe(Math.floor(cell.x / CHUNK_SIZE));
    expect(chunks[0]?.biome[(cell.y % CHUNK_SIZE) * CHUNK_SIZE + (cell.x % CHUNK_SIZE)]).toBe(
      testData.biomes.indexOf('desert'),
    );
    expect(takeDirtyChunks(state)).toEqual([]);
  });

  it("laisse la mer et les lacs, et ne peint pas d'eau sur les terres", () => {
    const state = testState();
    const before = fingerprint(state);
    const sea = firstCellOf(state, (family) => family === 'water');
    const ground = firstCellOf(state, land);
    applyCommand(state, { type: 'paintBiome', ...sea, biome: 'desert' }, testData);
    applyCommand(state, { type: 'paintBiome', ...ground, biome: 'ocean' }, testData);
    applyCommand(state, { type: 'paintBiome', ...ground, biome: 'inconnu' }, testData);
    applyCommand(state, { type: 'paintBiome', x: 3, y: -4, biome: 'desert' }, testData);
    expect(fingerprint(state)).toBe(before);
    expect(takeDirtyChunks(state)).toEqual([]);
  });
});

describe('pas', () => {
  it('journalisent les commandes avec le pas où elles s’appliquent', () => {
    const state = testState();
    const cell = firstCellOf(state, land);
    step(state, [], testData);
    step(state, [{ type: 'paintBiome', ...cell, biome: 'steppe' }], testData);
    expect(state.tick).toBe(2);
    expect(state.commandLog).toEqual([
      { tick: 1, command: { type: 'paintBiome', ...cell, biome: 'steppe' } },
    ]);
  });

  it('donnent la même empreinte à la même graine, et une autre à une autre graine', () => {
    const a = testState('graine');
    const b = testState('graine');
    for (let tick = 0; tick < 5; tick++) {
      step(a, [], testData);
      step(b, [], testData);
    }
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(fingerprint(testState('autre'))).not.toBe(fingerprint(testState('graine')));
  });

  it("redonnent l'empreinte de référence d'un an de jeu (ADR 0003)", () => {
    // Un monde fixe, sans génération : l'empreinte ne dépend que de la simulation.
    const world = emptyLayers(WORLD_SIZES.small);
    world.biome.fill(testData.biomes.indexOf('steppe') ?? 0);
    world.elevation.fill(120);
    const state = createState(testParams('référence'), world, testData);
    step(state, [{ type: 'paintBiome', x: 10, y: 20, biome: 'desert' }], testData);
    for (let tick = 1; tick < 12; tick++) step(state, [], testData);
    expect(state.tick).toBe(12);
    // Empreinte de la phase 2 : l'état compte désormais la population, vide ici, et les
    // flux des systèmes, qui tournent chaque mois. Relecture de la phase 2 : une colonne de
    // plus, la langue du nom de famille.
    expect(fingerprint(state)).toBe('d7269069');
  });

  it("redonnent l'empreinte de référence de vingt ans d'une population (ADR 0003)", () => {
    // Le même monde fixe, et trois groupes : naissances, morts, couples, faim, marches,
    // scissions et fusions entrent dans l'empreinte, que les optimisations ne changent pas.
    const world = emptyLayers(WORLD_SIZES.small);
    world.biome.fill(testData.biomes.indexOf('steppe') ?? 0);
    world.elevation.fill(120);
    const state = createState(testParams('référence'), world, testData);
    const spawn = (x: number, y: number, subspecies: string) =>
      ({ type: 'spawnGroup', x, y, species: 'human', subspecies, count: 30 }) as const;
    step(
      state,
      [spawn(10, 60, 'plains'), spawn(30, 64, 'nordic'), spawn(505, 70, 'sands')],
      testData,
    );
    for (let tick = 1; tick < 240; tick++) step(state, [], testData);
    expect(state.people.count).toBeGreaterThan(40);
    // Relecture de la phase 2 : familles des groupes apparus, culture et nom à la
    // naissance (C2, D2), premier mois de vie, proches parents, mariages entre cultures.
    expect(fingerprint(state)).toBe('cbf85b43');
  });
});
