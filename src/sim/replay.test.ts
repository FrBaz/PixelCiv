import { describe, expect, it } from 'vitest';
import type { GameCommand } from '../core/protocol';
import { replay } from './replay';
import { fingerprint, step } from './step';
import { cellsOf, testData, testParams, testState, testWorld } from './testing';

describe('replay', () => {
  it("redonne l'état d'une partie à partir de son monde et de son journal", () => {
    const state = testState();
    const cells = cellsOf(state, (family) => family !== 'water', 20);
    const biomes = ['desert', 'steppe', 'glacier', 'taiga'];
    for (let tick = 0; tick < 40; tick++) {
      const commands: GameCommand[] = [];
      const cell = cells.at(tick % cells.length);
      if (tick % 3 === 0 && cell !== undefined) {
        commands.push({ type: 'paintBiome', ...cell, biome: biomes[tick % 4] ?? 'desert' });
      }
      step(state, commands, testData);
    }
    const replayed = replay(testParams(), testWorld(), state.commandLog, 40, testData);
    expect(fingerprint(replayed)).toBe(fingerprint(state));
    expect(replayed.commandLog).toEqual(state.commandLog);
  });

  it("s'arrête au pas demandé", () => {
    expect(replay(testParams(), testWorld(), [], 7, testData).tick).toBe(7);
  });
});
