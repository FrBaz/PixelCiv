/**
 * Sauvegardes côté fil principal (NF-05, ADR 0007) : emplacements dans IndexedDB,
 * sauvegarde automatique, export et import de fichiers. Le worker produit et relit
 * les fichiers ; ce module les range et les échange avec l'utilisateur.
 */
import type { WorkerMessage } from '../core/protocol';
import type { SaveErrorCode, SaveMeta } from '../core/save/format';
import { dateOfTick } from '../core/time';
import { t, type MessageKey } from '../i18n';
import { notice } from '../ui/store';
import type { SimulationClient } from './simulation';

export interface SaveRecord {
  readonly slot: string;
  /** Moment de la sauvegarde (heure de l'appareil, hors simulation). */
  readonly savedAt: string;
  readonly meta: SaveMeta;
  readonly data: ArrayBuffer;
}

const DB_NAME = 'pixelciv';
const DB_VERSION = 1;
const STORE = 'saves';

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => {
      resolve(request.result);
    });
    request.addEventListener('error', () => {
      reject(request.error ?? new Error('IndexedDB'));
    });
  });
}

function isRecord(value: unknown): value is SaveRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<SaveRecord>;
  return typeof record.slot === 'string' && record.data instanceof ArrayBuffer;
}

/** Emplacements de sauvegarde dans IndexedDB, un enregistrement par emplacement. */
export class SaveStore {
  private readonly db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.db = db;
  }

  static async open(): Promise<SaveStore> {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.addEventListener('upgradeneeded', () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: 'slot' });
      }
    });
    return new SaveStore(await done(request));
  }

  async put(record: SaveRecord): Promise<void> {
    await done(this.db.transaction(STORE, 'readwrite').objectStore(STORE).put(record));
  }

  async get(slot: string): Promise<SaveRecord | undefined> {
    const value: unknown = await done(this.db.transaction(STORE).objectStore(STORE).get(slot));
    return isRecord(value) ? value : undefined;
  }
}

/** Emplacements utilisés : la sauvegarde manuelle et la sauvegarde automatique. */
export const MANUAL_SLOT = 'manual';
export const AUTO_SLOT = 'auto';

/** Intervalle de la sauvegarde automatique, en millisecondes. */
const AUTOSAVE_MS = 30_000;

const LOAD_ERRORS: Readonly<Record<SaveErrorCode, MessageKey>> = {
  format: 'save.error.format',
  version: 'save.error.version',
  corrupt: 'save.error.corrupt',
};

type LoadResult = { readonly ok: true } | { readonly ok: false; readonly reason: SaveErrorCode };

/** Réponses du worker à une requête de sauvegarde ou de chargement. */
type SaveReply = Extract<WorkerMessage, { type: 'saved' | 'loaded' | 'loadFailed' }>;

/** Délai au-delà duquel une requête sans réponse est abandonnée, en millisecondes. */
const REPLY_TIMEOUT_MS = 15_000;

export class SaveManager {
  private readonly simulation: SimulationClient;
  private readonly store: SaveStore | undefined;
  private nextRequest = 1;
  private readonly waiting = new Map<number, (reply: SaveReply | undefined) => void>();

  constructor(simulation: SimulationClient, store: SaveStore | undefined) {
    this.simulation = simulation;
    this.store = store;
    simulation.subscribe((message) => {
      if (message.type === 'saved' || message.type === 'loaded' || message.type === 'loadFailed') {
        this.waiting.get(message.requestId)?.(message);
        this.waiting.delete(message.requestId);
      }
    });
  }

  /** Envoie une requête au worker et attend sa réponse, ou undefined après le délai. */
  private request(send: (requestId: number) => void): Promise<SaveReply | undefined> {
    const requestId = this.nextRequest++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(requestId);
        resolve(undefined);
      }, REPLY_TIMEOUT_MS);
      this.waiting.set(requestId, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      send(requestId);
    });
  }

  /** Demande au worker une sauvegarde de la partie en cours. */
  private async capture(): Promise<{ meta: SaveMeta; data: ArrayBuffer } | undefined> {
    const reply = await this.request((requestId) => {
      this.simulation.send({ type: 'save', requestId });
    });
    return reply?.type === 'saved' ? reply : undefined;
  }

  /** Remplace la partie par celle d'un fichier ; le worker la vérifie. */
  private async loadData(data: ArrayBuffer): Promise<LoadResult> {
    const reply = await this.request((requestId) => {
      this.simulation.send({ type: 'load', requestId, data });
    });
    if (reply?.type === 'loaded') return { ok: true };
    return { ok: false, reason: reply?.type === 'loadFailed' ? reply.reason : 'corrupt' };
  }

  async saveTo(slot: string): Promise<boolean> {
    if (this.store === undefined) return false;
    const captured = await this.capture();
    if (captured === undefined) return false;
    await this.store.put({ slot, savedAt: new Date().toISOString(), ...captured });
    return true;
  }

  async save(): Promise<void> {
    notice.value = (await this.saveTo(MANUAL_SLOT)) ? 'save.done' : 'save.error.storage';
  }

  /** Recharge un emplacement ; renvoie faux s'il est vide ou illisible. */
  async loadFrom(slot: string): Promise<boolean> {
    const record = await this.store?.get(slot);
    if (record === undefined) return false;
    return (await this.loadData(record.data)).ok;
  }

  async load(): Promise<void> {
    if (this.store === undefined) {
      notice.value = 'save.error.storage';
      return;
    }
    const record = await this.store.get(MANUAL_SLOT);
    if (record === undefined) {
      notice.value = 'save.none';
      return;
    }
    const result = await this.loadData(record.data);
    notice.value = result.ok ? 'save.loaded' : LOAD_ERRORS[result.reason];
  }

  /** Télécharge la partie en cours dans un fichier, pour la reprendre ailleurs. */
  async exportFile(): Promise<void> {
    const captured = await this.capture();
    if (captured === undefined) return;
    const { meta, data } = captured;
    const url = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = t('save.fileName', { year: dateOfTick(meta.tick).year });
    link.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
    notice.value = 'save.exported';
  }

  async importFile(file: File): Promise<void> {
    const result = await this.loadData(await file.arrayBuffer());
    notice.value = result.ok ? 'save.loaded' : LOAD_ERRORS[result.reason];
  }

  /** Sauvegarde automatique : à intervalle régulier, et quand la page passe en arrière-plan. */
  startAutosave(): void {
    const autosave = () => {
      void this.saveTo(AUTO_SLOT);
    };
    setInterval(autosave, AUTOSAVE_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') autosave();
    });
  }
}
