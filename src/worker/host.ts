/**
 * Hôte de la simulation dans le worker (ADR 0004) : il reçoit les messages, cadence
 * les pas selon la vitesse, les mesure et envoie les résultats. Il est le seul, côté
 * worker, à lire l'horloge ; il ne la transmet jamais à l'état.
 *
 * L'environnement (messagerie, horloge, minuteries) est injecté : le worker fournit
 * le vrai, les tests une imitation.
 */
import {
  PROTOCOL_VERSION,
  transferablesOf,
  type GameCommand,
  type MainMessage,
  type TimeInfo,
  type WorkerMessage,
} from '../core/protocol';
import { monthDuration, type SpeedId } from '../core/time';
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

export class SimulationHost {
  private readonly env: HostEnvironment;
  private state: SimState | undefined;
  private pending: GameCommand[] = [];
  private paused = false;
  private speed: SpeedId = 'normal';
  /** Instant prévu du prochain pas, sur l'horloge de l'environnement. */
  private nextStepAt = 0;
  private timer: number | undefined;
  /** Coût factice ajouté à chaque pas (débogage), en millisecondes. */
  private stepCost = 0;

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
        // La commande s'appliquera au début du prochain pas, qui l'horodatera.
        this.pending.push(message.command);
        break;
      case 'setSpeed':
        this.speed = message.speed;
        this.nextStepAt = this.env.now() + monthDuration(this.speed);
        this.reschedule();
        this.sendTime();
        break;
      case 'setPaused':
        this.paused = message.paused;
        this.nextStepAt = this.env.now() + monthDuration(this.speed);
        this.reschedule();
        this.sendTime();
        break;
      case 'stepOnce':
        if (this.paused) this.runStep();
        break;
      case 'debugStepCost':
        this.stepCost = Math.max(0, message.milliseconds);
        break;
    }
  }

  private time(state: SimState): TimeInfo {
    return { tick: state.tick, paused: this.paused, speed: this.speed };
  }

  private start(state: SimState): void {
    this.state = state;
    this.pending = [];
    this.send({
      type: 'snapshot',
      world: { seed: state.seed, size: state.size },
      time: this.time(state),
      chunks: allChunks(state),
    });
    this.nextStepAt = this.env.now() + monthDuration(this.speed);
    this.reschedule();
  }

  /** Programme le prochain pas, sauf en pause ou sans partie. */
  private reschedule(): void {
    if (this.timer !== undefined) this.env.clearTimer(this.timer);
    this.timer = undefined;
    if (this.paused || this.state === undefined) return;
    const delay = Math.max(0, this.nextStepAt - this.env.now());
    this.timer = this.env.setTimer(() => {
      this.timer = undefined;
      this.runStep();
      this.advanceSchedule();
      this.reschedule();
    }, delay);
  }

  /**
   * Avance l'horaire d'un mois. Si la simulation a pris plus d'un mois de retard sur
   * l'horloge, elle repart de maintenant, sans rattraper par rafales : elle tourne
   * alors simplement aussi vite qu'elle le peut.
   */
  private advanceSchedule(): void {
    const duration = monthDuration(this.speed);
    const now = this.env.now();
    this.nextStepAt += duration;
    if (this.nextStepAt < now - duration) this.nextStepAt = now;
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
    this.send({ type: 'delta', time: this.time(state), chunks: takeDirtyChunks(state) });
    this.send({ type: 'stats', stats: { stepMs } });
  }

  private sendTime(): void {
    if (this.state !== undefined) this.send({ type: 'time', time: this.time(this.state) });
  }

  private send(message: WorkerMessage): void {
    this.env.post(message, transferablesOf(message));
  }
}
