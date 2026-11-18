/**
 * Hôte de la simulation dans le worker (ADR 0004) : il reçoit les messages, cadence
 * les pas selon la vitesse, les mesure et envoie les résultats. Il est le seul, côté
 * worker, à lire l'horloge ; il ne la transmet jamais à l'état.
 *
 * Les opérations sur la partie entière (nouvelle partie, sauvegarde, chargement)
 * passent dans une file, chacune après la fin de la précédente : une sauvegarde
 * demandée pendant un chargement porte sur la partie chargée, et la dernière partie
 * demandée est celle qui reste.
 *
 * L'environnement (messagerie, horloge, minuteries) est injecté : le worker fournit
 * le vrai, les tests une imitation.
 */
import type { GameData } from '../core/data';
import {
  CHRONICLE_RECENT,
  PROTOCOL_VERSION,
  transferablesOf,
  type GameCommand,
  type MainMessage,
  type TimeInfo,
  type WorkerMessage,
} from '../core/protocol';
import { readSave, SaveError, writeSave } from '../core/save/format';
import { EXPECTED_WORLD_FINGERPRINT, SELFTEST_WORLD } from '../core/selftest';
import { monthDuration, type SpeedId } from '../core/time';
import {
  copyLayers,
  GENERATION_STAGES,
  layersFingerprint,
  WORLD_SIZES,
  type GenerationStage,
  type WorldLayers,
} from '../core/world';
import { defaultWorldParams, worldParamsSchema, type WorldParams } from '../core/worldParams';
import { GameCommandSchema } from '../sim/commands';
import { MIGRATIONS, restoreState, saveState } from '../sim/save';
import { cellIndex, createState, takeDirtyChunks, type SimState } from '../sim/state';
import { applyCommands, step, type RejectedCommand } from '../sim/step';
import { chroniclePage, chronicleViews, groupsFrame, inspect } from '../sim/views';
import { GENERATOR_VERSION, type GenerationParams } from '../worldgen/generate';

export interface HostEnvironment {
  post(message: WorkerMessage, transfer: Transferable[]): void;
  /** Horloge en millisecondes. */
  now(): number;
  setTimer(callback: () => void, delay: number): number;
  clearTimer(handle: number): void;
}

/** Générateur de mondes : generateWorld, ou une imitation rapide dans les tests. */
export type WorldGenerator = (
  params: GenerationParams,
  onStage: (stage: GenerationStage) => void,
) => WorldLayers;

/** Largeur d'un aperçu de l'écran de création, en colonnes : bornes et parité. */
export const PREVIEW_WIDTH = { min: 32, max: 512 } as const;

/**
 * Un groupe n'apparaît que sur une case du monde franchissable, comme le veut spawnGroup :
 * refusée dès sa réception, la commande le dit au joueur au lieu de rester sans effet.
 */
function placeable(state: SimState, command: GameCommand): boolean {
  if (command.type !== 'spawnGroup') return true;
  const cell = cellIndex(state.size, command.x, command.y);
  return cell !== undefined && Number.isFinite(state.cost[cell] ?? Number.POSITIVE_INFINITY);
}

export class SimulationHost {
  private readonly env: HostEnvironment;
  private readonly data: GameData;
  private readonly generate: WorldGenerator;
  private state: SimState | undefined;
  /** Poignée de main : rien d'autre n'est traité avant qu'elle ait réussi. */
  private greeted = false;
  private paused = false;
  private speed: SpeedId = 'normal';
  /** Instant prévu du prochain pas, sur l'horloge de l'environnement, hors pause. */
  private nextStepAt = 0;
  /** En pause : temps qui restait avant le prochain pas, en millisecondes. */
  private remaining = 0;
  private timer: number | undefined;
  /** Coût factice ajouté à chaque pas (débogage), en millisecondes. */
  private stepCost = 0;
  /** File des opérations sur la partie entière. */
  private operations: Promise<void> = Promise.resolve();
  /** Faits de la chronique déjà envoyés au fil principal. */
  private chronicleSent = 0;

  constructor(env: HostEnvironment, data: GameData, generate: WorldGenerator) {
    this.env = env;
    this.data = data;
    this.generate = generate;
  }

