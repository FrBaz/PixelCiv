/**
 * Protocole entre le fil principal et le worker de simulation (ADR 0004).
 *
 * Tous les messages sont des unions discriminées par `type`. Les gros volumes
 * voyagent en ArrayBuffer transférés : `transferablesOf` les rassemble.
 */
import type { SaveErrorCode, SaveMeta } from './save/format';
import type { SpeedId } from './time';
import type { AgeClass } from './visual';
import type { WalkArrays } from './walk';
import { LAYER_NAMES, type GenerationStage, type WorldLayers, type WorldSize } from './world';
import type { WorldParams } from './worldParams';

/** Version du protocole, vérifiée à la poignée de main. */
export const PROTOCOL_VERSION = 5;

/**
 * Pinceau de biome : donne à une case de terre un autre biome de terre. C'est un outil
 * de débogage, qui préfigure les pouvoirs du Créateur (CRE-02) ; le biome est désigné
 * par son identifiant, qui survit aux changements du contenu.
 */
export interface PaintBiomeCommand {
  readonly type: 'paintBiome';
  readonly x: number;
  readonly y: number;
  readonly biome: string;
}

/**
 * Apparition d'un groupe nomade, outil du Créateur (CRE-03) : `count` individus d'une
 * sous-espèce, désignés par leurs identifiants, sur la case (x, y). Ils reçoivent une
 * langue et une culture embryonnaires (C2, D4).
 */
export interface SpawnGroupCommand {
  readonly type: 'spawnGroup';
  readonly x: number;
  readonly y: number;
  readonly species: string;
  readonly subspecies: string;
  readonly count: number;
}

/** Commande de jeu : elle modifie l'état, et s'applique au début d'un jour (ADR 0003, 0013). */
export type GameCommand = PaintBiomeCommand | SpawnGroupCommand;

/**
 * Commande de jeu journalisée, avec l'instant où elle s'est appliquée : `tick` mois et
 * `day` jours écoulés (GameTime), avant que le jour suivant ne passe.
 */
export interface LoggedCommand {
  readonly tick: number;
  readonly day: number;
  readonly command: GameCommand;
}

/**
 * Ce qu'on inspecte (IHM-02) : un individu ou un groupe. Le fil principal choisit le groupe
 * touché d'après ce que la carte dessine (render/crowd.ts, pickGroup).
 */
export type InspectTarget =
  | { readonly kind: 'person'; readonly id: number }
  | { readonly kind: 'group'; readonly id: number };

/** Un individu en quelques mots : de quoi le nommer et le désigner. */
export interface PersonSummary {
  readonly id: number;
  readonly name: string;
  readonly sex: number;
  /** Âge en années révolues, aujourd'hui ou à sa mort. */
  readonly age: number;
  /**
   * Classe d'âge, aujourd'hui ou à sa mort, selon les âges de son espèce (core/life.ts) :
   * celle de son mini-sprite.
   */
  readonly stage: AgeClass;
  readonly alive: boolean;
}

/**
 * Un groupe en quelques mots : son nom (celui de son meneur), la case où il se tient ce
 * jour-là, en marche ou au repos (ADR 0013), sa taille.
 */
