import { beforeEach, describe, expect, it, vi } from 'vitest';
import { transferablesOf, type MainMessage, type WorkerMessage } from '../core/protocol';
import { MAX_SAVE_BYTES } from '../core/save/format';
import { notice } from '../ui/store';
import { AUTO_SLOT, MANUAL_SLOT, SaveManager, SaveStore, UNREADABLE_SLOT } from './saves';
import type { SimulationClient } from './simulation';

/** Comportement de la fausse base pour le prochain appel. */
const database = {
  /** Requêtes put : réussie ; refusée ; réussie, puis transaction annulée (quota, à la validation). */
  put: 'ok' as 'ok' | 'fail' | 'abort',
  get: 'ok' as 'ok' | 'fail',
  open: 'ok' as 'ok' | 'blocked',
  records: new Map<string, unknown>(),
};

const later = (callback: () => void) => setTimeout(callback, 0);

class FakeRequest extends EventTarget {
  result: unknown;
  error: DOMException | null = null;

  settle(result: unknown, error?: DOMException): this {
    later(() => {
      this.result = result;
      if (error === undefined) this.dispatchEvent(new Event('success'));
      else {
        this.error = error;
        this.dispatchEvent(new Event('error'));
      }
    });
    return this;
  }
}

class FakeTransaction extends EventTarget {
  error: DOMException | null = null;

  objectStore() {
    return {
      put: (record: { slot: string }) => {
        // Comme IndexedDB, la base copie l'enregistrement aussitôt : un tampon transféré
        // ailleurs, donc détaché, lève une DataCloneError.
        const copy = structuredClone(record);
        const request = new FakeRequest();
        if (database.put === 'fail') {
          request.settle(undefined, new DOMException('refus', 'UnknownError'));
          later(() => {
            this.finish('error', new DOMException('refus', 'UnknownError'));
          });
        } else {
          request.settle(record.slot);
          if (database.put === 'abort') {
            later(() => {
              this.finish('abort', new DOMException('plein', 'QuotaExceededError'));
            });
          } else {
            later(() => {
              database.records.set(copy.slot, copy);
              this.finish('complete');
            });
          }
        }
        return request;
      },
      get: (slot: string) =>
        database.get === 'fail'
          ? new FakeRequest().settle(undefined, new DOMException('perdue', 'UnknownError'))
          : new FakeRequest().settle(database.records.get(slot)),
    };
  }

  private finish(type: 'complete' | 'error' | 'abort', error?: DOMException): void {
    this.error = error ?? null;
    this.dispatchEvent(new Event(type));
  }
}

class FakeDatabase extends EventTarget {
  readonly objectStoreNames = { contains: () => true };
  transaction() {
    return new FakeTransaction();
  }
  close(): void {
    // Rien à libérer.
  }
}

Object.assign(globalThis, {
  indexedDB: {
    open: () => {
      const request = new FakeRequest();
      later(() => {
        if (database.open === 'blocked') request.dispatchEvent(new Event('blocked'));
        else {
          request.result = new FakeDatabase();
          request.dispatchEvent(new Event('success'));
        }
      });
      return request;
    },
  },
});

/** Faux worker : il répond aux requêtes de sauvegarde et de chargement comme on le lui dit. */
class FakeSimulation {
  saveReply: 'saved' | 'noGame' | 'failed' | 'silent' = 'saved';
  loadReply: WorkerMessage | 'silent' = { type: 'loaded', requestId: 0 };
  readonly sent: MainMessage[] = [];
  private listener: ((message: WorkerMessage) => void) | undefined;

  subscribe(listener: (message: WorkerMessage) => void): () => void {
    this.listener = listener;
    return () => undefined;
  }

  send(message: MainMessage): void {
    // Comme postMessage, le message est copié et ses tampons transférés : détachés ici.
    this.sent.push(structuredClone(message, { transfer: transferablesOf(message) }));
    const reply = (answer: WorkerMessage) => {
      later(() => this.listener?.(answer));
    };
    const answer = this.saveReply;
    if (message.type === 'save' && answer === 'saved') {
      const data = new ArrayBuffer(8);
      reply({ type: 'saved', requestId: message.requestId, meta: { seed: 's', tick: 1 }, data });
    } else if (message.type === 'save' && (answer === 'noGame' || answer === 'failed')) {
      reply({ type: 'saveFailed', requestId: message.requestId, reason: answer });
    } else if (message.type === 'load' && this.loadReply !== 'silent') {
      reply({ ...this.loadReply, requestId: message.requestId } as WorkerMessage);
    }
  }
}

async function manager() {
  const simulation = new FakeSimulation();
  const saves = new SaveManager(simulation as unknown as SimulationClient, await SaveStore.open());
  return { simulation, saves };
}