  receive(message: MainMessage): void {
    if (message.type === 'hello') {
      this.greet(message.protocol);
      return;
    }
    if (!this.greeted) {
      this.send({ type: 'error', code: 'protocol', detail: 'message reçu sans poignée de main' });
      return;
    }
    switch (message.type) {
      case 'newGame': {
        const params = this.checkParams(message.params);
        if (params === undefined) break;
        this.enqueue(() => {
          this.newGame(params);
        });
        break;
      }
      case 'preview':
        this.preview(message.requestId, message.params, message.width);
        break;
      case 'game':
        this.command(message.command);
        break;
      case 'inspect': {
        const state = this.state;
        const result = state === undefined ? {} : inspect(state, this.data, message.target);
        this.send({ type: 'inspection', requestId: message.requestId, ...result });
        break;
      }
      case 'chronicle': {
        // Jamais au-delà des faits déjà envoyés : les suivants viennent avec les deltas.
        const state = this.state;
        const before = Math.min(message.before, this.chronicleSent);
        const facts = state === undefined ? [] : chroniclePage(state, before);
        this.send({ type: 'chroniclePage', requestId: message.requestId, facts });
        break;
      }
      case 'setSpeed':
        this.setSpeed(message.speed);
        break;
      case 'setPaused':
        this.setPaused(message.paused);
        break;
      case 'stepOnce':
        if (this.paused && this.state !== undefined) {
          this.runStep();
          // Le mois suivant commence : il durera un mois entier à la reprise.
          this.remaining = monthDuration(this.speed);
        }
        break;
      case 'save': {
        const { requestId } = message;
        this.enqueue(() => this.save(requestId));
        break;
      }
      case 'load': {
        const { requestId, data } = message;
        this.enqueue(() => this.load(requestId, data));
        break;
      }
      case 'debugStepCost':
        this.stepCost = Math.max(0, message.milliseconds);
        break;
    }
  }

  /** Promesse tenue quand la file des opérations est vide (pour les tests). */
  idle(): Promise<void> {
    return this.operations;
  }

  private greet(protocol: number): void {
    this.greeted = protocol === PROTOCOL_VERSION;
    if (this.greeted) {
      this.send({ type: 'ready', protocol: PROTOCOL_VERSION, determinism: this.selfTest() });
    } else {
      this.send({
        type: 'error',
        code: 'protocol',
        detail: `protocole ${protocol} reçu, ${PROTOCOL_VERSION} attendu`,
      });
    }
  }

  /**
   * Auto-test du générateur (ADR 0003) : le monde de référence, généré dans ce moteur,
   * redonne-t-il son empreinte ?
   */
  private selfTest(): boolean {
    const params = defaultWorldParams(this.data.worldgen.parameters, SELFTEST_WORLD.seed, 'small');
    try {
      const world = this.generate({ ...params, size: SELFTEST_WORLD.size }, () => undefined);
      return layersFingerprint(world) === EXPECTED_WORLD_FINGERPRINT;
    } catch (error) {
      console.error(error);
      return false;
    }
  }

  /** Ajoute une opération à la file ; un défaut est signalé sans bloquer les suivantes. */
  private enqueue(operation: () => Promise<void> | void): void {
    this.operations = this.operations.then(operation).catch((error: unknown) => {
      console.error(error);
      this.send({ type: 'error', code: 'internal', detail: String(error) });
    });
  }

  /** Vérifie des paramètres de monde ; signale une erreur s'ils sont invalides. */
  private checkParams(params: unknown): WorldParams | undefined {
    const parsed = worldParamsSchema(this.data.worldgen.parameters).safeParse(params);
    if (parsed.success) return parsed.data;
    this.send({ type: 'error', code: 'params', detail: 'paramètres de monde invalides' });
    return undefined;
  }

  /** Génère le monde demandé, étape par étape, puis y commence une partie. */
  private newGame(params: WorldParams): void {
    const start = this.env.now();
    const steps = GENERATION_STAGES.length;
    const world = this.generate({ ...params, size: WORLD_SIZES[params.size] }, (stage) => {
      this.send({ type: 'progress', stage, step: GENERATION_STAGES.indexOf(stage), steps });
    });
    this.send({ type: 'generated', milliseconds: this.env.now() - start });
    this.start(createState(params, world, this.data));
  }

