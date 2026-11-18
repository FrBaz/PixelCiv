import { describe, expect, it } from 'vitest';
import {
  batchDays,
  dateOfTick,
  dateOfTime,
  dayDuration,
  dayIndex,
  DAYS_PER_MONTH,
  DAYS_PER_YEAR,
  daysDuration,
  daysIn,
  MAX_BATCH_DAYS,
  MIN_BATCH_MS,
  monthDuration,
  MONTHS_PER_YEAR,
  SPEEDS,
  timeOfDayIndex,
} from './time';

describe('dateOfTick', () => {
  it("compte les mois à partir de janvier de l'an 1", () => {
    expect(dateOfTick(0)).toEqual({ year: 1, month: 0 });
    expect(dateOfTick(11)).toEqual({ year: 1, month: 11 });
    expect(dateOfTick(12)).toEqual({ year: 2, month: 0 });
    expect(dateOfTick(12 * 300 + 5)).toEqual({ year: 301, month: 5 });
  });
});

describe('instants au jour près (ADR 0013)', () => {
  it('compte douze mois de trente jours', () => {
    expect(DAYS_PER_MONTH).toBe(30);
    expect(DAYS_PER_YEAR).toBe(360);
  });

  it('ordonne les instants par leur rang en jours, et les retrouve', () => {
    expect(dayIndex({ tick: 0, day: 0 })).toBe(0);
    expect(dayIndex({ tick: 0, day: 29 })).toBe(29);
    expect(dayIndex({ tick: 1, day: 0 })).toBe(30);
    expect(dayIndex({ tick: 12, day: 7 })).toBe(367);
    for (const index of [0, 1, 29, 30, 31, 359, 360, 12_345]) {
      const time = timeOfDayIndex(index);
      expect(time.day).toBeGreaterThanOrEqual(0);
      expect(time.day).toBeLessThan(DAYS_PER_MONTH);
      expect(dayIndex(time)).toBe(index);
    }
  });

  it('date un instant au jour en cours de son mois, de 1 à 30', () => {
    expect(dateOfTime({ tick: 0, day: 0 })).toEqual({ year: 1, month: 0, day: 1 });
    expect(dateOfTime({ tick: 14, day: 11 })).toEqual({ year: 2, month: 2, day: 12 });
    expect(dateOfTime({ tick: 23, day: 29 })).toEqual({ year: 2, month: 11, day: 30 });
  });
});

describe('durées (2b.2)', () => {
  it('fait durer une année 40 s en vitesse normale, 80 s, 10 s et 2,5 s aux autres', () => {
    expect(monthDuration('normal') * MONTHS_PER_YEAR).toBeCloseTo(40_000);
    expect(dayDuration('normal') * DAYS_PER_YEAR).toBeCloseTo(40_000);
    // D'un bloc, 360 jours font une année pile, sans erreur d'arrondi.
    expect(SPEEDS.map((speed) => daysDuration(DAYS_PER_YEAR, speed))).toEqual([
      80_000, 40_000, 10_000, 2_500,
    ]);
    for (const speed of SPEEDS) {
      expect(daysIn(daysDuration(17.25, speed), speed)).toBeCloseTo(17.25, 12);
      expect(daysDuration(1, speed)).toBeCloseTo(dayDuration(speed), 12);
      expect(daysDuration(DAYS_PER_MONTH, speed)).toBeCloseTo(monthDuration(speed), 9);
    }
  });

  it('va de la plus lente à la plus rapide', () => {
    const durations = SPEEDS.map(monthDuration);
    expect([...durations].sort((a, b) => b - a)).toEqual(durations);
  });

  it('regroupe un jour par lot à ×½, ×1 et ×4, trois à ×16, pour un lot d’au moins 16 ms', () => {
    expect(SPEEDS.map(batchDays)).toEqual([1, 1, 1, 3]);
    for (const speed of SPEEDS) {
      expect(daysDuration(batchDays(speed), speed)).toBeGreaterThanOrEqual(MIN_BATCH_MS);
      expect(batchDays(speed)).toBeLessThanOrEqual(MAX_BATCH_DAYS);
    }
  });
});
