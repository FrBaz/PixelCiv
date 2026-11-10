/**
 * Rejeu d'une partie (ADR 0003) : le même monde et le même journal de commandes
 * redonnent le même état, pas pour pas.
 */
import type { GameCommand, LoggedCommand } from '../core/protocol';
import { copyLayers, type WorldLayers } from '../core/world';
import type { WorldParams } from '../core/worldParams';
import { createState, type SimState } from './state';
import { step, type SimContent } from './step';

/** Rejoue `log` sur une copie du monde `world`, généré pour `params`, jusqu'au pas `ticks`. */
export function replay(
  params: WorldParams,
  world: WorldLayers,
  log: readonly LoggedCommand[],
  ticks: number,
  content: SimContent,
): SimState {
  const state = createState(params, copyLayers(world));
  let next = 0;
  while (state.tick < ticks) {
    const commands: GameCommand[] = [];
    for (; next < log.length; next++) {
      const entry = log.at(next);
      if (entry?.tick !== state.tick) break;
      commands.push(entry.command);
    }
    step(state, commands, content);
  }
  return state;
}
