/**
 * Sauvegardes côté fil principal (NF-05, ADR 0007) : emplacements dans IndexedDB,
 * sauvegarde automatique, export et import de fichiers. Le worker produit et relit
 * les fichiers ; ce module les range et les échange avec l'utilisateur.
 *
 * Chaque action du joueur se conclut par un avis, et une écriture ne compte qu'une
 * fois la transaction d'IndexedDB validée. La sauvegarde automatique reste discrète :
 * elle signale une fois chaque sorte d'échec durable (stockage indisponible, partie trop
 * grande pour le format, écriture impossible), et note les autres dans la console.
 */
import type { WorkerMessage } from '../core/protocol';
import { MAX_SAVE_BYTES, type SaveErrorCode, type SaveMeta } from '../core/save/format';
import { dateOfTick } from '../core/time';
import { t, type MessageKey } from '../i18n';
import { showNotice } from '../ui/store';
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

/** Fin d'une transaction : validée, ou annulée (quota dépassé, erreur…). */
function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => {
      resolve();
    });
    for (const type of ['error', 'abort'] as const) {
      transaction.addEventListener(type, () => {
        reject(transaction.error ?? new Error(`IndexedDB : transaction ${type}`));
      });
    }
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
    // Une page plus récente veut changer la base : celle-ci lui cède la place.
    db.addEventListener('versionchange', () => {
      db.close();
    });
  }

  static open(): Promise<SaveStore> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      let settled = false;
      request.addEventListener('upgradeneeded', () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE, { keyPath: 'slot' });
        }
      });
      request.addEventListener('success', () => {
        // Ouverte après avoir renoncé (voir « blocked ») : elle ne servira pas.
        if (settled) request.result.close();
        else resolve(new SaveStore(request.result));
        settled = true;
      });
      request.addEventListener('error', () => {
        settled = true;
        reject(request.error ?? new Error('IndexedDB'));
      });
      // Une autre page tient la base dans une version plus ancienne : le jeu démarre
      // sans sauvegarde locale plutôt que d'attendre qu'elle se ferme.
      request.addEventListener('blocked', () => {
        settled = true;
        reject(new Error('IndexedDB bloquée par une autre page'));
      });
    });
  }

  async put(record: SaveRecord): Promise<void> {
    const transaction = this.db.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).put(record);
    await completed(transaction);
  }

  async get(slot: string): Promise<SaveRecord | undefined> {
    const value: unknown = await done(this.db.transaction(STORE).objectStore(STORE).get(slot));
    return isRecord(value) ? value : undefined;
  }
}

/** Emplacements utilisés : la sauvegarde manuelle et la sauvegarde automatique. */
export const MANUAL_SLOT = 'manual';
export const AUTO_SLOT = 'auto';
/** Sauvegarde automatique illisible, mise de côté plutôt qu'écrasée. */
export const UNREADABLE_SLOT = 'auto-unreadable';

/** Intervalle de la sauvegarde automatique, en millisecondes. */
const AUTOSAVE_MS = 30_000;

const LOAD_ERRORS: Readonly<Record<SaveErrorCode, MessageKey>> = {
  format: 'save.error.format',
  version: 'save.error.version',
  obsolete: 'save.error.obsolete',
  corrupt: 'save.error.corrupt',
  size: 'save.error.size',
};

/** Réponses du worker à une requête de sauvegarde ou de chargement. */
type SaveReply = Extract<WorkerMessage, { type: 'saved' | 'saveFailed' | 'loaded' | 'loadFailed' }>;

/** Partie capturée par le worker, ou raison de l'échec. */
type Capture =
  | { readonly status: 'saved'; readonly meta: SaveMeta; readonly data: ArrayBuffer }
  | { readonly status: 'noGame' }
  | { readonly status: 'size' }
  | { readonly status: 'failed' }
  | { readonly status: 'timeout' };

/** Issue d'une sauvegarde dans un emplacement : l'avis à montrer. */
type SaveOutcome =
  | 'save.done'
  | 'save.error.noGame'
  | 'save.error.tooBig'
  | 'save.error.failed'
  | 'save.error.timeout'
  | 'save.error.storage';

/**
 * Avis d'une capture manquée. Une partie trop grande pour le format n'est écrite nulle
 * part : l'emplacement garde sa sauvegarde précédente.
 */
const CAPTURE_ERRORS = {
  noGame: 'save.error.noGame',
  size: 'save.error.tooBig',
  failed: 'save.error.failed',
  timeout: 'save.error.timeout',
} as const satisfies Record<Exclude<Capture['status'], 'saved'>, MessageKey>;

/**
 * Échecs de la sauvegarde automatique que le joueur apprend, une fois chacun : ils se
 * répéteraient à chaque essai. Un délai dépassé est passager ; sans partie, rien n'est à
 * sauvegarder.
 */
const LASTING_FAILURES: ReadonlySet<SaveOutcome> = new Set([
  'save.error.storage',
  'save.error.tooBig',
  'save.error.failed',
]);

