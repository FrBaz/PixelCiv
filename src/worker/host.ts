/**
 * Hôte de la simulation dans le worker (ADR 0004, ADR 0013) : il reçoit les messages,
 * cadence les jours selon la vitesse, les regroupe en lots, les mesure et envoie les
 * résultats. Il est le seul, côté worker, à lire l'horloge ; il ne la transmet jamais à
 * l'état, qui ne dépend ni de la vitesse ni du regroupement des jours.
 *
 * Cadence : l'hôte calcule l'échéance de chaque jour depuis une ancre, réancrée à chaque
 * changement de vitesse et à chaque reprise, plutôt qu'en cumulant des durées : 360 jours
 * durent une année pile. Il se réveille au plus une fois toutes les MIN_BATCH_MS
 * millisecondes, à l'échéance d'un jour, ou dès que possible s'il a des jours échus en
 * retard, et fait alors tous les jours échus, au plus MAX_BATCH_DAYS, en s'arrêtant après
 * un pas mensuel ; un seul delta part pour le lot. Plus de 2 × MAX_BATCH_DAYS jours de
 * retard après un lot : il repart de maintenant, sans rattraper par rafales.
 *
 * Les opérations sur la partie entière (nouvelle partie, sauvegarde, chargement)
 * passent dans une file, chacune après la fin de la précédente : une sauvegarde
 * demandée pendant un chargement porte sur la partie chargée, et la dernière partie
 * demandée est celle qui reste.
 *
 * Le mouvement des individus (ADR 0014) part avec chaque lot : les étapes commencées pendant
 * ses jours, que le journal du mouvement note, chacune datée de son jour ; l'image des groupes,
 * au pas mensuel et après une commande qui change les groupes, porte les positions de tous et
 * l'étape en cours de chaque marcheur. Image et étapes voyagent en tableaux typés transférés,
 * pris dans une réserve de tampons que le fil principal remplit en rendant ceux qu'il a lus
 * (message `recycle`). Le gibier (ADR 0018) suit la même voie : ses étapes, avec leur allure,
 * partent avec chaque lot ; son image, à l'instantané, au pas mensuel, et dès que des animaux
 * apparaissent ou disparaissent hors du mois (Fauna.changed).
 *
 * L'environnement (messagerie, horloge, minuteries) est injecté : le worker fournit
 * le vrai, les tests une imitation.
 */
import { BufferPool } from '../core/buffers';
import type { GameData } from '../core/data';
import {
  CHRONICLE_RECENT,
  PROTOCOL_VERSION,
  transferablesOf,
  type GameCommand,
  type LoggedCommand,
  type MainMessage,
  type TimeInfo,
  type WorkerMessage,
} from '../core/protocol';
import { readSave, SaveError, writeSave } from '../core/save/format';
import { EXPECTED_WORLD_FINGERPRINT, SELFTEST_WORLD } from '../core/selftest';
import {
  batchDays,
  dayIndex,
  DAYS_PER_MONTH,
  daysDuration,
  daysIn,
  MAX_BATCH_DAYS,
  MIN_BATCH_MS,
  type SpeedId,
} from '../core/time';
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
import { advanceDay } from '../sim/day';
import { LegJournal } from '../sim/movement';
import { applyCommands, type RejectedCommand } from '../sim/step';
import { chroniclePage, chronicleViews, groupsFrame, inspect } from '../sim/views';
import { FaunaJournal, faunaFrame } from '../sim/fauna';
import type { DayMarks } from '../sim/day';
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

/** Marge d'arrondi sur les jours échus : un réveil à l'échéance compte son jour. */
const DUE_EPSILON = 1e-6;

/**
 * Une commande change-t-elle l'image des groupes ? Seule celle-ci, avec le pas mensuel,
 * fait partir une nouvelle image : une commande de plus doit le dire.
 */
function changesGroups(command: GameCommand): boolean {
  switch (command.type) {
    case 'paintBiome':
      return false;
    case 'spawnGroup':
      return true;
  }
}

