import { describe, expect, it } from 'vitest';
import {
  encodeSave,
  readSave,
  SAVE_FORMAT_VERSION,
  SaveError,
  writeSave,
} from '../core/save/format';
import { WORLD_SIZES } from '../core/world';
import { MIGRATIONS, restoreState, saveState } from './save';
import { createState, WALKER_STREAM } from './state';
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
    const restored = restoreState(await readSave(await writeSave(saveState(state)), MIGRATIONS));
    expect(fingerprint(restored)).toBe(fingerprint(state));
    expect(restored.commandLog).toEqual(state.commandLog);
  });

  it("se poursuit à l'identique après rechargement", async () => {
    const original = played(30);
    const restored = restoreState(await readSave(await writeSave(saveState(original)), MIGRATIONS));
    for (let tick = 0; tick < 50; tick++) {
      step(original, []);
      step(restored, []);
    }
    expect(fingerprint(restored)).toBe(fingerprint(original));
  });

  it("n'est pas modifiée par la suite de la partie", () => {
    const state = played(3);
    state.pending.push({ type: 'paint', x: 5, y: 5, value: 4 });
    const save = saveState(state);
    const before = JSON.stringify({ json: save.json, layer: Array.from(save.arrays.testLayer) });
    step(state, state.pending.splice(0));
    step(state, [{ type: 'paint', x: 0, y: 0, value: 9 }]);
    expect(JSON.stringify({ json: save.json, layer: Array.from(save.arrays.testLayer) })).toBe(
      before,
    );
  });

  it("garde les commandes en attente, qui s'appliquent après rechargement", async () => {
    const original = played(4);
    original.pending.push({ type: 'paint', x: 9, y: 9, value: 6 });
    const restored = restoreState(await readSave(await writeSave(saveState(original)), MIGRATIONS));
    expect(restored.pending).toEqual(original.pending);
    step(original, original.pending.splice(0));
    step(restored, restored.pending.splice(0));
    expect(fingerprint(restored)).toBe(fingerprint(original));
  });

  it('migre une sauvegarde de la version 1, sans commandes en attente', async () => {
    const current = saveState(played(6));
    const { pending: _pending, ...json } = current.json as Record<string, unknown>;
    const old = encodeSave({ ...current, json }, 1);
    const restored = restoreState(await readSave(old, MIGRATIONS));
    expect(restored.pending).toEqual([]);
    expect(fingerprint(restored)).toBe(fingerprint(played(6)));
  });

  it('refuse vite, sans épuiser la mémoire, un journal forgé de millions de commandes', () => {
    const save = saveState(played(3));
    const forged = {
      ...save,
      json: { ...(save.json as object), commandLog: new Array(2_000_000).fill({}) },
    };
    const start = performance.now();
    expect(() => restoreState(forged)).toThrow(SaveError);
    // Une validation de la liste entière relèverait 4 millions d'erreurs : plusieurs secondes.
    expect(performance.now() - start).toBeLessThan(3000);
  });

  it('rend un état qui ne partage rien avec la sauvegarde', () => {
    const save = saveState(played(5));
    const first = restoreState(save);
    const second = restoreState(save);
    expect(first.walkerX).not.toBe(second.walkerX);
    const before = fingerprint(second);
    for (let tick = 0; tick < 3; tick++) step(first, []);
    expect(fingerprint(second)).toBe(before);
  });

  it('a une migration pour chaque version antérieure', () => {
    for (let version = 1; version < SAVE_FORMAT_VERSION; version++) {
      expect(MIGRATIONS[version], `version ${version}`).toBeTypeOf('function');
    }
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

  it('refuse des champs incohérents entre eux', () => {
    const save = saveState(played(12));
    const json = save.json as Record<string, unknown>;
    const paint = { type: 'paint', x: 1, y: 1, value: 2 };
    const rng = json.rng as Record<string, unknown>;
    const cases: [string, object][] = [
      ['taille inconnue', { json: { ...json, size: { width: 16384, height: 8192 } } }],
      [
        'promeneur hors du monde',
        { arrays: { ...save.arrays, walkerY: new Uint16Array(12).fill(60000) } },
      ],
      ['commande future', { json: { ...json, commandLog: [{ tick: 12, command: paint }] } }],
      [
        'journal désordonné',
        {
          json: {
            ...json,
            commandLog: [
              { tick: 5, command: paint },
              { tick: 2, command: paint },
            ],
          },
        },
      ],
      [
        'état du générateur nul',
        { json: { ...json, rng: { ...rng, [WALKER_STREAM]: [0, 0, 0, 0] } } },
      ],
      ['flux des promeneurs absent', { json: { ...json, rng: {} } }],
      ['commande en attente invalide', { json: { ...json, pending: [{ ...paint, x: 0.5 }] } }],
    ];
    for (const [label, patch] of cases) {
      expect(() => restoreState({ ...save, ...patch }), label).toThrow(SaveError);
    }
  });
});
