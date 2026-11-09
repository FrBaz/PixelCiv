/**
 * État affiché par l'interface, en signaux : le fil principal y range ce que le
 * worker lui envoie, et les composants se mettent à jour d'eux-mêmes.
 */
import { signal } from '@preact/signals';
import type { MainMessage, StepStats, TimeInfo } from '../core/protocol';

/** Temps de la partie, inconnu avant le premier instantané. */
export const time = signal<TimeInfo | undefined>(undefined);

/** Contenu chargé depuis data/, pour le panneau de débogage. */
export const content = signal<{ readonly biomes: number } | undefined>(undefined);

/** Mesures du dernier pas. */
export const stats = signal<StepStats | undefined>(undefined);

/** Ce que l'interface peut demander au jeu. */
export interface UiActions {
  send(message: MainMessage): void;
}