const shown = () => notice.value?.key;

beforeEach(() => {
  database.put = 'ok';
  database.get = 'ok';
  database.open = 'ok';
  database.records.clear();
  notice.value = undefined;
});

describe('sauvegarde manuelle', () => {
  it("n'annonce la réussite qu'une fois la transaction validée", async () => {
    const { saves } = await manager();
    await saves.save();
    expect(shown()).toBe('save.done');
    expect(database.records.has(MANUAL_SLOT)).toBe(true);
  });

  it('signale une transaction annulée après le succès de la requête', async () => {
    database.put = 'abort';
    const { saves } = await manager();
    await saves.save();
    expect(shown()).toBe('save.error.storage');
  });

  it('signale une écriture refusée, sans rejeter', async () => {
    database.put = 'fail';
    const { saves } = await manager();
    await expect(saves.save()).resolves.toBeUndefined();
    expect(shown()).toBe('save.error.storage');
  });

  it("dit qu'il n'y a pas de partie à sauvegarder", async () => {
    const { simulation, saves } = await manager();
    simulation.saveReply = 'noGame';
    await saves.save();
    expect(shown()).toBe('save.error.noGame');
  });

  it('dit que la sauvegarde a échoué dans le worker', async () => {
    const { simulation, saves } = await manager();
    simulation.saveReply = 'failed';
    await saves.save();
    expect(shown()).toBe('save.error.failed');
  });
});

describe('chargement', () => {
  it('signale un emplacement vide, ou illisible', async () => {
    const { saves } = await manager();
    await saves.load();
    expect(shown()).toBe('save.none');
    database.get = 'fail';
    await saves.load();
    expect(shown()).toBe('save.error.storage');
  });

  it('refuse un fichier trop gros sans le lire', async () => {
    const { simulation, saves } = await manager();
    let read = false;
    const file = {
      size: MAX_SAVE_BYTES + 1,
      arrayBuffer: () => {
        read = true;
        return Promise.resolve(new ArrayBuffer(0));
      },
    } as unknown as File;
    await saves.importFile(file);
    expect(shown()).toBe('save.error.size');
    expect(read).toBe(false);
    expect(simulation.sent).toEqual([]);
  });

  it("donne la raison d'un fichier refusé par le worker", async () => {
    const { simulation, saves } = await manager();
    simulation.loadReply = { type: 'loadFailed', requestId: 0, reason: 'obsolete' };
    await saves.importFile(new File([new Uint8Array(4)], 'ancien.pxcv'));
    expect(shown()).toBe('save.error.obsolete');
  });
});

describe('reprise au démarrage', () => {
  it('reprend la sauvegarde automatique', async () => {
    const { saves } = await manager();
    await saves.saveTo(AUTO_SLOT);
    await expect(saves.resume()).resolves.toBe(true);
    expect(shown()).toBeUndefined();
  });

  it("commence une partie sans rien dire quand il n'y a pas de sauvegarde", async () => {
    const { saves } = await manager();
    await expect(saves.resume()).resolves.toBe(false);
    expect(shown()).toBeUndefined();
  });

  it('ne lance pas de sauvegarde automatique sans stockage local', () => {
    const saves = new SaveManager(new FakeSimulation() as unknown as SimulationClient, undefined);
    const timers = vi.spyOn(globalThis, 'setInterval');
    try {
      saves.startAutosave();
      expect(timers).not.toHaveBeenCalled();
    } finally {
      timers.mockRestore();
    }
  });

  it('signale, sans parler de reprise, un stockage local indisponible', async () => {
    const saves = new SaveManager(new FakeSimulation() as unknown as SimulationClient, undefined);
    await expect(saves.resume()).resolves.toBe(false);
    expect(shown()).toBe('save.error.storage');
  });

  it('commence une partie, et le dit, quand la lecture échoue', async () => {
    database.get = 'fail';
    const { saves } = await manager();
    await expect(saves.resume()).resolves.toBe(false);
    expect(shown()).toBe('save.error.resume');
  });

  it('met de côté une sauvegarde illisible plutôt que de la laisser écraser', async () => {
    const { simulation, saves } = await manager();
    await saves.saveTo(AUTO_SLOT);
    simulation.loadReply = { type: 'loadFailed', requestId: 0, reason: 'version' };
    await expect(saves.resume()).resolves.toBe(false);
    expect(shown()).toBe('save.error.resume');
    expect(database.records.get(UNREADABLE_SLOT)).toMatchObject({ slot: UNREADABLE_SLOT });
  });
});

it('renonce au stockage local quand une autre page bloque la base', async () => {
  database.open = 'blocked';
  await expect(SaveStore.open()).rejects.toThrow(/bloquée/);
});