/** Ce qu'a fait un lot de jours. */
interface Batch {
  /** Jours passés, pas mensuel compris. */
  days: number;
  /** Membres de chaque groupe, que donne le pas mensuel s'il y en a eu un. */
  members: ReadonlyMap<number, readonly number[]> | undefined;
  /** Durée totale des jours ordinaires, et leur nombre. */
  dailyMs: number;
  daily: number;
  /** Durée du pas mensuel, s'il y en a eu un. */
  monthMs: number | undefined;
  /** Durée totale du jour du gibier sur les jours ordinaires (DayMarks). */
  faunaMs: number;
  /** Le pas mensuel a levé une exception. */
  failed: boolean;
}

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
  /**
   * Ancre de l'horaire, hors pause : à l'instant anchorAt de l'horloge, la partie en était
   * à anchorDays jours écoulés depuis son début, fractionnaires. Le jour qui mène au rang
   * n (dayIndex) est échu à anchorAt + daysDuration(n − anchorDays).
   */
  private anchorAt = 0;
  private anchorDays = 0;
  /**
   * Instant de la fin du dernier lot, delta envoyé, ou de l'instantané de la partie : le
   * lot suivant vient MIN_BATCH_MS plus tard au moins.
   */
  private lastWake = 0;
  /** En pause : avancée du jour en cours, de 0 à 1, qu'il finira à la reprise. */
  private progress = 0;
  private timer: number | undefined;
  /** Coût factice ajouté à chaque pas mensuel (débogage), en millisecondes. */
  private stepCost = 0;
  /** File des opérations sur la partie entière. */
  private operations: Promise<void> = Promise.resolve();
  /** Faits de la chronique déjà envoyés au fil principal. */
  private chronicleSent = 0;
  /** Réserve des tampons d'images et d'étapes, que le fil principal rend (ADR 0014). */
  readonly pool = new BufferPool();

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
          this.runBatch(this.state, 1);
          // Le jour suivant commence : il durera un jour entier à la reprise.
          this.progress = 0;
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
      case 'recycle':
        this.pool.give(message.buffers);
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
   * Vérifie une commande de jeu ; elle s'appliquera au début du prochain jour, le premier
   * du prochain lot, ou aussitôt en pause (applyPending).
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
   * En pause, les commandes en attente s'appliquent sans attendre le jour suivant (U-7) :
   * le joueur voit aussitôt le groupe apparu. Elles s'appliquent comme au début du jour
   * qui vient, et se journalisent à l'instant courant (applyCommands) : rien ne change
   * l'état d'ici là, et le rejeu redonne la même partie. Ce qui a changé part aussitôt,
   * dans un delta sans jour.
   */
  private applyPending(): void {
    const state = this.state;
    if (state === undefined || state.pending.length === 0) return;
    try {
      const logged = state.commandLog.length;
      applyCommands(state, state.pending.splice(0), this.data, this.rejected);
      this.sendDelta(state, 0, this.groupsChanged(state, logged), undefined);
    } catch (error) {
      console.error(error);
      this.send({ type: 'error', code: 'internal', detail: String(error) });
    }
  }

  /** Les commandes journalisées depuis le rang `logged` ont-elles changé les groupes ? */
  private groupsChanged(state: SimState, logged: number): boolean {
    return state.commandLog
      .slice(logged)
      .some((entry: LoggedCommand) => changesGroups(entry.command));
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
   * Change de vitesse en gardant l'avancée du jour en cours, comme la pause : l'horaire se
   * réancre sur l'état, plus cette avancée, d'un jour au plus, et le reste du jour suit la
   * nouvelle vitesse, au prorata. L'avance de l'horaire au-delà d'un jour (près de trois
   * jours entre deux lots à ×16, sept et demi après un pas mensuel de 52 ms) ne passe pas
   * à la nouvelle vitesse : à ×½, elle durerait 32 fois plus longtemps, et partirait d'un
   * coup, en un lot de rattrapage. En pause, l'avancée du jour se garde telle quelle.
   * Redemander la vitesse courante ne change rien.
   */
  private setSpeed(speed: SpeedId): void {
    if (speed !== this.speed) {
      const now = this.env.now();
      const state = this.state;
      const progress = state === undefined ? 0 : this.dayProgress(state, now);
      this.speed = speed;
      if (!this.paused && state !== undefined) {
        this.anchor(now, dayIndex(state) + progress);
        this.reschedule();
      }
    }
    this.sendTime();
  }

  /**
   * Met en pause ou reprend, là où le jour en était : la pause garde l'avancée du jour en
   * cours, et la reprise réancre l'horaire pour finir ce jour. Les commandes reçues juste
   * avant la pause s'appliquent alors, sans attendre la reprise.
   */
  private setPaused(paused: boolean): void {
    if (paused !== this.paused) {
      const now = this.env.now();
      const state = this.state;
      if (state !== undefined) {
        if (paused) {
          this.progress = this.dayProgress(state, now);
        } else {
          this.anchor(now, dayIndex(state) + this.progress);
        }
      }
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
    return { tick: state.tick, day: state.day, paused: this.paused, speed: this.speed };
  }

  /**
   * Commence la partie `state`. La copie de ses couches pour l'instantané se fait
   * d'abord : si elle échoue, la partie en cours continue, et rien n'a changé.
   */
  private start(state: SimState): void {
    const layers = copyLayers(state.world);
    const frame = groupsFrame(state, this.data, undefined, this.pool);
    // Les étapes qui commencent désormais partent avec les deltas ; l'image dit celles en cours.
    state.movement.journal = new LegJournal();
    // De même pour le gibier (protocole 7, ADR 0018).
    const fauna = faunaFrame(state, this.data, this.pool);
    state.fauna.journal = new FaunaJournal();
    state.fauna.changed = false;
    // Les derniers faits de la chronique ; les suivants viendront avec les deltas, les plus
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
      fauna,
      chronicle,
    });
    // Le jour en cours commence : il durera un jour entier, et le premier lot partira
    // MIN_BATCH_MS au moins après l'instantané.
    const now = this.env.now();
    this.anchor(now, dayIndex(state));
    this.lastWake = now;
    this.progress = 0;
    this.reschedule();
  }

  /** Jours écoulés selon l'horaire à l'instant `now`, fractionnaires. */
  private clockDays(now: number): number {
    return this.anchorDays + daysIn(now - this.anchorAt, this.speed);
  }

  /**
   * Avancée du jour en cours à l'instant `now`, de 0 à 1, que gardent la pause et le
   * changement de vitesse : l'avance de l'horaire sur l'état, d'un jour au plus.
   */
  private dayProgress(state: SimState, now: number): number {
    return Math.min(1, Math.max(0, this.clockDays(now) - dayIndex(state)));
  }

  /** Instant où le jour qui mène au rang `index` (dayIndex) est échu. */
  private dueAt(index: number): number {
    return this.anchorAt + daysDuration(index - this.anchorDays, this.speed);
  }

  /** Réancre l'horaire : à l'instant `now`, la partie en est à `days` jours écoulés. */
  private anchor(now: number, days: number): void {
    this.anchorAt = now;
    this.anchorDays = days;
  }

  /**
   * Programme le prochain lot, sauf en pause ou sans partie : à l'échéance du premier jour
   * qui tombe MIN_BATCH_MS au moins après la fin du dernier lot. À ×½, ×1 et ×4, c'est
   * l'échéance du jour suivant ; à ×16, celle du troisième. Un lot qui ferait ainsi plus
   * de batchDays jours trahit un horaire en avance sur l'état : un rattrapage, ou le jour
   * entamé qu'un changement de vitesse a gardé. L'hôte se réveille alors dès MIN_BATCH_MS
   * après le dernier lot, pour les seuls jours déjà échus.
   */
  private reschedule(): void {
    if (this.timer !== undefined) this.env.clearTimer(this.timer);
    this.timer = undefined;
    const state = this.state;
    if (this.paused || state === undefined) return;
    const current = dayIndex(state);
    const earliest = this.lastWake + MIN_BATCH_MS;
    const days = Math.max(1, Math.ceil(this.clockDays(earliest) - current - DUE_EPSILON));
    const at = days > batchDays(this.speed) ? earliest : this.dueAt(current + days);
    // setTimeout tronque son délai à la milliseconde : arrondi au-dessus, le réveil ne
    // tombe jamais avant l'échéance, où il ne trouverait aucun jour à faire.
    const delay = Math.max(0, Math.ceil(at - this.env.now()));
    this.timer = this.env.setTimer(() => {
      this.timer = undefined;
      try {
        this.wake();
      } finally {
        // Quoi qu'il arrive au lot, le suivant est programmé : la partie ne se fige pas.
        this.reschedule();
      }
    }, delay);
  }

  /** Un réveil : les jours échus, au plus MAX_BATCH_DAYS, puis l'horaire. */
  private wake(): void {
    const state = this.state;
    if (state === undefined) return;
    const due = Math.floor(this.clockDays(this.env.now()) + DUE_EPSILON) - dayIndex(state);
    if (due <= 0) return;
    const batch = this.runBatch(state, Math.min(due, MAX_BATCH_DAYS));
    const end = this.env.now();
    this.lastWake = end;
    if (batch.failed) {
      // Le pas mensuel a échoué : il se refait un mois de jeu plus tard, et non à chaque
      // réveil, sur un état à moitié avancé (ADR 0004, ADR 0013).
      this.anchor(end, dayIndex(state) + 1 - DAYS_PER_MONTH);
    } else if (this.clockDays(end) - dayIndex(state) > 2 * MAX_BATCH_DAYS) {
      // Trop de retard : l'horaire repart de maintenant, sans rafale ; la partie va alors
      // aussi vite qu'elle le peut.
      this.anchor(end, dayIndex(state));
    }
  }

  /**
   * Fait passer au plus `target` jours, en s'arrêtant après un pas mensuel, puis envoie un
   * seul delta pour le lot, et ses mesures. Les commandes en attente s'appliquent au début
   * du premier jour, qui les journalise. Une exception ne fige pas la partie : celle d'une
   * commande l'écarte, sans effet sur l'état ni place au journal, et se signale en erreur
   * « command » ; celle du pas mensuel se signale en erreur « internal », le jour restant
   * le dernier du mois.
   */
  private runBatch(state: SimState, target: number): Batch {
    const start = this.env.now();
    const logged = state.commandLog.length;
    const batch: Batch = {
      days: 0,
      members: undefined,
      dailyMs: 0,
      daily: 0,
      monthMs: undefined,
      faunaMs: 0,
      failed: false,
    };
    // Le jour du gibier, mesuré entre les repères de advanceDay : l'heure reste à l'hôte.
    const day = { moved: 0, faunaMs: 0 };
    const marks: DayMarks = {
      mark: (phase) => {
        if (phase === 'move') day.moved = this.env.now();
        else if (phase === 'fauna') day.faunaMs = this.env.now() - day.moved;
      },
    };
    while (batch.days < target) {
      const commands = batch.days === 0 ? state.pending.splice(0) : [];
      const monthly = state.day === DAYS_PER_MONTH - 1;
      const dayStart = this.env.now();
      try {
        day.faunaMs = 0;
        batch.members = advanceDay(state, commands, this.data, this.rejected, marks);
      } catch (error) {
        console.error(error);
        this.send({ type: 'error', code: 'internal', detail: String(error) });
        batch.failed = true;
        break;
      }
      batch.days++;
      if (monthly) {
        if (this.stepCost > 0) {
          const end = dayStart + this.stepCost;
          while (this.env.now() < end) {
            // Attente active : le pas factice occupe vraiment le worker.
          }
        }
        batch.monthMs = this.env.now() - dayStart;
        break;
      }
      batch.dailyMs += this.env.now() - dayStart;
      batch.faunaMs += day.faunaMs;
      batch.daily++;
    }
    const changed = batch.members !== undefined || this.groupsChanged(state, logged);
    if (batch.days === 0 && !changed && state.commandLog.length === logged) return batch;
    const faunaLegs = state.fauna.journal?.count ?? 0;
    const legs = this.sendDelta(state, batch.days, changed, batch.members);
    // Le lot compte son delta : l'image des groupes, la chronique et leur envoi (W-11).
    this.send({
      type: 'stats',
      stats: {
        batchMs: this.env.now() - start,
        days: batch.days,
        ...(batch.daily > 0 ? { dayMs: batch.dailyMs / batch.daily } : {}),
        ...(batch.monthMs === undefined ? {} : { monthMs: batch.monthMs }),
        walkers: state.movement.walkers,
        legs,
        animals: state.fauna.count,
        faunaLegs,
        ...(batch.daily > 0 ? { faunaMs: batch.faunaMs / batch.daily } : {}),
      },
    });
    return batch;
  }

  /**
   * Ce qui a changé depuis le dernier message : temps, jours du lot, blocs, faits nouveaux
   * de la chronique, étapes commencées pendant le lot, et l'image des groupes si `frame` le
   * demande (avec leurs membres s'ils sont connus). Renvoie le nombre d'étapes envoyées.
   */
  private sendDelta(
    state: SimState,
    days: number,
    frame: boolean,
    members: ReadonlyMap<number, readonly number[]> | undefined,
  ): number {
    const total = state.society.chronicle.length;
    const journal = state.movement.journal;
    const legs = journal !== undefined && journal.count > 0 ? journal.take(this.pool) : undefined;
    // Le gibier : ses étapes du lot, et son image au pas mensuel (members connus) ou quand des
    // animaux ont paru ou disparu hors du mois.
    const herding = state.fauna.journal;
    const faunaLegs =
      herding !== undefined && herding.count > 0 ? herding.take(this.pool) : undefined;
    const fauna =
      members !== undefined || state.fauna.changed
        ? faunaFrame(state, this.data, this.pool)
        : undefined;
    state.fauna.changed = false;
    // Compté avant l'envoi, qui transfère les tampons.
    const count = legs?.slots.length ?? 0;
    this.send({
      type: 'delta',
      time: this.time(state),
      days,
      chunks: takeDirtyChunks(state),
      chronicle: chronicleViews(state, this.chronicleSent, total),
      ...(legs === undefined ? {} : { legs }),
      ...(frame ? { frame: groupsFrame(state, this.data, members, this.pool) } : {}),
      ...(faunaLegs === undefined ? {} : { faunaLegs }),
      ...(fauna === undefined ? {} : { fauna }),
    });
    this.chronicleSent = total;
    return count;
  }

  private sendTime(): void {
    if (this.state !== undefined) this.send({ type: 'time', time: this.time(this.state) });
  }

  private send(message: WorkerMessage): void {
    this.env.post(message, transferablesOf(message));
  }
}
