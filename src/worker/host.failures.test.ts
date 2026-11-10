/**
 * Défaillances imprévues de l'hôte (ADR 0004) : une copie de couches qui échoue, faute de
 * mémoire par exemple. Chaque requête de sauvegarde ou de chargement reçoit tout de même
 * sa réponse, et la partie en cours continue.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type WorkerMessage } from '../core/protocol';
import { testData, testParams, testWorld } from '../sim/testing';
import { SimulationHost, type HostEnvironment } from './host';

const failures = vi.hoisted(() => ({ copy: false, save: false }));

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

vi.mock('../sim/save', async (importOriginal) => {
  const original = await importOriginal<typeof import('../sim/save')>();
  return {
    ...original,
    saveState: (...args: Parameters<typeof original.saveState>) => {
      if (failures.save) throw new RangeError('mémoire épuisée');
      return original.saveState(...args);
    },
  };
});

class Environment implements HostEnvironment {
  readonly messages: WorkerMessage[] = [];
  post(message: WorkerMessage): void {
    this.messages.push(message);
  }
  now(): number {
    return 0;
  }
  setTimer(): number {
    return 1;
  }
  clearTimer(): void {
    // Les pas ne comptent pas ici.
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
