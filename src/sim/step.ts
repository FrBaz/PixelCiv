/**
 * Avancée de la simulation : un pas vaut un mois. Les commandes de jeu s'appliquent
 * au début du pas, puis les systèmes s'exécutent dans un ordre fixe (ADR 0003).
 */
import { Fingerprint } from '../core/hash';
import type { GameCommand } from '../core/protocol';
import { setTestCell, type SimState } from './state';

export function applyCommand(state: SimState, command: GameCommand): void {
  // Une seule commande pour l'instant : la peinture de la couche de test.
  setTestCell(state, command.x, command.y, command.value);
}

/** Fait avancer l'état d'un pas, après avoir appliqué les commandes reçues. */
export function step(state: SimState, commands: readonly GameCommand[]): void {
  for (const command of commands) applyCommand(state, command);
  state.tick++;
}

/** Empreinte de l'état du monde, pour les tests de déterminisme. */
export function fingerprint(state: SimState): string {
  return new Fingerprint()
    .string(state.seed)
    .uint32(state.size.width)
    .uint32(state.size.height)
    .uint32(state.tick)
    .typedArray(state.testLayer)
    .hex();
}
