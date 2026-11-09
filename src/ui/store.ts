/**
 * État affiché par l'interface, en signaux : le fil principal y range ce que le
 * worker lui envoie, et les composants se mettent à jour d'eux-mêmes.
 */
import { signal } from '@preact/signals';
import type { MainMessage, TimeInfo, WorldInfo } from '../core/protocol';
import type { MessageKey } from '../i18n';

/** Temps de la partie, inconnu avant le premier instantané. */
export const time = signal<TimeInfo | undefined>(undefined);

/** Contenu chargé depuis data/, pour le panneau de débogage. */
export const content = signal<{ readonly biomes: number } | undefined>(undefined);

/** Monde de la partie en cours. */
export const worldInfo = signal<WorldInfo | undefined>(undefined);

/** Mesures du panneau de débogage, rafraîchies quelques fois par seconde. */
export interface DebugInfo {
  readonly fps: number;
  readonly worstFrameMs: number;
  readonly stepMs: number | undefined;
  readonly worstStepMs: number | undefined;
  readonly memoryMb: number | undefined;
  /** Moteur de rendu (webgl, webgpu) et densité de pixels de l'écran. */
  readonly renderer: { readonly name: string; readonly resolution: number };
}

export const debugInfo = signal<DebugInfo | undefined>(undefined);

/** Résultat de l'auto-test du déterminisme (ADR 0003), calculé au démarrage. */
export const determinismOk = signal<boolean | undefined>(undefined);

/** Panneau de débogage ouvert ou fermé. */
export const debugOpen = signal(false);

/** Avis passager à montrer au joueur, comme « Partie sauvegardée. ». */
export const notice = signal<MessageKey | undefined>(undefined);

/** Ce que l'interface peut demander au jeu. */
export interface UiActions {
  send(message: MainMessage): void;
  save(): Promise<void>;
  load(): Promise<void>;
  exportFile(): Promise<void>;
  importFile(file: File): Promise<void>;
}
