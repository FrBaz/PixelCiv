/**
 * Défaillances de l'hôte (ADR 0004) : une copie de couches qui échoue, faute de mémoire
 * par exemple, une partie devenue trop grande pour le format, ou un mois de simulation en
 * défaut. Chaque requête de sauvegarde ou de chargement reçoit tout de même sa réponse, et
 * la partie en cours continue.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '../core/protocol';
import { MAX_SAVE_BYTES } from '../core/save/format';
import { DAYS_PER_MONTH, monthDuration, NORMAL_DAY_MS, NORMAL_MONTH_MS } from '../core/time';
import { testData, testParams, testWorld } from '../sim/testing';
import { SimulationHost } from './host';
import { FakeEnvironment, WAKE_SLACK_MS } from './testing';

const failures = vi.hoisted(() => ({ copy: false, save: false, huge: false, step: false }));

vi.mock('../core/world', async (importOriginal) => {
  const original = await importOriginal<typeof import('../core/world')>();
  return {
    ...original,
    copyLayers: (layers: Parameters<typeof original.copyLayers>[0]) => {
      if (failures.copy) throw new RangeError('mémoire épuisée');
      return original.copyLayers(layers);
    },
  };
});

vi.mock('../sim/step', async (importOriginal) => {
  const original = await importOriginal<typeof import('../sim/step')>();
  return {
    ...original,
    monthStep: (...args: Parameters<typeof original.monthStep>) => {
      if (failures.step) throw new TypeError('défaut du mois');
      return original.monthStep(...args);
    },
  };
});

vi.mock('../sim/save', async (importOriginal) => {
  const original = await importOriginal<typeof import('../sim/save')>();
  return {
    ...original,
    saveState: (...args: Parameters<typeof original.saveState>) => {
      if (failures.save) throw new RangeError('mémoire épuisée');
      const save = original.saveState(...args);
      // Une partie dont les tableaux dépassent ce que la lecture admet : des zéros, que le
      // système ne réserve vraiment qu'une fois écrits, et le format refuse d'écrire.
      if (failures.huge) {
        return { ...save, arrays: { ...save.arrays, filler: new Uint8Array(MAX_SAVE_BYTES) } };
      }
      return save;
    },
  };
});

async function playing() {
  const env = new FakeEnvironment();
  const host = new SimulationHost(env, testData, (params) => testWorld(params.seed));
  host.receive({ type: 'hello', protocol: PROTOCOL_VERSION });
  host.receive({ type: 'newGame', params: testParams('a') });
  await host.idle();
  return { env, host };
}

/** Instant (mois, jour) du dernier delta. */
function lastTime(env: FakeEnvironment): [number, number] | undefined {
  const time = env.messages('delta').at(-1)?.time;
  return time === undefined ? undefined : [time.tick, time.day];
}

