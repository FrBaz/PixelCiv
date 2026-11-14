/**
 * Rejeu d'une partie (ADR 0003) : le même monde et le même journal de commandes
 * redonnent le même état, pas pour pas.
 */
import type { GameCommand, LoggedCommand } from '../core/protocol';
import { copyLayers, type WorldLayers } from '../core/world';
import type { WorldParams } from '../core/worldParams';
import { createState, type SimState } from './state';
import { applyCommands, step, type SimContent } from './step';

/**
 * Rejoue `log` sur une copie du monde `world`, généré pour `params`, jusqu'au pas `ticks`.
 * Les commandes journalisées au pas `ticks` s'appliquent aussi, comme l'hôte les applique en
 * pause dès leur réception, avant que ce pas ne commence (ADR 0003) : l'état rejoué est
 * celui de la partie à cet instant, que garde une sauvegarde prise en pause. Les commandes
 * des pas suivants ne s'appliquent pas.
 */
export function replay(
  params: WorldParams,
  world: WorldLayers,
  log: readonly LoggedCommand[],
  ticks: number,
  content: SimContent,
): SimState {
  const state = createState(params, copyLayers(world), content);
  let next = 0;
  /** Commandes du journal au pas courant, à partir de la première qui reste à rejouer. */
  const due = (): GameCommand[] => {
    const commands: GameCommand[] = [];
    for (; next < log.length; next++) {
      const entry = log.at(next);
      if (entry?.tick !== state.tick) break;
      commands.push(entry.command);
    }
    return commands;
  };
  while (state.tick < ticks) step(state, due(), content);
  applyCommands(state, due(), content);
  return state;
}
