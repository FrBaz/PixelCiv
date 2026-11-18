/**
 * Imitation de l'environnement du worker pour les tests de l'hôte (ADR 0004) : horloge,
 * minuteries et messages sous contrôle du test. Chaque message garde l'instant de son
 * envoi, sur l'horloge imitée.
 */
import type { WorkerMessage } from '../core/protocol';
import { GENERATION_STAGES } from '../core/world';
import { testData, testWorld } from '../sim/testing';
import { generateWorld } from '../worldgen/generate';
import type { HostEnvironment, WorldGenerator } from './host';

/**
 * Générateur des tests : le monde Petit de la graine, généré une fois pour toutes ; les
 * aperçus, plus petits, se génèrent vraiment.
 */
export const testGenerator: WorldGenerator = (params, onStage) => {
  for (const stage of GENERATION_STAGES) onStage(stage);
  if (params.size.width === 512) return testWorld(params.seed);
  return generateWorld(params, testData);
};

/**
 * Retard d'un réveil de l'hôte sur l'échéance de son jour, au plus : il arrondit le délai
 * de sa minuterie à la milliseconde supérieure, setTimeout ne prenant que des
 * millisecondes entières.
 */
export const WAKE_SLACK_MS = 1;

/** Un message envoyé, ses tampons transférés et l'instant de son envoi. */
export interface SentMessage {
  readonly message: WorkerMessage;
  readonly transfer: Transferable[];
  readonly at: number;
}

export class FakeEnvironment implements HostEnvironment {
  time = 0;
  /** Avance de l'horloge à chaque lecture : une attente active finit donc par aboutir. */
  advancePerRead = 0;
  /** Durée de l'envoi d'un delta, comme la copie d'une grosse image : l'horloge avance d'autant. */
  deltaCost = 0;
  /**
   * Minuteries d'un navigateur : setTimeout tronque son délai à la milliseconde, son
   * paramètre étant un entier en WebIDL, et ne descend pas sous 1 ms, ni sous 4 ms pour
   * une minuterie armée pendant le rappel d'une autre. Sans cette option, une minuterie
   * part à l'instant exact demandé.
   */
  browserTimers = false;
  /** Rappels de minuterie exécutés : les réveils de l'hôte. */
  fired = 0;
  readonly sent: SentMessage[] = [];
  private readonly timers = new Map<number, { at: number; callback: () => void }>();
  private nextHandle = 1;
  private firing = false;

  /**
   * Comme un vrai worker, un message posté est cloné et ses tampons transférés : ceux
   * de l'hôte sont détachés, et une couche envoyée sans copie le trahirait.
   */
  post(message: WorkerMessage, transfer: Transferable[]): void {
    this.sent.push({ message: structuredClone(message, { transfer }), transfer, at: this.time });
    if (message.type === 'delta') this.time += this.deltaCost;
  }

  now(): number {
    const time = this.time;
    this.time += this.advancePerRead;
    return time;
  }

  setTimer(callback: () => void, delay: number): number {
    const handle = this.nextHandle++;
    const wait = this.browserTimers ? Math.max(this.firing ? 4 : 1, Math.trunc(delay)) : delay;
    this.timers.set(handle, { at: this.time + wait, callback });
    return handle;
  }

  clearTimer(handle: number): void {
    this.timers.delete(handle);
  }

  /** Fait passer `milliseconds`, en déclenchant dans l'ordre les minuteries échues. */
  advance(milliseconds: number): void {
    const end = this.time + milliseconds;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort(([, a], [, b]) => a.at - b.at)
        .at(0);
      if (due === undefined) break;
      const [handle, timer] = due;
      this.timers.delete(handle);
      this.time = Math.max(this.time, timer.at);
      this.fired++;
      this.firing = true;
      try {
        timer.callback();
      } finally {
        this.firing = false;
      }
    }
    this.time = Math.max(this.time, end);
  }

  /** Messages envoyés d'un type donné. */
  messages<T extends WorkerMessage['type']>(type: T): Extract<WorkerMessage, { type: T }>[] {
    return this.sent
      .map((entry) => entry.message)
      .filter((message): message is Extract<WorkerMessage, { type: T }> => message.type === type);
  }

  /** Messages envoyés d'un type donné, avec l'instant de leur envoi. */
  timed<T extends WorkerMessage['type']>(
    type: T,
  ): { readonly message: Extract<WorkerMessage, { type: T }>; readonly at: number }[] {
    return this.sent.flatMap((entry) =>
      entry.message.type === type
        ? [{ message: entry.message as Extract<WorkerMessage, { type: T }>, at: entry.at }]
        : [],
    );
  }
}