describe("défaillances de l'hôte", () => {
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  afterEach(() => {
    failures.copy = false;
    failures.save = false;
    failures.huge = false;
    failures.step = false;
  });

  it('signale un pas mensuel en défaut, et le refait un mois de jeu plus tard (L-2)', async () => {
    const { env, host } = await playing();
    env.advance(NORMAL_DAY_MS * (DAYS_PER_MONTH - 1) + WAKE_SLACK_MS);
    expect(lastTime(env)).toEqual([0, DAYS_PER_MONTH - 1]);
    failures.step = true;
    env.advance(NORMAL_DAY_MS);
    expect(env.messages('error').map((error) => error.code)).toEqual(['internal']);
    // Le jour reste le dernier du mois ; aucun delta, la partie ne se fige pas pour autant.
    expect(lastTime(env)).toEqual([0, DAYS_PER_MONTH - 1]);
    env.advance(NORMAL_MONTH_MS - 1);
    expect(env.messages('error')).toHaveLength(1);
    // Le défaut passé, le pas mensuel se refait à l'échéance, un mois de jeu plus tard.
    failures.step = false;
    env.advance(1 + WAKE_SLACK_MS);
    expect(lastTime(env)).toEqual([1, 0]);
    expect(env.messages('stats').at(-1)?.stats.monthMs).toBeDefined();
    // Le jour demandé en pause ne lève rien non plus.
    host.receive({ type: 'setPaused', paused: true });
    for (let day = 1; day < DAYS_PER_MONTH; day++) host.receive({ type: 'stepOnce' });
    failures.step = true;
    expect(() => {
      host.receive({ type: 'stepOnce' });
    }).not.toThrow();
    expect(env.messages('error').map((error) => error.code)).toEqual(['internal', 'internal']);
    expect(lastTime(env)).toEqual([1, DAYS_PER_MONTH - 1]);
    quiet.mockClear();
  });

  it('ne signale un défaut persistant du pas mensuel qu’une fois par mois de jeu, à ×1 comme à ×16', async () => {
    for (const speed of ['normal', 'faster'] as const) {
      const { env, host } = await playing();
      host.receive({ type: 'setSpeed', speed });
      failures.step = true;
      // Six mois de temps réel : un pas mensuel tenté par mois, chacun en défaut.
      env.advance(6 * monthDuration(speed) + 1);
      const errors = env.timed('error');
      expect(
        errors.map(({ message }) => message.code),
        speed,
      ).toEqual(errors.map(() => 'internal'));
      expect(errors.length, speed).toBeGreaterThanOrEqual(5);
      expect(errors.length, speed).toBeLessThanOrEqual(6);
      for (let index = 1; index < errors.length; index++) {
        const gap = (errors[index]?.at ?? 0) - (errors[index - 1]?.at ?? 0);
        expect(gap, speed).toBeGreaterThanOrEqual(monthDuration(speed) - 1e-6);
      }
      // La partie n'avance pas au-delà du dernier jour du mois, mais ne se fige pas.
      expect(lastTime(env), speed).toEqual([0, DAYS_PER_MONTH - 1]);
      failures.step = false;
      env.advance(monthDuration(speed));
      expect(lastTime(env)?.[0], speed).toBe(1);
      host.receive({ type: 'setPaused', paused: true });
    }
    quiet.mockClear();
  });

  it("refuse d'écrire une partie que la lecture refuserait, et le dit", async () => {
    const { env, host } = await playing();
    failures.huge = true;
    host.receive({ type: 'save', requestId: 5 });
    await host.idle();
    // Jamais « saved » suivi d'un chargement impossible : la requête échoue, avec sa raison.
    expect(env.messages('saved')).toEqual([]);
    expect(env.messages('saveFailed')).toEqual([
      { type: 'saveFailed', requestId: 5, reason: 'size' },
    ]);
    expect(env.messages('error')).toEqual([]);
    // La partie continue, et se sauvegarde de nouveau une fois revenue dans les bornes.
    failures.huge = false;
    host.receive({ type: 'save', requestId: 6 });
    await host.idle();
    expect(env.messages('saved').map((saved) => saved.requestId)).toEqual([6]);
  });

  it('répond à une sauvegarde dont la capture échoue', async () => {
    const { env, host } = await playing();
    failures.save = true;
    host.receive({ type: 'save', requestId: 7 });
    await host.idle();
    expect(env.messages('saveFailed')).toEqual([
      { type: 'saveFailed', requestId: 7, reason: 'failed' },
    ]);
    expect(env.messages('error').at(0)?.code).toBe('internal');
  });

  it("répond à un chargement dont l'instantané échoue, et garde la partie en cours", async () => {
    const { env, host } = await playing();
    host.receive({ type: 'save', requestId: 1 });
    await host.idle();
    const file = env.messages('saved').at(0);
    expect(file).toBeDefined();
    if (file === undefined) return;
    failures.copy = true;
    host.receive({ type: 'load', requestId: 2, data: file.data });
    await host.idle();
    expect(env.messages('loadFailed').at(0)).toMatchObject({ requestId: 2 });
    expect(env.messages('loaded')).toEqual([]);
    expect(env.messages('snapshot')).toHaveLength(1);
    // La partie en cours reste celle de la graine « a ».
    failures.copy = false;
    host.receive({ type: 'save', requestId: 3 });
    await host.idle();
    expect(env.messages('saved').at(-1)?.meta.seed).toBe('a');
    quiet.mockClear();
  });
});
