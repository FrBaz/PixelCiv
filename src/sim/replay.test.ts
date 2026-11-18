import { describe, expect, it } from 'vitest';
import type { GameCommand } from '../core/protocol';
import { dayIndex, timeOfDayIndex } from '../core/time';
import { advanceDay, step } from './day';
import { replay } from './replay';
import { applyCommands, fingerprint } from './step';
import {
  cellsOf,
  firstCellOf,
  scatteredGroups,
  testData,
  testParams,
  testState,
  testWorld,
} from './testing';

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
    const replayed = replay(
      testParams(),
      testWorld(),
      state.commandLog,
      { tick: 40, day: 0 },
      testData,
    );
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
    const replayed = replay(
      testParams(),
      testWorld(),
      beforeStep.commandLog,
      { tick: 12, day: 0 },
      testData,
    );
    expect(fingerprint(replayed)).toBe(fingerprint(inStep));
  });

  it('redonne une partie en pause, commandes de son pas courant comprises, même d’un journal plus long (U-7)', () => {
    const state = testState();
    const spawns = scatteredGroups(state, 4, 8);
    const cell = firstCellOf(state, (family) => family !== 'water');
    const paint: GameCommand = { type: 'paintBiome', ...cell, biome: 'desert' };
    // Commandes appliquées en pause dès leur réception, avant que les pas 3 et 7 ne commencent.
    const inPause = new Map<number, GameCommand[]>([
      [3, spawns.slice(0, 2)],
      [7, [...spawns.slice(2), paint]],
    ]);
    // Empreintes de la partie en pause, juste après ces commandes.
    const paused = new Map<number, string>();
    for (let tick = 0; tick < 12; tick++) {
      const commands = inPause.get(tick);
      if (commands !== undefined) {
        applyCommands(state, commands, testData);
        paused.set(tick, fingerprint(state));
        // Le journal que garderait une sauvegarde prise à cet instant redonne la partie.
        const replayed = replay(
          testParams(),
          testWorld(),
          state.commandLog,
          { tick: tick, day: 0 },
          testData,
        );
        expect(fingerprint(replayed)).toBe(fingerprint(state));
        expect(replayed.commandLog).toEqual(state.commandLog);
      }
      step(state, tick === 5 ? [{ ...paint, biome: 'steppe' }] : [], testData);
    }
    // Le journal entier, plus long, redonne ces mêmes états, puis la partie à son dernier pas.
    for (const [tick, print] of paused) {
      const replayed = replay(
        testParams(),
        testWorld(),
        state.commandLog,
        { tick: tick, day: 0 },
        testData,
      );
      expect(fingerprint(replayed)).toBe(print);
    }
    const replayed = replay(
      testParams(),
      testWorld(),
      state.commandLog,
      { tick: 12, day: 0 },
      testData,
    );
    expect(fingerprint(replayed)).toBe(fingerprint(state));
    expect(replayed.commandLog).toEqual(state.commandLog);
  });

  it('rejoue au jour près, commandes en cours de mois et en pause comprises (ADR 0013)', () => {
    const state = testState();
    const spawns = scatteredGroups(state, 8, 10);
    const cell = firstCellOf(state, (family) => family !== 'water');
    // Commandes reçues en marche, appliquées au début d'un jour (advanceDay), et en pause,
    // dès leur réception, à l'instant courant (applyCommands), puis empreintes à ces instants.
    const running = new Map<number, GameCommand[]>([
      [dayIndex({ tick: 0, day: 5 }), spawns.slice(0, 2)],
      [dayIndex({ tick: 1, day: 29 }), [{ type: 'paintBiome', ...cell, biome: 'desert' }]],
      [dayIndex({ tick: 3, day: 11 }), spawns.slice(2, 4)],
    ]);
    const paused = new Map<number, GameCommand[]>([
      [dayIndex({ tick: 0, day: 17 }), spawns.slice(4, 6)],
      [dayIndex({ tick: 2, day: 0 }), spawns.slice(6)],
      [dayIndex({ tick: 3, day: 11 }), [{ type: 'paintBiome', ...cell, biome: 'steppe' }]],
    ]);
    const prints = new Map<number, string>();
    /** Empreintes en pause, juste après les commandes, et journal à cet instant. */
    const pauses: { index: number; print: string; log: number }[] = [];
    while (state.tick < 5) {
      const now = dayIndex(state);
      const inPause = paused.get(now);
      if (inPause !== undefined) {
        applyCommands(state, inPause, testData);
        pauses.push({ index: now, print: fingerprint(state), log: state.commandLog.length });
      }
      advanceDay(state, running.get(now) ?? [], testData);
      if (state.day % 9 === 4) prints.set(dayIndex(state), fingerprint(state));
    }
    expect(state.commandLog.map((entry) => [entry.tick, entry.day])).toEqual([
      [0, 5],
      [0, 5],
      [0, 17],
      [0, 17],
      [1, 29],
      [2, 0],
      [2, 0],
      [3, 11],
      [3, 11],
      [3, 11],
    ]);
    expect(prints.size).toBeGreaterThan(10);
    // Le journal que garderait une sauvegarde prise en pause redonne la partie de l'instant.
    for (const { index, print, log } of pauses) {
      const until = timeOfDayIndex(index);
      const kept = state.commandLog.slice(0, log);
      expect(fingerprint(replay(testParams(), testWorld(), kept, until, testData))).toBe(print);
    }
    // Le journal entier redonne la partie à chacun des autres instants, puis à la fin.
    for (const [index, print] of prints) {
      const until = timeOfDayIndex(index);
      const replayed = replay(testParams(), testWorld(), state.commandLog, until, testData);
      expect([replayed.tick, replayed.day]).toEqual([until.tick, until.day]);
      expect(fingerprint(replayed), `${String(until.tick)}:${String(until.day)}`).toBe(print);
    }
    const end = replay(testParams(), testWorld(), state.commandLog, state, testData);
    expect(fingerprint(end)).toBe(fingerprint(state));
    expect(end.dayPositions.positions).toEqual(state.dayPositions.positions);
  });

  it("s'arrête au pas demandé", () => {
    expect(replay(testParams(), testWorld(), [], { tick: 7, day: 0 }, testData).tick).toBe(7);
  });
});
