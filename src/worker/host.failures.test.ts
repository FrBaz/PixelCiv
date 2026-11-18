/**
 * Défaillances de l'hôte (ADR 0004) : une copie de couches qui échoue, faute de mémoire
 * par exemple, une partie devenue trop grande pour le format, ou un mois de simulation en
 * défaut. Chaque requête de sauvegarde ou de chargement reçoit tout de même sa réponse, et
 * la partie en cours continue.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type WorkerMessage } from '../core/protocol';
import { MAX_SAVE_BYTES } from '../core/save/format';
import { testData, testParams, testWorld } from '../sim/testing';
import { SimulationHost, type HostEnvironment } from './host';

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
    step: (...args: Parameters<typeof original.step>) => {
      if (failures.step) throw new TypeError('défaut du mois');
      return original.step(...args);
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

class Environment implements HostEnvironment {
  readonly messages: WorkerMessage[] = [];
  /** Le prochain pas programmé, que le test déclenche quand il veut. */
  private timer: (() => void) | undefined;
  post(message: WorkerMessage): void {
    this.messages.push(message);
  }
  now(): number {
    return 0;
  }
  setTimer(callback: () => void): number {
    this.timer = callback;
    return 1;
  }
  clearTimer(): void {
    this.timer = undefined;
  }
  /** Fait venir le pas programmé ; faux s'il n'y en a pas. */
  fire(): boolean {
    const timer = this.timer;
    this.timer = undefined;
    timer?.();
    return timer !== undefined;
  }
  of<T extends WorkerMessage['type']>(type: T): Extract<WorkerMessage, { type: T }>[] {
    return this.messages.filter(
      (message): message is Extract<WorkerMessage, { type: T }> => message.type === type,
    );
  }
}

async function playing() {
  const env = new Environment();
  const host = new SimulationHost(env, testData, (params) => testWorld(params.seed));
  host.receive({ type: 'hello', protocol: PROTOCOL_VERSION });
  host.receive({ type: 'newGame', params: testParams('a') });
  await host.idle();
  return { env, host };
}

describe("défaillances de l'hôte", () => {
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  afterEach(() => {
    failures.copy = false;
    failures.save = false;
    failures.huge = false;
    failures.step = false;
  });

  it('signale un mois en défaut, et passe au suivant sans figer la partie (L-2)', async () => {
    const { env, host } = await playing();
    failures.step = true;
    expect(env.fire()).toBe(true);
    expect(env.of('error').map((error) => error.code)).toEqual(['internal']);
    expect(env.of('delta')).toEqual([]);
    // Le pas suivant est programmé : la partie reprend dès que le défaut cesse.
    failures.step = false;
    expect(env.fire()).toBe(true);
    expect(env.of('delta').map((delta) => delta.time.tick)).toEqual([1]);
    expect(env.of('stats')).toHaveLength(1);
    // Le pas demandé en pause ne lève rien non plus.
    host.receive({ type: 'setPaused', paused: true });
    failures.step = true;
    expect(() => {
      host.receive({ type: 'stepOnce' });
    }).not.toThrow();
    expect(env.of('error').map((error) => error.code)).toEqual(['internal', 'internal']);
    quiet.mockClear();
  });

  it("refuse d'écrire une partie que la lecture refuserait, et le dit", async () => {
    const { env, host } = await playing();
    failures.huge = true;
    host.receive({ type: 'save', requestId: 5 });
    await host.idle();
    // Jamais « saved » suivi d'un chargement impossible : la requête échoue, avec sa raison.
    expect(env.of('saved')).toEqual([]);
    expect(env.of('saveFailed')).toEqual([{ type: 'saveFailed', requestId: 5, reason: 'size' }]);
    expect(env.of('error')).toEqual([]);
    // La partie continue, et se sauvegarde de nouveau une fois revenue dans les bornes.
    failures.huge = false;
    host.receive({ type: 'save', requestId: 6 });
    await host.idle();
    expect(env.of('saved').map((saved) => saved.requestId)).toEqual([6]);
  });

  it('répond à une sauvegarde dont la capture échoue', async () => {
    const { env, host } = await playing();
    failures.save = true;
    host.receive({ type: 'save', requestId: 7 });
    await host.idle();
    expect(env.of('saveFailed')).toEqual([{ type: 'saveFailed', requestId: 7, reason: 'failed' }]);
    expect(env.of('error').at(0)?.code).toBe('internal');
  });

  it("répond à un chargement dont l'instantané échoue, et garde la partie en cours", async () => {
    const { env, host } = await playing();
    host.receive({ type: 'save', requestId: 1 });
    await host.idle();
    const file = env.of('saved').at(0);
    expect(file).toBeDefined();
    if (file === undefined) return;
    failures.copy = true;
    host.receive({ type: 'load', requestId: 2, data: file.data });
    await host.idle();
    expect(env.of('loadFailed').at(0)).toMatchObject({ requestId: 2 });
    expect(env.of('loaded')).toEqual([]);
    expect(env.of('snapshot')).toHaveLength(1);
    // La partie en cours reste celle de la graine « a ».
    failures.copy = false;
    host.receive({ type: 'save', requestId: 3 });
    await host.idle();
    expect(env.of('saved').at(-1)?.meta.seed).toBe('a');
    quiet.mockClear();
  });
});
