import { describe, expect, it } from 'vitest';
import type { GameCommand } from '../core/protocol';
import { CHUNK_SIZE, WORLD_SIZES } from '../core/world';
import { allChunks, createState, setTestCell, takeDirtyChunks, testCell } from './state';
import { fingerprint, step } from './step';

const size = WORLD_SIZES.small;

describe('couche de test', () => {
  it("boucle d'est en ouest et ignore les cases hors du monde au nord et au sud", () => {
    const state = createState('graine', size);
    expect(setTestCell(state, -1, 10, 7)).toBe(true);
    expect(testCell(state, size.width - 1, 10)).toBe(7);
    expect(testCell(state, -1, 10)).toBe(7);
    expect(setTestCell(state, 5, -1, 7)).toBe(false);
    expect(setTestCell(state, 5, size.height, 7)).toBe(false);
    expect(testCell(state, 5, size.height)).toBe(0);
  });

  it('borne les valeurs et ne signale que les vrais changements', () => {
    const state = createState('graine', size);
    expect(setTestCell(state, 3, 3, 300)).toBe(true);
    expect(testCell(state, 3, 3)).toBe(255);
    expect(setTestCell(state, 3, 3, 255)).toBe(false);
  });
});

describe('blocs', () => {
  it('découpent le monde en blocs de 64 × 64 cases', () => {
    const state = createState('graine', size);
    const chunks = allChunks(state);
    expect(chunks).toHaveLength(8 * 4);
    expect(chunks.every((chunk) => chunk.cells.length === CHUNK_SIZE * CHUNK_SIZE)).toBe(true);
  });

  it('ne renvoient que les blocs modifiés, une seule fois', () => {
    const state = createState('graine', size);
    setTestCell(state, 65, 1, 9);
    setTestCell(state, 66, 2, 9);
    setTestCell(state, 511, 255, 4);
    const dirty = takeDirtyChunks(state);
    expect(dirty.map((chunk) => [chunk.column, chunk.row])).toEqual([
      [1, 0],
      [7, 3],
    ]);
    expect(dirty.at(0)?.cells[1 * CHUNK_SIZE + 1]).toBe(9);
    expect(dirty.at(1)?.cells[63 * CHUNK_SIZE + 63]).toBe(4);
    expect(takeDirtyChunks(state)).toEqual([]);
  });
});

describe('pas', () => {
  const commands: GameCommand[][] = [
    [{ type: 'paint', x: 1, y: 1, value: 1 }],
    [],
    [
      { type: 'paint', x: -3, y: 100, value: 2 },
      { type: 'paint', x: 700, y: 40, value: 3 },
    ],
  ];

  const run = () => {
    const state = createState('graine', size);
    for (const batch of commands) step(state, batch);
    return state;
  };

  it('applique les commandes puis avance le temps', () => {
    const state = run();
    expect(state.tick).toBe(3);
    expect(testCell(state, size.width - 3, 100)).toBe(2);
    expect(testCell(state, 700 - size.width, 40)).toBe(3);
  });

  it('donnent toujours la même empreinte (déterminisme)', () => {
    expect(fingerprint(run())).toBe(fingerprint(run()));
    // Valeur recalculée indépendamment (FNV-1a en Python sur les mêmes octets).
    expect(fingerprint(run())).toBe('2ed12715');
  });
});
