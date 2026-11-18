import { describe, expect, it } from 'vitest';
import { deltaX } from '../core/cylinder';
import { DAYS_PER_MONTH } from '../core/time';
import { walking, walkPosition, walkTotal } from '../core/walk';
import { advanceDay, step } from './day';
import { walk } from './groups';
import { createState, rebuildPositions, type SimState } from './state';
import { scatteredGroups, testData, testState } from './testing';
import { DayPositions, Walks } from './walks';

/** Cases franchissables du monde des tests, une sur `every`. */
function passableCells(state: SimState, every: number): { x: number; y: number }[] {
  const cells: { x: number; y: number }[] = [];
  const { width } = state.size;
  for (let cell = 0; cell < state.cost.length; cell += every) {
    if (Number.isFinite(state.cost[cell]))
      cells.push({ x: cell % width, y: Math.floor(cell / width) });
  }
  return cells;
}

/** Vérifie la forme d'une marche notée : cases voisines, coûts croissants depuis 0, sous le budget. */
function expectWellFormed(walks: Walks, index: number, width: number, cost: Float32Array): void {
  const start = index === 0 ? 0 : (walks.ends[index - 1] ?? 0);
  const end = walks.ends[index] ?? 0;
  expect(end - start).toBeGreaterThanOrEqual(2);
  expect(walks.costs[start]).toBe(0);
  for (let at = start + 1; at < end; at++) {
    const from = walks.cells[at - 1] ?? 0;
    const to = walks.cells[at] ?? 0;
    const dx = deltaX(from % width, to % width, width);
    const dy = Math.floor(to / width) - Math.floor(from / width);
    expect(Math.max(Math.abs(dx), Math.abs(dy))).toBe(1);
    // Le coût de chaque pas : celui de la case où l'on entre, fois √2 en diagonale.
    const step = (cost[to] ?? 0) * (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1);
    expect((walks.costs[at] ?? 0) - (walks.costs[at - 1] ?? 0)).toBeCloseTo(step, 9);
  }
  expect(walkTotal(walks, index)).toBeLessThanOrEqual(walks.budgets[index] ?? 0);
}

describe('marches notées (ADR 0013)', () => {
  it('walk note son chemin case par case, sans que son résultat change', () => {
    const state = testState();
    const cells = passableCells(state, 997);
    expect(cells.length).toBeGreaterThan(30);
    const walks = new Walks();
    let recorded = 0;
    cells.forEach((from, rank) => {
      const target = cells[(rank * 7 + 3) % cells.length] ?? from;
      const near = { x: (from.x + (rank % 21) - 10 + 512) % 512, y: from.y };
      for (const [goal, budget] of [
        [target, 36],
        [near, 24 + (rank % 13)],
        [from, 30],
      ] as const) {
        const plain = walk(state.cost, state.size, from, goal, budget);
        walks.begin(rank, from.y * 512 + from.x, budget);
        const noted = walk(state.cost, state.size, from, goal, budget, walks);
        walks.end();
        expect(noted).toEqual(plain);
        const moved = plain.x !== from.x || plain.y !== from.y;
        if (!moved) continue;
        // La marche gardée : de la case de départ à la case atteinte.
        const index = walks.count - 1;
        expect(walks.groups[index]).toBe(rank);
        const start = index === 0 ? 0 : (walks.ends[index - 1] ?? 0);
        expect(walks.cells[start]).toBe(from.y * 512 + from.x);
        expect(walks.cells[(walks.ends[index] ?? 0) - 1]).toBe(plain.y * 512 + plain.x);
        expectWellFormed(walks, index, 512, state.cost);
        recorded++;
      }
    });
    // Une marche sans pas ne se garde pas : autant de marches que de groupes partis.
    expect(walks.count).toBe(recorded);
    expect(recorded).toBeGreaterThan(30);
  });

  it('garde au pas mensuel une marche par groupe parti, qui finit sur sa case', () => {
    const state = testState();
    step(state, scatteredGroups(state, 60, 30), testData);
    for (let month = 0; month < 6; month++) {
      const before = new Map([...state.society.groups.values()].map((group) => [group.id, group]));
      const cells = new Map([...before.values()].map((group) => [group.id, [group.x, group.y]]));
      step(state, [], testData);
      const { walks } = state;
      const walked = new Set<number>();
      for (let index = 0; index < walks.count; index++) {
        const id = walks.groups[index] ?? 0;
        const group = state.society.groups.get(id);
        if (group === undefined) throw new Error(`marche d'un groupe inconnu : ${String(id)}`);
        expect(walked.has(id)).toBe(false);
        walked.add(id);
        expect(walks.cells[(walks.ends[index] ?? 0) - 1]).toBe(group.y * 512 + group.x);
        // Partie de la case où se tenait le groupe, ou, pour le nouveau groupe d'une scission,
        // de celle de son groupe d'origine.
        const start = index === 0 ? 0 : (walks.ends[index - 1] ?? 0);
        const origin = cells.get(id) ?? cells.get(group.parent);
        expect(walks.cells[start]).toBe((origin?.[1] ?? 0) * 512 + (origin?.[0] ?? 0));
        expectWellFormed(walks, index, 512, state.cost);
      }
      // Les groupes qui n'ont pas de marche n'ont pas bougé.
      for (const group of state.society.groups.values()) {
        if (walked.has(group.id)) continue;
        expect([group.x, group.y]).toEqual(cells.get(group.id) ?? cells.get(group.parent));
      }
      expect(walked.size).toBeGreaterThan(state.society.groups.size / 3);
    }
  });
});

