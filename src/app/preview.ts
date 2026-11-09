/**
 * Demandes d'aperçu de l'écran de création (tâche 1.9) : une seule à la fois chez le
 * worker. Pendant qu'il en calcule une, seule la dernière demandée attend son tour : un
 * curseur que l'on fait glisser ne remplit pas la file du worker d'aperçus périmés.
 */
import type { WorkerMessage } from '../core/protocol';
import type { WorldParams } from '../core/worldParams';

type PreviewReady = Extract<WorkerMessage, { type: 'previewReady' }>;

/** Délai au-delà duquel un aperçu sans réponse est abandonné, en millisecondes. */
const PREVIEW_TIMEOUT_MS = 20_000;

export interface PreviewTimers {
  setTimer(callback: () => void, delay: number): number;
  clearTimer(handle: number): void;
}

export class PreviewScheduler {
  private readonly send: (requestId: number, params: WorldParams) => void;
  private readonly show: (preview: PreviewReady, params: WorldParams) => void;
  private readonly timers: PreviewTimers;
  private requestId = 0;
  /** Paramètres de la demande en cours chez le worker, et de celle qui attend son tour. */
  private sent: WorldParams | undefined;
  private waiting: WorldParams | undefined;
  private timer: number | undefined;

  constructor(
    send: (requestId: number, params: WorldParams) => void,
    show: (preview: PreviewReady, params: WorldParams) => void,
    timers: PreviewTimers,
  ) {
    this.send = send;
    this.show = show;
    this.timers = timers;
  }

  /** Demande l'aperçu de ces paramètres : tout de suite, ou après celui en cours. */
  request(params: WorldParams): void {
    if (this.sent === undefined) this.dispatch(params);
    else this.waiting = params;
  }

  /** Réponse du worker : seule celle de la dernière demande envoyée compte. */
  ready(preview: PreviewReady): void {
    const sent = this.sent;
    if (sent === undefined || preview.requestId !== this.requestId) return;
    this.show(preview, sent);
    this.next();
  }

  /** Le worker a signalé une erreur : l'aperçu en cours ne viendra pas. */
  failed(): void {
    if (this.sent !== undefined) this.next();
  }

  /** Oublie l'aperçu attendu, à la fermeture de l'écran. */
  cancel(): void {
    this.waiting = undefined;
  }

  private dispatch(params: WorldParams): void {
    this.sent = params;
    this.requestId++;
    this.timer = this.timers.setTimer(() => {
      this.timer = undefined;
      this.failed();
    }, PREVIEW_TIMEOUT_MS);
    this.send(this.requestId, params);
  }

  private next(): void {
    if (this.timer !== undefined) this.timers.clearTimer(this.timer);
    this.timer = undefined;
    this.sent = undefined;
    const waiting = this.waiting;
    this.waiting = undefined;
    if (waiting !== undefined) this.dispatch(waiting);
  }
}
