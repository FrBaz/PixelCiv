/**
 * Rejeu d'une partie (ADR 0003) : la même graine et le même journal de commandes
 * redonnent le même état, pas pour pas.
 */
import type { GameCommand, LoggedCommand } from '../core/protocol';
import type { WorldSize } from '../core/world';
import { createState, type SimState } from './state';
import { step } from './step';

export function replay(
  seed: string,
  size: WorldSize,
  log: readonly LoggedCommand[],
  ticks: number,
): SimState {
  const state = createState(seed, size);
  let next = 0;
  while (state.tick < ticks) {
    const commands: GameCommand[] = [];
    for (; next < log.length; next++) {
      const entry = log.at(next);
      if (entry?.tick !== state.tick) break;
      commands.push(entry.command);
    }
    step(state, commands);
  }
  return state;
}