export interface GroupSummary {
  readonly id: number;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

/** Fiche d'un individu (IHM-02) : identité, gènes exprimés, famille, groupe. */
export interface PersonView extends PersonSummary {
  readonly birth: number;
  /** Pas de sa mort et sa cause, pour un mort. */
  readonly death?: number;
  readonly cause?: string;
  readonly species: string;
  /** Culture : son identifiant, qui choisit l'habit du portrait. */
  readonly culture: number;
  /** Parts de chaque sous-espèce de son ascendance, de 0 à 1, les plus grandes d'abord. */
  readonly ancestry: readonly { readonly subspecies: string; readonly share: number }[];
  /** Génome, pour son portrait. */
  readonly genome: readonly number[];
  /** Allèle exprimé de chaque locus, et valeur de chaque trait continu (0 à 1). */
  readonly loci: readonly { readonly locus: string; readonly allele: string }[];
  readonly traits: readonly { readonly trait: string; readonly value: number }[];
  /** Taille adulte, en centimètres. */
  readonly height: number;
  /**
   * Grégarité, de 0 à 1, aujourd'hui ou à sa mort : un trait de caractère acquis (IND-07,
   * ADR 0014), hors du génome.
   */
  readonly gregariousness: number;
  /**
   * Grisonnement de ses cheveux, aujourd'hui ou à sa mort, de 0 à GREY_LEVELS − 1
   * (core/life.ts) : celui de son mini-sprite.
   */
  readonly grey: number;
  /** Nutrition, de 0 à 1, et grossesse en cours, pour un vivant. */
  readonly nutrition: number;
  readonly pregnant: boolean;
  readonly mother?: PersonSummary;
  readonly father?: PersonSummary;
  readonly partner?: PersonSummary;
  readonly children: readonly PersonSummary[];
  readonly siblings: readonly PersonSummary[];
  readonly group?: GroupSummary;
}

/** Fiche d'un groupe nomade (IHM-02). */
export interface GroupView extends GroupSummary {
  readonly founded: number;
  readonly parent?: GroupSummary;
  /** Règle de nommage de sa culture (IND-08). */
  readonly naming: string;
  /** Réserve de nourriture, en mois de besoin du groupe. */
  readonly reserve: number;
  readonly homeX: number;
  readonly homeY: number;
  readonly members: readonly PersonSummary[];
}

/** Un fait de la chronique (CHR-01), prêt à afficher. */
export interface ChronicleView {
  /**
   * Rang du fait dans la chronique de la partie, de 0 pour le plus ancien : il ne change
   * jamais, sauvegarde comprise, et sert de clé à l'affichage.
   */
  readonly index: number;
  readonly tick: number;
  readonly kind: string;
  /** Groupe en cause : son identifiant (peut-être disparu), et son nom. */
  readonly groupId: number;
  readonly x: number;
  readonly y: number;
  readonly group: string;
  readonly other: string;
  readonly count: number;
}

/**
 * Faits récents de la chronique : l'instantané d'une partie les envoie, et le fil
 * principal les garde ; les plus anciens se demandent par pages (message « chronicle »).
 */
export const CHRONICLE_RECENT = 300;

/** Faits d'une page de la chronique, au plus. */
export const CHRONICLE_PAGE = 100;

/**
 * Entiers par groupe dans GroupsFrame.groups : identifiant, x, y, membres, culture. La case
 * (x, y) est celle où le groupe se tient au pas mensuel, au bout de sa marche du mois.
 */
export const GROUP_STRIDE = 5;

/**
 * Groupes du monde, pour la carte : GROUP_STRIDE entiers par groupe, un code d'apparence
 * par membre (core/visual.ts), groupe après groupe, et les marches du mois (ADR 0013).
 * Le rendu en tire la position de chaque groupe à tout instant du mois, fractionnaire
 * (walkPosition) : un groupe sans marche se tient au centre de sa case.
 */
export interface GroupsFrame {
  readonly groups: Uint32Array<ArrayBuffer>;
  readonly sprites: Uint16Array<ArrayBuffer>;
  readonly walks: WalkArrays;
}

/** Tampons d'une image des groupes, à transférer. */
function frameBuffers(frame: GroupsFrame): ArrayBuffer[] {
  const { walks } = frame;
  return [
    frame.groups.buffer,
    frame.sprites.buffer,
    walks.groups.buffer,
    walks.ends.buffer,
    walks.cells.buffer,
    walks.costs.buffer,
    walks.budgets.buffer,
  ];
}

/** Messages du fil principal vers le worker. */
export type MainMessage =
  | { readonly type: 'hello'; readonly protocol: number }
  /** Génère un monde et y commence une partie. */
  | { readonly type: 'newGame'; readonly params: WorldParams }
  /**
   * Aperçu de l'écran de création : le même monde, généré sur `width` colonnes et
   * `width / 2` lignes. La réponse porte le même numéro de requête.
   */
  | {
      readonly type: 'preview';
      readonly requestId: number;
      readonly params: WorldParams;
      readonly width: number;
    }
  /**
   * Commande de jeu : elle s'applique au début du prochain jour, ou aussitôt en pause, à
   * l'instant courant (U-7, ADR 0013).
   */
  | { readonly type: 'game'; readonly command: GameCommand }
  /** Demande la fiche d'un individu ou d'un groupe ; la réponse porte le même numéro. */
  | { readonly type: 'inspect'; readonly requestId: number; readonly target: InspectTarget }
  /**
   * Demande une page de la chronique : les CHRONICLE_PAGE faits, au plus, qui précèdent le
   * fait de rang `before`. La réponse porte le même numéro.
   */
  | { readonly type: 'chronicle'; readonly requestId: number; readonly before: number }
  | { readonly type: 'setSpeed'; readonly speed: SpeedId }
  | { readonly type: 'setPaused'; readonly paused: boolean }
  /** Avance d'un seul jour, en pause ; le pas mensuel suit si c'est le dernier du mois. */
  | { readonly type: 'stepOnce' }
  /** Demande une sauvegarde ; la réponse porte le même numéro de requête. */
  | { readonly type: 'save'; readonly requestId: number }
  /** Remplace la partie par celle d'un fichier de sauvegarde. */
  | { readonly type: 'load'; readonly requestId: number; readonly data: ArrayBuffer }
  /** Coût factice ajouté à chaque pas mensuel, en millisecondes (débogage). */
  | { readonly type: 'debugStepCost'; readonly milliseconds: number };

/**
 * Bloc de carte modifié : les couches que la simulation peut changer, sur ses 64 × 64
 * cases, ligne par ligne. Pour l'instant, le seul biome.
 */
export interface ChunkPatch {
  readonly column: number;
  readonly row: number;
  readonly biome: Uint8Array<ArrayBuffer>;
}

/** Ce que le fil principal sait du monde. */
export interface WorldInfo {
  readonly params: WorldParams;
  readonly size: WorldSize;
}

/** Temps de la partie : l'instant de l'état (GameTime), la pause et la vitesse. */
export interface TimeInfo {
  /** Pas mensuels faits, donc mois écoulés, depuis le début de la partie. */
  readonly tick: number;
  /** Jours écoulés du mois en cours, de 0 à 29 (ADR 0013). */
  readonly day: number;
  readonly paused: boolean;
  readonly speed: SpeedId;
}

/** Mesures d'un lot de jours du worker, pour le panneau de débogage et l'horloge du rendu. */
export interface StepStats {
  /**
   * Durée du lot, en millisecondes : ses jours, son pas mensuel s'il y en a eu un, puis
   * son delta, de la construction de l'image des groupes et des faits à leur envoi.
   */
  readonly batchMs: number;
  /** Jours du lot, pas mensuel compris. */
  readonly days: number;
  /** Durée moyenne d'un jour du lot, hors pas mensuel ; absente sans jour ordinaire. */
  readonly dayMs?: number;
  /** Durée du pas mensuel du lot, s'il y en a eu un. */
  readonly monthMs?: number;
  /** Marches en cours à la fin du lot. */
  readonly walks: number;
}

/** Messages du worker vers le fil principal. */
export type WorkerMessage =
  /**
   * Poignée de main réussie. `determinism` : le générateur redonne-t-il, dans ce moteur,
   * l'empreinte du monde de référence (ADR 0003) ?
   */
  | { readonly type: 'ready'; readonly protocol: number; readonly determinism: boolean }
  /** Génération en cours : l'étape `stage` commence, la `step`-ième sur `steps`. */
  | {
      readonly type: 'progress';
      readonly stage: GenerationStage;
      readonly step: number;
      readonly steps: number;
    }
  /** Génération terminée, en `milliseconds` ; l'instantané de la partie suit. */
  | { readonly type: 'generated'; readonly milliseconds: number }
  /**
   * État complet, au démarrage d'une partie : le monde et toutes ses couches, les groupes,
   * et les derniers faits de la chronique.
   */
  | {
      readonly type: 'snapshot';
      readonly world: WorldInfo;
      readonly time: TimeInfo;
      readonly layers: WorldLayers;
      readonly frame: GroupsFrame;
      readonly chronicle: readonly ChronicleView[];
    }
  /**
   * Ce qui a changé depuis le dernier message : le temps, les `days` jours du lot (0 pour
   * une commande appliquée en pause, sans que le temps avance), les blocs modifiés, les
   * faits nouveaux de la chronique, et l'image des groupes quand elle change (pas mensuel,
   * commande) : elle vaut à partir de l'instant `time`.
   */
  | {
      readonly type: 'delta';
      readonly time: TimeInfo;
      readonly days: number;
      readonly chunks: readonly ChunkPatch[];
      readonly chronicle: readonly ChronicleView[];
      readonly frame?: GroupsFrame;
    }
  /** Fiche demandée ; ni l'un ni l'autre si la cible n'existe pas. */
  | {
      readonly type: 'inspection';
      readonly requestId: number;
      readonly person?: PersonView;
      readonly group?: GroupView;
    }
  /**
   * Page de la chronique demandée : ses faits, du plus ancien au plus récent, de rangs
   * consécutifs ; aucun sans partie, ou avant le premier fait.
   */
  | {
      readonly type: 'chroniclePage';
      readonly requestId: number;
      readonly facts: readonly ChronicleView[];
    }
  /** Changement de vitesse ou de pause, sans pas. */
  | { readonly type: 'time'; readonly time: TimeInfo }
  | { readonly type: 'stats'; readonly stats: StepStats }
  /** Aperçu demandé : biome et altitude de chaque case du monde réduit. */
  | {
      readonly type: 'previewReady';
      readonly requestId: number;
      readonly size: WorldSize;
      readonly biome: Uint8Array<ArrayBuffer>;
      readonly elevation: Int16Array<ArrayBuffer>;
    }
  /** Sauvegarde prête : un fichier compressé, transféré. */
  | {
      readonly type: 'saved';
      readonly requestId: number;
      readonly meta: SaveMeta;
      readonly data: ArrayBuffer;
    }
  /**
   * Sauvegarde impossible : aucune partie n'est en cours, la partie dépasse ce que le
   * format admet (`size`, la lecture la refuserait), ou l'écriture a échoué.
   */
  | {
      readonly type: 'saveFailed';
      readonly requestId: number;
      readonly reason: 'noGame' | 'size' | 'failed';
    }
  /** Partie chargée ; l'instantané de la nouvelle partie l'a précédé. */
  | { readonly type: 'loaded'; readonly requestId: number }
  | { readonly type: 'loadFailed'; readonly requestId: number; readonly reason: SaveErrorCode }
  /** Erreur : `code` désigne le message affiché, `detail` aide au débogage. */
  | { readonly type: 'error'; readonly code: ErrorCode; readonly detail: string };

/**
 * Erreurs : poignée de main absente ou refusée, commande sans partie, commande refusée
 * (invalide, sur une case où elle ne peut rien, ou en échec à son application, sans effet
 * sur la partie), paramètres de monde invalides, ou défaut du worker lui-même.
 */
export type ErrorCode = 'protocol' | 'noGame' | 'command' | 'params' | 'internal';

/**
 * Tampons à transférer avec un message, sans copie. Chaque type de message figure ici :
 * en ajouter un oblige à dire s'il porte des tampons.
 */
export function transferablesOf(message: MainMessage | WorkerMessage): ArrayBuffer[] {
  switch (message.type) {
    case 'snapshot':
      return [
        ...LAYER_NAMES.map((name) => message.layers[name].buffer),
        ...frameBuffers(message.frame),
      ];
    case 'delta':
      return [
        ...message.chunks.map((chunk) => chunk.biome.buffer),
        ...(message.frame === undefined ? [] : frameBuffers(message.frame)),
      ];
    case 'previewReady':
      return [message.biome.buffer, message.elevation.buffer];
    case 'saved':
    case 'load':
      return [message.data];
    case 'hello':
    case 'newGame':
    case 'preview':
    case 'game':
    case 'inspect':
    case 'inspection':
    case 'chronicle':
    case 'chroniclePage':
    case 'setSpeed':
    case 'setPaused':
    case 'stepOnce':
    case 'save':
    case 'debugStepCost':
    case 'ready':
    case 'progress':
    case 'generated':
    case 'time':
    case 'stats':
    case 'saveFailed':
    case 'loaded':
    case 'loadFailed':
    case 'error':
      return [];
  }
}
