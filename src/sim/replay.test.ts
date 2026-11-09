import { describe, expect, it } from 'vitest';
import type { GameCommand } from '../core/protocol';
import { WORLD_SIZES } from '../core/world';
import { replay } from './replay';
import { createState } from './state';
import { fingerprint, step } from './step';

describe('replay', () => {
  it("redonne l'état d'une partie à partir de sa graine et de son journal", () => {
    const state = createState('graine', WORLD_SIZES.small);
    for (let tick = 0; tick < 40; tick++) {
      const commands: GameCommand[] =
        tick % 7 === 3
          ? [
              { type: 'paint', x: tick * 13, y: tick, value: tick },
              { type: 'paint', x: -tick, y: 200 - tick, value: 1 },
            ]
          : [];
      step(state, commands);
    }
    expect(state.commandLog.map((entry) => entry.tick)).toEqual([
      3, 3, 10, 10, 17, 17, 24, 24, 31, 31, 38, 38,
    ]);
    const replayed = replay(state.seed, state.size, state.commandLog, state.tick);
    expect(replayed.tick).toBe(40);
    expect(fingerprint(replayed)).toBe(fingerprint(state));
    expect(replayed.commandLog).toEqual(state.commandLog);
  });

  it("s'arrête au pas demandé", () => {
    const state = createState('graine', WORLD_SIZES.small);
    step(state, [{ type: 'paint', x: 0, y: 0, value: 9 }]);
    step(state, [{ type: 'paint', x: 1, y: 0, value: 9 }]);
    expect(replay(state.seed, state.size, state.commandLog, 1).commandLog).toHaveLength(1);
  });
});
