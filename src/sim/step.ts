/**
 * Avancée de la simulation : un pas vaut un mois. Les commandes de jeu s'appliquent
 * au début du pas, puis les systèmes s'exécutent dans un ordre fixe (ADR 0003).
 */
import { wrapX } from '../core/cylinder';
import { Fingerprint } from '../core/hash';
import type { GameCommand } from '../core/protocol';
import { setTestCell, WALKER_COUNT, WALKER_STREAM, type SimState } from './state';

/** Pas possibles d'un promeneur : est, ouest, sud, nord. */
const DIRECTIONS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * Système de test : chaque promeneur fait un pas au hasard et peint la case atteinte,
 * de la valeur 1 à 7 selon son rang. Il boucle d'est en ouest et bute sur les pôles.
 */
function moveWalkers(state: SimState): void {
  const random = state.rng.stream(WALKER_STREAM);
  const { width, height } = state.size;
  for (let walker = 0; walker < WALKER_COUNT; walker++) {
    const [dx, dy] = random.pick(DIRECTIONS);
    const x = wrapX((state.walkerX[walker] ?? 0) + dx, width);
    const y = Math.min(height - 1, Math.max(0, (state.walkerY[walker] ?? 0) + dy));
    state.walkerX[walker] = x;
    state.walkerY[walker] = y;
    setTestCell(state, x, y, (walker % 7) + 1);
  }
}

export function applyCommand(state: SimState, command: GameCommand): void {
  // Une seule commande pour l'instant : la peinture de la couche de test.
  setTestCell(state, command.x, command.y, command.value);
}

/**
 * Fait avancer l'état d'un pas. Les commandes reçues s'appliquent d'abord, et sont
 * journalisées avec le pas au début duquel elles s'appliquent.
 */
export function step(state: SimState, commands: readonly GameCommand[]): void {
  for (const command of commands) {
    state.commandLog.push({ tick: state.tick, command });
    applyCommand(state, command);
  }
  // Systèmes, dans un ordre fixe.
  moveWalkers(state);
  state.tick++;
}

/** Empreinte de l'état du monde, pour les tests de déterminisme. */
export function fingerprint(state: SimState): string {
  const fingerprint = new Fingerprint()
    .string(state.seed)
    .uint32(state.size.width)
    .uint32(state.size.height)
    .uint32(state.tick)
    .typedArray(state.testLayer)
    .typedArray(state.walkerX)
    .typedArray(state.walkerY);
  for (const [name, words] of Object.entries(state.rng.states())) {
    fingerprint.string(name);
    for (const word of words) fingerprint.uint32(word);
  }
  return fingerprint.hex();
}
