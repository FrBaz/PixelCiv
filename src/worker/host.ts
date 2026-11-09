/**
 * Hôte de la simulation dans le worker (ADR 0004) : il reçoit les messages, cadence
 * les pas, les mesure et envoie les résultats. Il est le seul, côté worker, à lire
 * l'horloge ; il ne la transmet jamais à l'état.
 *
 * L'environnement (messagerie, horloge, minuteries) est injecté : le worker fournit
 * le vrai, les tests une imitation.
 */
import {
  PROTOCOL_VERSION,
  transferablesOf,
  type GameCommand,
  type MainMessage,
  type WorkerMessage,
} from '../core/protocol';
import { WORLD_SIZES } from '../core/world';
import { allChunks, createState, takeDirtyChunks, type SimState } from '../sim/state';
import { step } from '../sim/step';

export interface HostEnvironment {
  post(message: WorkerMessage, transfer: Transferable[]): void;
  /** Horloge en millisecondes. */
  now(): number;
  setTimer(callback: () => void, delay: number): number;
  clearTimer(handle: number): void;
}

/** Durée d'un mois en vitesse normale : une année dure 10 s (MOD-06). */
export const NORMAL_MONTH_MS = 10_000 / 12;

export class SimulationHost {
  private readonly env: HostEnvironment;
  private state: SimState | undefined;
  private pending: GameCommand[] = [];
  /** Coût factice ajouté à chaque pas (débogage), en millisecondes. */
  private stepCost = 0;
  private timer: number | undefined;

  constructor(env: HostEnvironment) {
    this.env = env;
  }

  receive(message: MainMessage): void {
    switch (message.type) {
      case 'hello':
        if (message.protocol !== PROTOCOL_VERSION) {
          this.send({
            type: 'error',
            code: 'protocol',
            detail: `protocole ${message.protocol} reçu, ${PROTOCOL_VERSION} attendu`,
          });
          return;
        }
        this.send({ type: 'ready', protocol: PROTOCOL_VERSION });
        break;
      case 'newGame':
        this.start(createState(message.seed, WORLD_SIZES[message.size]));
        break;
      case 'game':
        if (this.state === undefined) {
          this.send({ type: 'error', code: 'noGame', detail: 'commande reçue avant la partie' });
          return;
        }
        this.pending.push(message.command);
        break;
      case 'debugStepCost':
        this.stepCost = Math.max(0, message.milliseconds);
        break;
    }
  }

  private start(state: SimState): void {
    this.state = state;
    this.pending = [];
    this.send({
      type: 'snapshot',
      world: { seed: state.seed, size: state.size },
      time: { tick: state.tick },
      chunks: allChunks(state),
    });
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== undefined) this.env.clearTimer(this.timer);
    this.timer = this.env.setTimer(() => {
      this.timer = undefined;
      this.runStep();
      this.schedule();
    }, NORMAL_MONTH_MS);
  }

  private runStep(): void {
    const state = this.state;
    if (state === undefined) return;
    const start = this.env.now();
    const commands = this.pending;
    this.pending = [];
    step(state, commands);
    if (this.stepCost > 0) {
      const end = start + this.stepCost;
      while (this.env.now() < end) {
        // Attente active : le pas factice occupe vraiment le worker.
      }
    }
    const stepMs = this.env.now() - start;
    this.send({ type: 'delta', time: { tick: state.tick }, chunks: takeDirtyChunks(state) });
    this.send({ type: 'stats', stats: { stepMs } });
  }

  private send(message: WorkerMessage): void {
    this.env.post(message, transferablesOf(message));
  }
}