  /**
   * Aperçu de l'écran de création : le même monde, sur une carte réduite. Il ne touche
   * pas à la partie, et passe hors de la file des opérations.
   */
  private preview(requestId: number, params: unknown, width: number): void {
    const valid = this.checkParams(params);
    if (valid === undefined) return;
    if (
      !Number.isInteger(width) ||
      width % 2 !== 0 ||
      width < PREVIEW_WIDTH.min ||
      width > PREVIEW_WIDTH.max
    ) {
      this.send({ type: 'error', code: 'params', detail: `largeur d'aperçu invalide : ${width}` });
      return;
    }
    const size = { width, height: width / 2 };
    let world: WorldLayers;
    try {
      world = this.generate({ ...valid, size }, () => undefined);
    } catch (error) {
      console.error(error);
      this.send({ type: 'error', code: 'internal', detail: String(error) });
      return;
    }
    this.send({
      type: 'previewReady',
      requestId,
      size,
      biome: world.biome,
      elevation: world.elevation,
    });
  }

  /**
   * Vérifie une commande de jeu ; elle s'appliquera au début du prochain pas, ou aussitôt
   * en pause (applyPending).
   */
  private command(command: unknown): void {
    const state = this.state;
    if (state === undefined) {
      this.send({ type: 'error', code: 'noGame', detail: 'commande reçue avant la partie' });
      return;
    }
    const parsed = GameCommandSchema.safeParse(command);
    if (!parsed.success || !this.knownContent(parsed.data)) {
      this.send({ type: 'error', code: 'command', detail: 'commande invalide' });
      return;
    }
    if (!placeable(state, parsed.data)) {
      this.send({ type: 'error', code: 'command', detail: 'case infranchissable' });
      return;
    }
    state.pending.push(parsed.data);
    if (this.paused) this.applyPending();
  }

  /**
   * En pause, les commandes en attente s'appliquent sans attendre le pas (U-7) : le joueur
   * voit aussitôt le groupe apparu. Elles s'appliquent comme au début du pas qui vient, et
   * se journalisent avec lui (applyCommands) : rien ne change l'état d'ici là, et le rejeu
   * redonne la même partie. Ce qui a changé part aussitôt, dans un delta sans pas.
   */
  private applyPending(): void {
    const state = this.state;
    if (state === undefined || state.pending.length === 0) return;
    try {
      applyCommands(state, state.pending.splice(0), this.data, this.rejected);
      this.sendDelta(state);
    } catch (error) {
      console.error(error);
      this.send({ type: 'error', code: 'internal', detail: String(error) });
    }
  }

  /** Commande écartée parce qu'elle a levé une exception (L-2) : elle se signale. */
  private readonly rejected: RejectedCommand = (command, error) => {
    console.error(error);
    this.send({ type: 'error', code: 'command', detail: `${command.type} : ${String(error)}` });
  };

  /** Les identifiants de contenu d'une commande existent-ils ? */
  private knownContent(command: GameCommand): boolean {
    switch (command.type) {
      case 'paintBiome':
        return this.data.biomes.indexOf(command.biome) !== undefined;
      case 'spawnGroup': {
        const index = this.data.species.indexOf(command.species);
        const species = index === undefined ? undefined : this.data.species.entries[index];
        return species?.subspecies.some((entry) => entry.id === command.subspecies) === true;
      }
    }
  }

  /**
   * Change de vitesse sans perdre l'avancée du mois en cours : le temps qui reste
   * jusqu'au prochain pas suit la nouvelle vitesse. Redemander la vitesse courante ne
   * change rien.
   */
  private setSpeed(speed: SpeedId): void {
    if (speed !== this.speed) {
      const ratio = monthDuration(speed) / monthDuration(this.speed);
      this.speed = speed;
      if (this.paused) {
        this.remaining *= ratio;
      } else {
        const now = this.env.now();
        this.nextStepAt = now + Math.max(0, this.nextStepAt - now) * ratio;
        this.reschedule();
      }
    }
    this.sendTime();
  }

  /**
   * Met en pause ou reprend, là où le mois en était. Les commandes reçues juste avant la
   * pause s'appliquent alors, sans attendre la reprise.
   */
  private setPaused(paused: boolean): void {
    if (paused !== this.paused) {
      const now = this.env.now();
      if (paused) this.remaining = Math.max(0, this.nextStepAt - now);
      else this.nextStepAt = now + this.remaining;
      this.paused = paused;
      this.reschedule();
      if (paused) this.applyPending();
    }
    this.sendTime();
  }

