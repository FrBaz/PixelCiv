/**
 * Sous-pas quotidien (ADR 0013) : la seconde horloge de la simulation. Chaque jour, les
 * commandes reçues s'appliquent, puis les systèmes quotidiens avancent d'un jour, chacun
 * sur ses seuls actifs ; au soir du trentième jour vient le pas mensuel (monthStep), qui
 * garde ses systèmes, leur ordre et leurs tirages.
 *
 * En 2b.2, le seul système quotidien est la marche des groupes : les marches en cours
 * avancent d'un jour dans le cache des positions (DayPositions), et rien d'autre ne
 * bouge ; sans commande, un jour ne change de l'état que `day`. L'état ne dépend donc ni
 * de la vitesse ni du regroupement des jours en lots. Viendront, dans cet ordre, les
 * activités des individus (2b.8), puis leurs positions (2b.3), qui en découlent : seuls
 * les systèmes qui agissent sur l'état tournent ici, chacun sur ses actifs et sur son
 * propre flux du générateur ; ceux qui n'en calculent qu'une fonction pure se calculent
 * dans le rendu, pour les seuls visibles.
 */
import type { GameCommand } from '../core/protocol';
import { DAYS_PER_MONTH } from '../core/time';
import { rebuildPositions, type SimState } from './state';
import { applyCommands, monthStep, type RejectedCommand, type SimContent } from './step';

/**
 * Fait passer un jour : les commandes s'appliquent d'abord, à l'instant courant (sans
 * `rejected`, l'exception d'une commande remonte ; avec, la commande est écartée et
 * signalée, et le jour continue), puis les marches en cours avancent. Le trentième jour,
 * le pas mensuel suit, et le mois suivant commence à son jour 0 ; advanceDay renvoie
 * alors les membres de chaque groupe, que donne le pas mensuel, et undefined les autres
 * jours. Si le pas mensuel lève une exception, elle remonte : le jour reste le dernier du
 * mois, et les positions du jour se recalculent d'après l'état, peut-être à moitié avancé.
 */
export function advanceDay(
  state: SimState,
  commands: readonly GameCommand[],
  content: SimContent,
  rejected?: RejectedCommand,
): ReadonlyMap<number, readonly number[]> | undefined {
  applyCommands(state, commands, content, rejected);
  if (state.day < DAYS_PER_MONTH - 1) {
    state.day++;
    // Systèmes quotidiens, dans un ordre fixe, chacun sur ses actifs : les marches.
    state.dayPositions.advance(state.walks, state.day, state.size.width);
    return undefined;
  }
  // Le trentième jour : toutes les marches arrivent, puis vient le pas mensuel.
  try {
    const members = monthStep(state, content);
    state.day = 0;
    return members;
  } finally {
    rebuildPositions(state);
  }
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
