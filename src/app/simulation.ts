/**
 * Client du worker de simulation, côté fil principal (ADR 0004) : il envoie les
 * messages, avec leurs tampons transférés, et diffuse les réponses aux abonnés.
 */
import { transferablesOf, type MainMessage, type WorkerMessage } from '../core/protocol';

export type WorkerListener = (message: WorkerMessage) => void;

export class SimulationClient {
  private readonly worker: Worker;
  private readonly listeners = new Set<WorkerListener>();

  constructor() {
    this.worker = new Worker(new URL('../worker/index.ts', import.meta.url), { type: 'module' });
    this.worker.addEventListener('message', (event: MessageEvent<WorkerMessage>) => {
      for (const listener of this.listeners) listener(event.data);
    });
  }

  send(message: MainMessage): void {
    this.worker.postMessage(message, transferablesOf(message));
  }

  /** Abonne `listener` aux messages du worker ; renvoie de quoi le désabonner. */
  subscribe(listener: WorkerListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