describe('positions du jour (ADR 0013)', () => {
  it('ne recalcule chaque jour que les marches en cours, et redonne ce que donnerait un recalcul complet', () => {
    const state = testState();
    step(state, scatteredGroups(state, 60, 30), testData);
    step(state, [], testData);
    const { width } = state.size;
    const walkingAt = (day: number) => {
      let count = 0;
      for (let index = 0; index < state.walks.count; index++) {
        if (walking(state.walks, index, day)) count++;
      }
      return count;
    };
    // Au jour 0, chaque groupe se tient au départ de sa marche, ou au centre de sa case.
    const groups = [...state.society.groups.values()];
    const marching = new Map<number, number>();
    for (let index = 0; index < state.walks.count; index++) {
      marching.set(state.walks.groups[index] ?? 0, index);
    }
    groups.forEach((group, rank) => {
      const index = marching.get(group.id);
      const start = index === undefined || index === 0 ? 0 : (state.walks.ends[index - 1] ?? 0);
      const cell =
        index === undefined ? group.y * width + group.x : (state.walks.cells[start] ?? 0);
      expect(state.dayPositions.positions[rank * 2]).toBe((cell % width) + 0.5);
      expect(state.dayPositions.positions[rank * 2 + 1]).toBe(Math.floor(cell / width) + 0.5);
    });
    expect(state.dayPositions.walking).toBe(walkingAt(0));
    for (let day = 1; day < DAYS_PER_MONTH; day++) {
      advanceDay(state, [], testData);
      expect(state.day).toBe(day);
      // Les marches en cours, seules recalculées, diminuent jusqu'à la dernière arrivée.
      expect(state.dayPositions.walking).toBe(walkingAt(day));
      const fresh = new DayPositions();
      fresh.rebuild(state.society.groups.values(), state.walks, day, width);
      expect(state.dayPositions.positions).toEqual(fresh.positions);
      expect(fresh.walking).toBe(state.dayPositions.walking);
      groups.forEach((group, rank) => {
        const index = marching.get(group.id);
        const out = [0, 0];
        if (index === undefined) return;
        walkPosition(state.walks, index, day, width, out);
        expect(state.dayPositions.positionOf(group.id)).toEqual({ x: out[0], y: out[1] });
        expect(state.dayPositions.positions[rank * 2]).toBe(out[0]);
      });
    }
    expect(walkingAt(1)).toBeGreaterThan(state.society.groups.size / 3);
    // Le trentième jour, tous sont arrivés : le pas mensuel les trouve sur leur case.
    expect(walkingAt(DAYS_PER_MONTH)).toBe(0);
    const arrived = new DayPositions();
    arrived.rebuild(state.society.groups.values(), state.walks, DAYS_PER_MONTH, width);
    groups.forEach((group, rank) => {
      expect(arrived.positions[rank * 2]).toBe(group.x + 0.5);
      expect(arrived.positions[rank * 2 + 1]).toBe(group.y + 0.5);
    });
  });

  it('ignorent une marche dont le groupe n’existe plus, et se recalculent sans groupe', () => {
    const state = createState(testState().params, testState().world, testData);
    rebuildPositions(state);
    expect(state.dayPositions.positions).toHaveLength(0);
    state.walks.begin(42, 10, 30);
    state.walks.step(11, 1);
    state.walks.end();
    rebuildPositions(state);
    expect(state.dayPositions.walking).toBe(0);
    expect(state.dayPositions.positionOf(42)).toBeUndefined();
  });
});
