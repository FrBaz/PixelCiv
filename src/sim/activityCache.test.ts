import { describe, expect, it } from 'vitest';
import { FIXED } from '../core/position';
import { dayIndex, DAYS_PER_MONTH } from '../core/time';
import { describeActivities } from './activities';
import { Agenda, SpotGrid } from './activityCache';
import { advanceDay } from './day';
import { spawnGroup } from './spawn';
import { testData, testState, scatteredGroups, withoutFauna } from './testing';

describe('caches des activités (ADR 0021, § 11)', () => {
  it('range dans l’agenda un emplacement au-delà de sa capacité, sans décrocher la liste du jour', () => {
    // Relecture de 2b.8, problème 8 : l'écriture hors des tableaux tombait dans le vide, la tête de
    // la liste pointait vers un emplacement sans suivant, et les choix du jour se perdaient.
    const agenda = new Agenda();
    agenda.set(5, 10);
    agenda.set(70, 10);
    agenda.set(3, 10);
    agenda.set(200, 11);
    expect(agenda.dayOf(70)).toBe(10);
    expect(agenda.entries()).toEqual([
      [3, 10],
      [5, 10],
      [70, 10],
      [200, 11],
    ]);
    const due: number[] = [];
    agenda.take(10, due);
    expect(due.sort((a, b) => a - b)).toEqual([3, 5, 70]);
    agenda.take(11, due);
    expect(due).toContain(200);
    expect(agenda.entries()).toEqual([]);
  });

  it('range dans la grille un lieu au-delà de sa capacité, et le retrouve', () => {
    const spots = new SpotGrid(8, 8);
    const at = (cells: number) => Math.round(cells * FIXED);
    spots.set(300, at(2.5), at(2.5));
    spots.set(1, at(2.6), at(2.5));
    expect(spots.has(300)).toBe(true);
    expect(spots.entries().map(([slot]) => slot)).toEqual([1, 300]);
    // Le plus proche de (2,5 ; 2,9), hors du lieu 1 : celui de 300, à 0,4 case.
    expect(spots.nearest(at(2.5), at(2.9), 0.45, 1)).toBeCloseTo(0.4, 3);
    spots.release(300);
    expect(spots.entries().map(([slot]) => slot)).toEqual([1]);
  });

  it('tient l’agenda d’une partie peuplée par spawnGroup appelé directement, et chacun y choisit', () => {
    // Les tests et le banc d'essai font apparaître des groupes hors d'applyCommands, qui refait les
    // caches : l'agenda doit pourtant être juste dès l'apparition.
    const content = withoutFauna(testData);
    const state = testState('graine', content);
    for (const command of scatteredGroups(state, 20, 30)) spawnGroup(state, command, content);
    expect(describeActivities(state).problems).toEqual([]);
    const before = state.movement.acts.counts.decisions;
    for (let day = 0; day < DAYS_PER_MONTH - 1; day++) advanceDay(state, [], content);
    expect(describeActivities(state).problems).toEqual([]);
    // Chacun choisit au plus tard au bout d'un repos ; tous ont choisi avant le pas mensuel ou y
    // choisiront : au moins la moitié des vivants dans le mois.
    expect(state.movement.acts.counts.decisions - before).toBeGreaterThan(state.people.count / 2);
    const { until } = state.people.columns;
    const now = dayIndex(state);
    state.people.forEach((slot) => {
      const day = until[slot] ?? 0;
      expect(day === 0 || day < 0 || day >= now, `emplacement ${String(slot)}`).toBe(true);
    });
  });
});