  /** Copie l'état d'un coup, puis le compresse pendant que la partie continue. */
  private async save(requestId: number): Promise<void> {
    if (this.state === undefined) {
      this.send({ type: 'saveFailed', requestId, reason: 'noGame' });
      return;
    }
    let save: ReturnType<typeof saveState>;
    let file: Uint8Array<ArrayBuffer>;
    try {
      save = saveState(this.state, GENERATOR_VERSION, this.data);
      file = await writeSave(save);
    } catch (error) {
      // La requête reçoit sa réponse : une partie trop grande pour le format a sa raison,
      // que le joueur apprend ; un défaut imprévu est signalé à part.
      const size = error instanceof SaveError && error.code === 'size';
      this.send({ type: 'saveFailed', requestId, reason: size ? 'size' : 'failed' });
      if (!(error instanceof SaveError)) throw error;
      return;
    }
    this.send({ type: 'saved', requestId, meta: save.meta, data: file.buffer });
  }

  private async load(requestId: number, data: ArrayBuffer): Promise<void> {
    try {
      const state = restoreState(await readSave(new Uint8Array(data), MIGRATIONS), this.data);
      this.start(state);
    } catch (error) {
      // La requête reçoit sa réponse ; un défaut imprévu est signalé à part.
      this.send({
        type: 'loadFailed',
        requestId,
        reason: error instanceof SaveError ? error.code : 'corrupt',
      });
      if (!(error instanceof SaveError)) throw error;
      return;
    }
    this.send({ type: 'loaded', requestId });
  }

  private time(state: SimState): TimeInfo {
    return { tick: state.tick, paused: this.paused, speed: this.speed };
  }

  /**
   * Commence la partie `state`. La copie de ses couches pour l'instantané se fait
   * d'abord : si elle échoue, la partie en cours continue, et rien n'a changé.
   */
  private start(state: SimState): void {
    const layers = copyLayers(state.world);
    const frame = groupsFrame(state, this.data);
    // Les derniers faits de la chronique ; les suivants viendront avec chaque pas, les plus
    // anciens à la demande, par pages.
    const total = state.society.chronicle.length;
    const chronicle = chronicleViews(state, total - CHRONICLE_RECENT, total);
    this.state = state;
    this.chronicleSent = state.society.chronicle.length;
    this.send({
      type: 'snapshot',
      world: { params: state.params, size: state.size },
      time: this.time(state),
      layers,
      frame,
      chronicle,
    });
    const duration = monthDuration(this.speed);
    this.nextStepAt = this.env.now() + duration;
    this.remaining = duration;
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
      try {
        this.runStep();
      } finally {
        // Quoi qu'il arrive au pas, le suivant est programmé : la partie ne se fige pas.
        this.advanceSchedule();
        this.reschedule();
      }
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

  /**
   * Fait passer un mois, puis envoie son delta et sa durée. Une exception ne fige pas la
   * partie : celle d'une commande l'écarte, sans effet sur l'état ni place au journal
   * (step), et se signale en erreur « command » ; celle du mois lui-même se signale en
   * erreur « internal », et le pas suivant vient à son heure.
   */
  private runStep(): void {
    const state = this.state;
    if (state === undefined) return;
    const start = this.env.now();
    try {
      // Les commandes en attente s'appliquent au début du pas, qui les horodate.
      const members = step(state, state.pending.splice(0), this.data, this.rejected);
      if (this.stepCost > 0) {
        const end = start + this.stepCost;
        while (this.env.now() < end) {
          // Attente active : le pas factice occupe vraiment le worker.
        }
      }
      this.sendDelta(state, members);
    } catch (error) {
      console.error(error);
      this.send({ type: 'error', code: 'internal', detail: String(error) });
      return;
    }
    // Le pas compte son delta : l'image des groupes, la chronique et leur envoi (W-11).
    this.send({ type: 'stats', stats: { stepMs: this.env.now() - start } });
  }

  /**
   * Ce qui a changé depuis le dernier message : blocs, temps, groupes (avec leurs membres
   * s'ils sont connus) et faits nouveaux de la chronique.
   */
  private sendDelta(state: SimState, members?: ReadonlyMap<number, readonly number[]>): void {
    const total = state.society.chronicle.length;
    this.send({
      type: 'delta',
      time: this.time(state),
      chunks: takeDirtyChunks(state),
      frame: groupsFrame(state, this.data, members),
      chronicle: chronicleViews(state, this.chronicleSent, total),
    });
    this.chronicleSent = total;
  }

  private sendTime(): void {
    if (this.state !== undefined) this.send({ type: 'time', time: this.time(this.state) });
  }

  private send(message: WorkerMessage): void {
    this.env.post(message, transferablesOf(message));
  }
}
