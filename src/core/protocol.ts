/**
 * Protocole entre le fil principal et le worker de simulation (ADR 0004).
 *
 * Tous les messages sont des unions discriminées par `type`. Les gros volumes
 * voyagent en ArrayBuffer transférés : `transferablesOf` les rassemble.
 */
import type { SaveErrorCode, SaveMeta } from './save/format';
import type { SpeedId } from './time';
import type { WorldSize, WorldSizeId } from './world';

/** Version du protocole, vérifiée à la poignée de main. */
export const PROTOCOL_VERSION = 1;

/** Peint une case de la couche de test (outil de débogage de la phase 0). */
export interface PaintCommand {
  readonly type: 'paint';
  readonly x: number;
  readonly y: number;
  readonly value: number;
}

/** Commande de jeu : elle modifie l'état, et s'applique au début d'un pas (ADR 0003). */
export type GameCommand = PaintCommand;

/** Commande de jeu journalisée : `tick` est le pas au début duquel elle s'est appliquée. */
export interface LoggedCommand {
  readonly tick: number;
  readonly command: GameCommand;
}

/** Messages du fil principal vers le worker. */
export type MainMessage =
  | { readonly type: 'hello'; readonly protocol: number }
  | { readonly type: 'newGame'; readonly seed: string; readonly size: WorldSizeId }
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

/** Couche d'un bloc de carte : une valeur par case, ligne par ligne. */
export interface ChunkLayer {
  readonly column: number;
  readonly row: number;
  readonly cells: Uint8Array<ArrayBuffer>;
}

/** Ce que le fil principal sait du monde. */
export interface WorldInfo {
  readonly seed: string;
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
  | { readonly type: 'ready'; readonly protocol: number }
  /** État complet, au démarrage d'une partie. */
  | {
      readonly type: 'snapshot';
      readonly world: WorldInfo;
      readonly time: TimeInfo;
      readonly chunks: readonly ChunkLayer[];
    }
  /** Ce qui a changé depuis le dernier message : blocs modifiés et temps. */
  | { readonly type: 'delta'; readonly time: TimeInfo; readonly chunks: readonly ChunkLayer[] }
  /** Changement de vitesse ou de pause, sans pas. */
  | { readonly type: 'time'; readonly time: TimeInfo }
  | { readonly type: 'stats'; readonly stats: StepStats }
  /** Sauvegarde prête : un fichier compressé, transféré. */
  | {
      readonly type: 'saved';
      readonly requestId: number;
      readonly meta: SaveMeta;
      readonly data: ArrayBuffer;
    }
  /** Partie chargée ; l'instantané de la nouvelle partie suit. */
  | { readonly type: 'loaded'; readonly requestId: number }
  | { readonly type: 'loadFailed'; readonly requestId: number; readonly reason: SaveErrorCode }
  /** Erreur : `code` désigne le message affiché, `detail` aide au débogage. */
  | { readonly type: 'error'; readonly code: ErrorCode; readonly detail: string };

export type ErrorCode = 'protocol' | 'noGame';

/**
 * Tampons à transférer avec un message, sans copie. Chaque type de message figure ici :
 * en ajouter un oblige à dire s'il porte des tampons.
 */
export function transferablesOf(message: MainMessage | WorkerMessage): ArrayBuffer[] {
  switch (message.type) {
    case 'snapshot':
    case 'delta':
      return message.chunks.map((chunk) => chunk.cells.buffer);
    case 'saved':
    case 'load':
      return [message.data];
    case 'hello':
    case 'newGame':
    case 'game':
    case 'setSpeed':
    case 'setPaused':
    case 'stepOnce':
    case 'save':
    case 'debugStepCost':
    case 'ready':
    case 'time':
    case 'stats':
    case 'loaded':
    case 'loadFailed':
    case 'error':
      return [];
  }
}
