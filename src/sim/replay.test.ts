import { describe, expect, it } from 'vitest';
import type { GameCommand } from '../core/protocol';
import { replay } from './replay';
import { applyCommands, fingerprint, step } from './step';
import { cellsOf, scatteredGroups, testData, testParams, testState, testWorld } from './testing';

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

  it('ne distingue pas des commandes appliquées avant leur pas, en pause, de celles du pas (U-7)', () => {
    const spawns = scatteredGroups(testState(), 6, 8);
    const commands = (tick: number) => (tick % 4 === 0 ? spawns.slice(tick / 4, tick / 4 + 2) : []);
    // L'une applique les commandes au début de chaque pas ; l'autre dès leur réception, en
    // pause, puis fait le pas sans elles.
    const inStep = testState();
    const beforeStep = testState();
    for (let tick = 0; tick < 12; tick++) {
      step(inStep, commands(tick), testData);
      applyCommands(beforeStep, commands(tick), testData);
      step(beforeStep, [], testData);
    }
    expect(beforeStep.commandLog).toEqual(inStep.commandLog);
    expect(beforeStep.commandLog.map((entry) => entry.tick)).toEqual([0, 0, 4, 4, 8, 8]);
    expect(fingerprint(beforeStep)).toBe(fingerprint(inStep));
    const replayed = replay(testParams(), testWorld(), beforeStep.commandLog, 12, testData);
    expect(fingerprint(replayed)).toBe(fingerprint(inStep));
  });

  it("s'arrête au pas demandé", () => {
    expect(replay(testParams(), testWorld(), [], 7, testData).tick).toBe(7);
  });
});
