/**
 * Protocole entre le fil principal et le worker de simulation (ADR 0004).
 *
 * Tous les messages sont des unions discriminées par `type`. Les gros volumes
 * voyagent en ArrayBuffer transférés : `transferablesOf` les rassemble.
 */
import type { SaveErrorCode, SaveMeta } from './save/format';
import type { SpeedId } from './time';
import type { AgeClass } from './visual';
import { LAYER_NAMES, type GenerationStage, type WorldLayers, type WorldSize } from './world';
import type { WorldParams } from './worldParams';

/**
 * Version du protocole, vérifiée à la poignée de main. Version 8 (tâche 2b.7, ADR 0019) :
 * l'instantané porte les calendriers de la neige et de la glace.
 */
export const PROTOCOL_VERSION = 8;

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
 * Ce qu'on inspecte (IHM-02) : un individu ou un groupe. Le fil principal choisit l'individu
 * ou le groupe touché d'après ce que la carte dessine (render/crowd.ts, pickEntity).
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
 * jour-là, celle de son membre le plus proche du barycentre de ses membres (ADR 0014), sa
 * taille.
 */
export interface GroupSummary {
  readonly id: number;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

/** Intentions d'un vivant, dans la fiche. */
export const INTENTIONS = ['rest', 'leave', 'walk', 'carried'] as const;
export type Intention = (typeof INTENTIONS)[number];

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
  /**
   * Intention d'un vivant (ADR 0014) : au repos à sa place, en partance, en marche vers sa
   * place, ou porté par sa mère.
   */
  readonly intention?: Intention;
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
 * (x, y) est le lieu du groupe au dernier pas mensuel : celle de son membre le plus proche du
 * barycentre de ses membres (ADR 0014).
 */
export const GROUP_STRIDE = 5;

/**
 * Octet d'activité d'un humain (ADR 0021, ADR 0022) : le rang de son activité dans
 * data/activities.json sur ses quatre bits de poids faible (ACT_RANK), ACT_NONE pour qui n'en a
 * pas (un porté, qui prend l'image de sa mère) ; ACT_RUN, il court (le jeu, la charge du
 * chasseur) ; ACT_STRIKE, sur une étape seulement : le chasseur frappe au départ de cette étape.
 */
export const ACT_RANK = 0x0f;
export const ACT_NONE = 0x0f;
export const ACT_RUN = 0x10;
export const ACT_STRIKE = 0x20;

/** Aucun porteur, dans GroupsFrame.carriers. */
export const NO_CARRIER = 0xffffffff;

/**
 * Étapes des marcheurs (ADR 0014) : pour chacune, l'emplacement du marcheur, le jour où elle
 * part (dayIndex de core/time.ts), son point de départ et son pas par jour, x puis y, en
 * unités de core/position.ts, et ses jours. À l'instant t, fractionnaire, le marcheur se tient
 * en start + step × min(max(t − day, 0), count) (legAt), x ramené dans le monde : aux jours
 * entiers, la position exacte du worker. Pour un emplacement, l'étape qui vaut est la dernière
 * reçue de celles qui sont parties : une étape d'un même jour remplace la précédente (un écart
 * de côté).
 */
export interface LegArrays {
  readonly slots: Uint32Array<ArrayBuffer>;
  readonly days: Uint32Array<ArrayBuffer>;
  readonly start: Int32Array<ArrayBuffer>;
  readonly step: Int32Array<ArrayBuffer>;
  readonly count: Uint16Array<ArrayBuffer>;
}

/**
 * Groupes du monde, pour la carte (ADR 0014) : GROUP_STRIDE entiers par groupe, puis, membre
 * par membre, groupe après groupe, son emplacement, son identifiant, son code d'apparence
 * (core/visual.ts), sa stature en 1/128 de case, sa position (x, y, en unités de
 * core/position.ts) et l'emplacement de qui le porte (NO_CARRIER s'il marche). `legs` donne
 * l'étape en cours de chaque marcheur, repartie de l'instant de l'image : jusqu'à l'image
 * suivante, les deltas apportent les étapes qui commencent.
 */
export interface GroupsFrame {
  readonly groups: Uint32Array<ArrayBuffer>;
  readonly slots: Uint32Array<ArrayBuffer>;
  readonly ids: Uint32Array<ArrayBuffer>;
  readonly sprites: Uint16Array<ArrayBuffer>;
  readonly statures: Uint8Array<ArrayBuffer>;
  readonly positions: Int32Array<ArrayBuffer>;
  readonly carriers: Uint32Array<ArrayBuffer>;
  readonly legs: LegArrays;
}

/**
 * Allures du gibier (ADR 0018) : au repos, au pas, au galop. Une étape d'arrêt (zéro jour) a
 * l'allure du repos.
 */
export const FAUNA_GAIT = { rest: 0, walk: 1, run: 2 } as const;

/**
 * Étapes du gibier (protocole 7) : celles des humains (LegArrays), et l'allure de chacune
 * (FAUNA_GAIT), dont le rendu tire l'image de l'animal, et non de sa vitesse apparente. Une étape
 * de zéro jour arrête l'animal à son départ : celle d'un animal qui coupe son étape pour repartir,
 * qu'une étape du même jour remplace s'il repart.
 */
export interface FaunaLegArrays extends LegArrays {
  readonly gaits: Uint8Array<ArrayBuffer>;
}

/**
 * Gibier (protocole 7, ADR 0018) : chaque animal vivant, par emplacements croissants, son
 * emplacement, son identifiant, sa sorte (FAUNA_SPECIES, FAUNA_YOUNG, FAUNA_MALE, FAUNA_RUN), sa
 * position (x, y, en unités de core/position.ts), et l'étape en cours de qui marche, repartie de
 * l'instant de l'image, à l'allure que dit FAUNA_RUN. Les deltas apportent ensuite les étapes qui
 * commencent (FaunaLegArrays). Rien de plus : l'identifiant de la harde, que le fil principal ne
 * lit pas, ne voyage pas (relecture 2b.6, problème 16 ; 2b.8 l'ajoutera s'il lui sert). Les étapes
 * de l'image gardent le format de celles des humains, jour compris (celui de l'image), que la
 * chronologie lit comme les autres (LegQueue, legAt) : quatre octets par animal en route.
 */
export interface FaunaFrame {
  readonly slots: Uint32Array<ArrayBuffer>;
  readonly ids: Uint32Array<ArrayBuffer>;
  readonly kinds: Uint8Array<ArrayBuffer>;
  readonly positions: Int32Array<ArrayBuffer>;
  readonly legs: LegArrays;
}

/** Bits de FaunaFrame.kinds : l'espèce (rang dans data/fauna.json), puis jeune, mâle adulte, au galop. */
export const FAUNA_SPECIES = 0x0f;
export const FAUNA_YOUNG = 0x10;
export const FAUNA_MALE = 0x20;
export const FAUNA_RUN = 0x40;

/** Tampons d'étapes, à transférer. */
export function legBuffers(legs: LegArrays): ArrayBuffer[] {
  return [
    legs.slots.buffer,
    legs.days.buffer,
    legs.start.buffer,
    legs.step.buffer,
    legs.count.buffer,
  ];
}

/** Tampons d'étapes du gibier, à transférer. */
export function faunaLegBuffers(legs: FaunaLegArrays): ArrayBuffer[] {
  return [...legBuffers(legs), legs.gaits.buffer];
}

/** Tampons d'une image du gibier, à transférer. */
export function faunaBuffers(frame: FaunaFrame): ArrayBuffer[] {
  return [
    frame.slots.buffer,
    frame.ids.buffer,
    frame.kinds.buffer,
    frame.positions.buffer,
    ...legBuffers(frame.legs),
  ];
}

/** Tampons d'une image des groupes, à transférer. */
export function frameBuffers(frame: GroupsFrame): ArrayBuffer[] {
  return [
    frame.groups.buffer,
    frame.slots.buffer,
    frame.ids.buffer,
    frame.sprites.buffer,
    frame.statures.buffer,
    frame.positions.buffer,
    frame.carriers.buffer,
    ...legBuffers(frame.legs),
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
  | { readonly type: 'debugStepCost'; readonly milliseconds: number }
  /**
   * Tampons d'images et d'étapes déjà lus, rendus au worker, qui les reprend pour les envois
   * suivants (ADR 0014).
   */
  | { readonly type: 'recycle'; readonly buffers: readonly ArrayBuffer[] };

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
  /** Marcheurs à la fin du lot (ADR 0014). */
  readonly walkers: number;
  /** Étapes commencées pendant le lot, écarts de côté compris. */
  readonly legs: number;
  /** Animaux du gibier à la fin du lot, et leurs étapes commencées pendant le lot (ADR 0018). */
  readonly animals: number;
  readonly faunaLegs: number;
  /** Durée moyenne du jour du gibier, sur les jours ordinaires du lot. */
  readonly faunaMs?: number;
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
      /**
       * Calendriers de la neige et de la glace de chaque case (protocole 8 ; src/core/snow.ts,
       * worldCalendars ; ADR 0019) : quatre octets par case pour la neige de toutes les cases,
       * puis quatre pour leur glace. Aucun pas ne les change, et aucun delta ne les porte.
       */
      readonly calendars: Uint8Array<ArrayBuffer>;
      readonly frame: GroupsFrame;
      /** Le gibier, à l'instant de l'état (protocole 7, ADR 0018). */
      readonly fauna: FaunaFrame;
      readonly chronicle: readonly ChronicleView[];
    }
  /**
   * Ce qui a changé depuis le dernier message : le temps, les `days` jours du lot (0 pour
   * une commande appliquée en pause, sans que le temps avance), les blocs modifiés, les
   * faits nouveaux de la chronique, les étapes commencées pendant le lot, chacune datée de
   * son jour (ADR 0014), et l'image des groupes quand elle change (pas mensuel, commande) :
   * elle vaut à partir de l'instant `time`, et remplace alors les étapes du lot.
   */
  | {
      readonly type: 'delta';
      readonly time: TimeInfo;
      readonly days: number;
      readonly chunks: readonly ChunkPatch[];
      readonly chronicle: readonly ChronicleView[];
      readonly legs?: LegArrays;
      readonly frame?: GroupsFrame;
      /**
       * Étapes du gibier commencées pendant le lot, avec leur allure, et l'image du gibier quand
       * elle change (pas mensuel, apparitions et disparitions hors du mois) ; elle vaut à partir de
       * l'instant `time` (protocole 7).
       */
      readonly faunaLegs?: FaunaLegArrays;
      readonly fauna?: FaunaFrame;
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
        message.calendars.buffer,
        ...frameBuffers(message.frame),
        ...faunaBuffers(message.fauna),
      ];
    case 'delta':
      return [
        ...message.chunks.map((chunk) => chunk.biome.buffer),
        ...(message.legs === undefined ? [] : legBuffers(message.legs)),
        ...(message.frame === undefined ? [] : frameBuffers(message.frame)),
        ...(message.faunaLegs === undefined ? [] : faunaLegBuffers(message.faunaLegs)),
        ...(message.fauna === undefined ? [] : faunaBuffers(message.fauna)),
      ];
    case 'recycle':
      return [...message.buffers];
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