/** Issue d'un chargement : partie chargée, emplacement vide, ou avis d'erreur. */
type LoadOutcome =
  | { readonly status: 'loaded' }
  | { readonly status: 'empty' }
  | { readonly status: 'failed'; readonly notice: MessageKey; readonly record?: SaveRecord };

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
      if (
        message.type === 'saved' ||
        message.type === 'saveFailed' ||
        message.type === 'loaded' ||
        message.type === 'loadFailed'
      ) {
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
  private async capture(): Promise<Capture> {
    const reply = await this.request((requestId) => {
      this.simulation.send({ type: 'save', requestId });
    });
    if (reply?.type === 'saved') return { status: 'saved', meta: reply.meta, data: reply.data };
    if (reply?.type === 'saveFailed') return { status: reply.reason };
    return { status: 'timeout' };
  }

  /** Remplace la partie par celle d'un fichier ; le worker la vérifie. */
  private async loadData(data: ArrayBuffer): Promise<MessageKey | undefined> {
    const reply = await this.request((requestId) => {
      this.simulation.send({ type: 'load', requestId, data });
    });
    if (reply?.type === 'loaded') return undefined;
    return reply?.type === 'loadFailed' ? LOAD_ERRORS[reply.reason] : 'save.error.timeout';
  }

  /** Sauvegarde la partie dans un emplacement, et dit comment cela s'est passé. */
  async saveTo(slot: string): Promise<SaveOutcome> {
    const store = this.store;
    if (store === undefined) return 'save.error.storage';
    const captured = await this.capture();
    if (captured.status !== 'saved') return CAPTURE_ERRORS[captured.status];
    try {
      await store.put({
        slot,
        savedAt: new Date().toISOString(),
        meta: captured.meta,
        data: captured.data,
      });
    } catch (error) {
      console.warn('sauvegarde', error);
      return 'save.error.storage';
    }
    return 'save.done';
  }

  async save(): Promise<void> {
    showNotice(await this.saveTo(MANUAL_SLOT));
  }

  /** Recharge un emplacement. */
  async loadFrom(slot: string): Promise<LoadOutcome> {
    if (this.store === undefined) return { status: 'failed', notice: 'save.error.storage' };
    let record: SaveRecord | undefined;
    try {
      record = await this.store.get(slot);
    } catch (error) {
      console.warn('lecture de sauvegarde', error);
      return { status: 'failed', notice: 'save.error.storage' };
    }
    if (record === undefined) return { status: 'empty' };
    // Le worker reçoit une copie : le tampon envoyé est transféré, donc détaché ici, et
    // l'enregistrement doit rester intact pour être mis de côté s'il est illisible.
    const failure = await this.loadData(record.data.slice(0));
    return failure === undefined
      ? { status: 'loaded' }
      : { status: 'failed', notice: failure, record };
  }

  async load(): Promise<void> {
    const outcome = await this.loadFrom(MANUAL_SLOT);
    if (outcome.status === 'loaded') showNotice('save.loaded');
    else if (outcome.status === 'empty') showNotice('save.none');
    else showNotice(outcome.notice);
  }

  /**
   * Reprend au démarrage la partie de la sauvegarde automatique. Renvoie faux s'il faut
   * en commencer une autre ; une sauvegarde illisible est alors mise de côté, pour que
   * la sauvegarde automatique suivante ne l'écrase pas.
   */
  async resume(): Promise<boolean> {
    // Sans stockage local, il n'y a rien à reprendre : le joueur l'apprend d'emblée.
    if (this.store === undefined) {
      showNotice('save.error.storage');
      return false;
    }
    const outcome = await this.loadFrom(AUTO_SLOT);
    if (outcome.status === 'loaded') return true;
    if (outcome.status === 'failed') {
      console.warn('reprise impossible', outcome.notice);
      if (outcome.record !== undefined) {
        await this.store
          .put({ ...outcome.record, slot: UNREADABLE_SLOT })
          .catch((error: unknown) => {
            console.warn('mise de côté impossible', error);
          });
      }
      showNotice('save.error.resume');
    }
    return false;
  }

  /** Télécharge la partie en cours dans un fichier, pour la reprendre ailleurs. */
  async exportFile(): Promise<void> {
    const captured = await this.capture();
    if (captured.status !== 'saved') {
      showNotice(CAPTURE_ERRORS[captured.status]);
      return;
    }
    const { meta, data } = captured;
    const url = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = t('save.fileName', { year: String(dateOfTick(meta.tick).year) });
    link.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
    showNotice('save.exported');
  }

  async importFile(file: File): Promise<void> {
    // Un fichier trop gros n'est pas lu : il remplirait la mémoire pour rien.
    if (file.size > MAX_SAVE_BYTES) {
      showNotice('save.error.size');
      return;
    }
    let data: ArrayBuffer;
    try {
      data = await file.arrayBuffer();
    } catch {
      showNotice('save.error.read');
      return;
    }
    showNotice((await this.loadData(data)) ?? 'save.loaded');
  }

  /** Sauvegarde automatique : à intervalle régulier, et quand la page passe en arrière-plan. */
  startAutosave(): void {
    // Sans stockage local, il n'y a rien où sauvegarder : le démarrage l'a déjà dit.
    if (this.store === undefined) return;
    const warned = new Set<SaveOutcome>();
    const autosave = () => {
      void this.saveTo(AUTO_SLOT).then((outcome) => {
        // Sans partie (écran de création au démarrage), il n'y a rien à sauvegarder.
        if (outcome === 'save.done' || outcome === 'save.error.noGame') return;
        console.warn('sauvegarde automatique', outcome);
        // Un échec durable est signalé une fois ; le reste est passager.
        if (LASTING_FAILURES.has(outcome) && !warned.has(outcome)) {
          warned.add(outcome);
          showNotice(outcome);
        }
      });
    };
    setInterval(autosave, AUTOSAVE_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') autosave();
    });
  }
}
