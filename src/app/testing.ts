/**
 * Une partie avec le vrai hôte du worker, vue comme le fil principal la voit (tests de
 * l'horloge du rendu et des images datées, ADR 0013) : une image toutes les FRAME_MS, et
 * chaque message traité à l'instant de son envoi, comme dans main.ts. Le worker peut avoir
 * de l'avance sur l'image, occupé par un long pas mensuel : ses messages attendent alors
 * l'image de leur instant.
 */
import { PROTOCOL_VERSION, type WorkerMessage } from '../core/protocol';
import { testData, testParams } from '../sim/testing';
import { SimulationHost } from '../worker/host';
import { FakeEnvironment, testGenerator } from '../worker/testing';
import { FrameQueue } from './frames';
import { GameClock } from './gameClock';

/** Durée d'une image à 60 images par seconde, en millisecondes. */
export const FRAME_MS = 1000 / 60;

export class HostedGame {
  readonly env = new FakeEnvironment();
  readonly host = new SimulationHost(this.env, testData, testGenerator);
  readonly clock = new GameClock();
  readonly frames = new FrameQueue();
  /** Instant de la dernière image, en millisecondes. */
  now = 0;
  /** Appelé après le traitement de chaque message, avec l'instant de son envoi. */
  onMessage: ((message: WorkerMessage, at: number) => void) | undefined;
  private delivered = 0;

  /** Poignée de main, puis une partie sur le monde Petit des tests. */
  async start(): Promise<void> {
    this.host.receive({ type: 'hello', protocol: PROTOCOL_VERSION });
    this.host.receive({ type: 'newGame', params: testParams() });
    await this.host.idle();
    this.deliver(this.env.time);
  }

  /** Traite les messages envoyés jusqu'ici, quel que soit leur instant (chargement). */
  flush(): void {
    this.deliver(Number.POSITIVE_INFINITY);
  }

  /** L'image suivante, FRAME_MS plus tard : renvoie l'instant affiché, en jours. */
  frame(): number {
    this.now += FRAME_MS;
    if (this.env.time < this.now) this.env.advance(this.now - this.env.time);
    this.deliver(this.now);
    return this.clock.advance(this.now);
  }

  private deliver(until: number): void {
    for (let entry = this.env.sent.at(this.delivered); entry !== undefined && entry.at <= until;) {
      this.delivered++;
      const { message, at } = entry;
      if (message.type === 'snapshot') {
        this.frames.reset(message.frame, message.time);
        this.clock.reset(message.time, at);
      } else if (message.type === 'delta') {
        if (message.frame !== undefined) this.frames.push(message.frame, message.time);
        this.clock.receive(message.time, at);
      } else if (message.type === 'time') {
        this.clock.receive(message.time, at);
      } else if (message.type === 'stats' && message.stats.monthMs !== undefined) {
        this.clock.monthStep(message.stats.monthMs);
      }
      this.onMessage?.(message, at);
      entry = this.env.sent.at(this.delivered);
    }
  }
}
