/**
 * Rejeu d'une partie (ADR 0003, ADR 0013) : le même monde et le même journal de commandes
 * redonnent le même état, jour après jour.
 */
import type { GameCommand, LoggedCommand } from '../core/protocol';
import { dayIndex, type GameTime } from '../core/time';
import { copyLayers, type WorldLayers } from '../core/world';
import type { WorldParams } from '../core/worldParams';
import { advanceDay } from './day';
import { createState, type SimState } from './state';
import { applyCommands, type SimContent } from './step';

/**
 * Rejoue `log` sur une copie du monde `world`, généré pour `params`, jour par jour,
 * jusqu'à l'instant `until`. Chaque commande s'applique à l'instant où elle a été
 * journalisée, avant que le jour suivant ne passe. Celles de l'instant `until` lui-même
 * s'appliquent aussi, comme l'hôte les applique en pause dès leur réception (ADR 0003) :
 * l'état rejoué est celui de la partie à cet instant, que garde une sauvegarde prise en
 * pause, quels qu'aient été ses vitesses, ses lots de jours et ses pauses. Les commandes
 * des instants suivants ne s'appliquent pas.
 */
export function replay(
  params: WorldParams,
  world: WorldLayers,
  log: readonly LoggedCommand[],
  until: GameTime,
  content: SimContent,
): SimState {
  const state = createState(params, copyLayers(world), content);
  const end = dayIndex(until);
  let next = 0;
  /** Commandes du journal à l'instant courant, à partir de la première qui reste à rejouer. */
  const due = (): GameCommand[] => {
    const commands: GameCommand[] = [];
    const now = dayIndex(state);
    for (; next < log.length; next++) {
      const entry = log.at(next);
      if (entry === undefined || dayIndex(entry) !== now) break;
      commands.push(entry.command);
    }
    return commands;
  };
  while (dayIndex(state) < end) advanceDay(state, due(), content);
  applyCommands(state, due(), content);
  return state;
}
