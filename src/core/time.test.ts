import { describe, expect, it } from 'vitest';
import {
  dateOfTick,
  dateOfTime,
  dayIndex,
  DAYS_PER_MONTH,
  DAYS_PER_YEAR,
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

describe('monthDuration', () => {
  it('fait durer une année 10 s en vitesse normale', () => {
    expect(monthDuration('normal') * MONTHS_PER_YEAR).toBeCloseTo(10_000);
  });

  it('va de la plus lente à la plus rapide', () => {
    const durations = SPEEDS.map(monthDuration);
    expect([...durations].sort((a, b) => b - a)).toEqual(durations);
  });
});
