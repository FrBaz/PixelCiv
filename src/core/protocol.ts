/**
 * Protocole entre le fil principal et le worker de simulation (ADR 0004).
 *
 * Tous les messages sont des unions discriminées par `type`. Les gros volumes
 * voyagent en ArrayBuffer transférés : `transferablesOf` les rassemble.
 */
import type { SaveErrorCode, SaveMeta } from './save/format';
import type { SpeedId } from './time';
import { LAYER_NAMES, type GenerationStage, type WorldLayers, type WorldSize } from './world';
import type { WorldParams } from './worldParams';

/** Version du protocole, vérifiée à la poignée de main. */
export const PROTOCOL_VERSION = 2;

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

/** Commande de jeu : elle modifie l'état, et s'applique au début d'un pas (ADR 0003). */
export type GameCommand = PaintBiomeCommand;

/** Commande de jeu journalisée : `tick` est le pas au début duquel elle s'est appliquée. */
export interface LoggedCommand {
  readonly tick: number;
  readonly command: GameCommand;
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
  | { readonly type: 'game'; readonly command: GameCommand }
  | { readonly type: 'setSpeed'; readonly speed: SpeedId }
  | { readonly type: 'setPaused'; readonly paused: boolean }
  /** Avance d'un seul pas, en pause. */
  | { readonly type: 'stepOnce' }
  /** Demande une sauvegarde ; la réponse porte le même numéro de requête. */
  | { readonly type: 'save'; readonly requestId: number }
  /** Remplace la partie par celle d'un fichier de sauvegarde. */
  | { readonly type: 'load'; readonly requestId: number; readonly data: ArrayBuffer }
  /** Coût factice ajouté à chaque pas, en millisecondes (débogage). */
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

/** Temps de la partie. */
export interface TimeInfo {
  /** Nombre de pas, donc de mois, écoulés depuis le début de la partie. */
  readonly tick: number;
  readonly paused: boolean;
  readonly speed: SpeedId;
}

/** Mesures du worker, pour le panneau de débogage. */
export interface StepStats {
  /** Durée du dernier pas, en millisecondes. */
  readonly stepMs: number;
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
  /** État complet, au démarrage d'une partie : le monde et toutes ses couches. */
  | {
      readonly type: 'snapshot';
      readonly world: WorldInfo;
      readonly time: TimeInfo;
      readonly layers: WorldLayers;
    }
  /** Ce qui a changé depuis le dernier message : blocs modifiés et temps. */
  | { readonly type: 'delta'; readonly time: TimeInfo; readonly chunks: readonly ChunkPatch[] }
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
  /** Sauvegarde impossible : aucune partie n'est en cours, ou l'écriture a échoué. */
  | {
      readonly type: 'saveFailed';
      readonly requestId: number;
      readonly reason: 'noGame' | 'failed';
    }
  /** Partie chargée ; l'instantané de la nouvelle partie l'a précédé. */
  | { readonly type: 'loaded'; readonly requestId: number }
  | { readonly type: 'loadFailed'; readonly requestId: number; readonly reason: SaveErrorCode }
  /** Erreur : `code` désigne le message affiché, `detail` aide au débogage. */
  | { readonly type: 'error'; readonly code: ErrorCode; readonly detail: string };

/**
 * Erreurs : poignée de main absente ou refusée, commande sans partie, commande ou
 * paramètres de monde invalides, ou défaut du worker lui-même.
 */
export type ErrorCode = 'protocol' | 'noGame' | 'command' | 'params' | 'internal';

/**
 * Tampons à transférer avec un message, sans copie. Chaque type de message figure ici :
 * en ajouter un oblige à dire s'il porte des tampons.
 */
export function transferablesOf(message: MainMessage | WorkerMessage): ArrayBuffer[] {
  switch (message.type) {
    case 'snapshot':
      return LAYER_NAMES.map((name) => message.layers[name].buffer);
    case 'delta':
      return message.chunks.map((chunk) => chunk.biome.buffer);
    case 'previewReady':
      return [message.biome.buffer, message.elevation.buffer];
    case 'saved':
    case 'load':
      return [message.data];
    case 'hello':
    case 'newGame':
    case 'preview':
    case 'game':
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
