/**
 * Sous-pas quotidien (ADR 0013, ADR 0014) : la seconde horloge de la simulation. Chaque jour,
 * les commandes reçues s'appliquent, puis les systèmes quotidiens avancent d'un jour, chacun
 * sur ses seuls actifs ; au soir du trentième jour vient le pas mensuel (monthStep), qui
 * garde ses systèmes, leur ordre et leurs tirages.
 *
 * Le système quotidien de 2b.3 est le mouvement des individus (movement.ts), dans un ordre
 * fixe : les départs du jour, (2b.8 : les activités), la marche, l'espacement des marcheurs
 * un jour sur `walkers.every` (trois, data/nomads.json), puis les arrivées. Seuls les
 * marcheurs et les partants du jour coûtent ; ce qu'ils décident ne dépend pas de l'ordre des
 * listes, ou passe dans un ordre canonique, et ne tire au sort que sur `sim.camp`. Le gibier
 * (fauna.ts, ADR 0018) suit, sur son propre flux, `sim.fauna`, et ne change rien des humains.
 * L'état ne dépend donc ni de la vitesse ni du regroupement des jours en lots.
 */
import type { GameCommand } from '../core/protocol';
import { dayIndex, DAYS_PER_MONTH } from '../core/time';
import { shoreLegs } from './activities';
import { faunaDay, rebuildFauna } from './fauna';
import { moveDay, rebuildMovement } from './movement';
import type { SimState } from './state';
import { applyCommands, monthStep, type RejectedCommand, type SimContent } from './step';

/**
 * Fait passer un jour : les commandes s'appliquent d'abord, à l'instant courant (sans
 * `rejected`, l'exception d'une commande remonte ; avec, la commande est écartée et
 * signalée, et le jour continue), puis le mouvement du jour (moveDay) mène chacun de cet
 * instant au suivant. Le trentième jour, le pas mensuel suit, et le mois suivant commence à
 * son jour 0 ; advanceDay renvoie alors les membres de chaque groupe, que donne le pas
 * mensuel, et undefined les autres jours. Si le pas mensuel lève une exception, elle
 * remonte : le jour reste le dernier du mois, et les caches du mouvement se refont d'après
 * l'état, peut-être à moitié avancé.
 */
export function advanceDay(
  state: SimState,
  commands: readonly GameCommand[],
  content: SimContent,
  rejected?: RejectedCommand,
  marks?: DayMarks,
): ReadonlyMap<number, readonly number[]> | undefined {
  applyCommands(state, commands, content, rejected);
  // Systèmes quotidiens, dans un ordre fixe, chacun sur ses actifs : le mouvement des humains,
  // puis le gibier, qui les fuit (ADR 0018).
  try {
    marks?.mark('start');
    moveDay(state, content);
    marks?.mark('move');
    faunaDay(state, content);
    marks?.mark('fauna');
  } catch (error) {
    rebuildMovement(state);
    rebuildFauna(state.fauna);
    throw error;
  }
  if (state.day < DAYS_PER_MONTH - 1) {
    state.day++;
    shoreLegs(state, content, dayIndex(state));
    return undefined;
  }
  // Le soir du trentième jour vient le pas mensuel.
  try {
    const members = monthStep(state, content);
    state.day = 0;
    shoreLegs(state, content, dayIndex(state));
    return members;
  } catch (error) {
    rebuildMovement(state);
    rebuildFauna(state.fauna);
    throw error;
  }
}

/**
 * Repères d'un jour, que l'hôte du worker pose pour mesurer ses systèmes : il lit l'heure, la
 * simulation jamais (ADR 0004). `start` avant le mouvement des humains, `move` après lui, `fauna`
 * après le gibier.
 */
export interface DayMarks {
  mark(phase: 'start' | 'move' | 'fauna'): void;
}

/**
 * Fait passer le reste du mois, jour après jour, jusqu'au pas mensuel compris : un mois
 * entier depuis son jour 0. Les commandes s'appliquent au premier de ces jours, à l'instant
 * courant. Renvoie les membres de chaque groupe à la fin du mois, dans l'ordre des
 * emplacements, tels que les donnerait groupMembers.
 */
export function step(
  state: SimState,
  commands: readonly GameCommand[],
  content: SimContent,
  rejected?: RejectedCommand,
): ReadonlyMap<number, readonly number[]> {
  let members = advanceDay(state, commands, content, rejected);
  while (members === undefined) members = advanceDay(state, [], content);
  return members;
}
