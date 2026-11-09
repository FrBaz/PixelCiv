import { describe, expect, it } from 'vitest';
import { readSave, SaveError, writeSave } from '../core/save/format';
import { WORLD_SIZES } from '../core/world';
import { restoreState, saveState } from './save';
import { createState } from './state';
import { fingerprint, step } from './step';

function played(ticks: number) {
  const state = createState('graine', WORLD_SIZES.small);
  for (let tick = 0; tick < ticks; tick++) {
    step(state, tick % 5 === 0 ? [{ type: 'paint', x: tick * 7, y: tick, value: 8 }] : []);
  }
  return state;
}

describe('sauvegarde de la simulation', () => {
  it("redonne exactement l'état sauvegardé", async () => {
    const state = played(30);
    const restored = restoreState(await readSave(await writeSave(saveState(state))));
    expect(fingerprint(restored)).toBe(fingerprint(state));
    expect(restored.commandLog).toEqual(state.commandLog);
  });

  it("se poursuit à l'identique après rechargement", async () => {
    const original = played(30);
    const restored = restoreState(await readSave(await writeSave(saveState(original))));
    for (let tick = 0; tick < 50; tick++) {
      step(original, []);
      step(restored, []);
    }
    expect(fingerprint(restored)).toBe(fingerprint(original));
  });

  it("n'est pas modifiée par la suite de la partie", () => {
    const state = played(3);
    const save = saveState(state);
    const before = Array.from(save.arrays.testLayer);
    step(state, [{ type: 'paint', x: 0, y: 0, value: 9 }]);
    expect(Array.from(save.arrays.testLayer)).toEqual(before);
  });

  it('refuse un état incohérent', () => {
    const save = saveState(played(3));
    const broken = (patch: object) => () => restoreState({ ...save, ...patch });
    expect(
      broken({ json: { ...(save.json as object), size: { width: 500, height: 256 } } }),
    ).toThrow(SaveError);
    expect(broken({ arrays: { ...save.arrays, walkerX: new Uint16Array(3) } })).toThrow(/walkerX/);
    expect(broken({ arrays: { ...save.arrays, testLayer: new Uint16Array(512 * 256) } })).toThrow(
      /testLayer/,
    );
    expect(
      broken({
        json: { ...(save.json as object), commandLog: [{ tick: 0, command: { type: 'feu' } }] },
      }),
    ).toThrow(SaveError);
  });
});
