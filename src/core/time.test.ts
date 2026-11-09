import { describe, expect, it } from 'vitest';
import { dateOfTick, monthDuration, MONTHS_PER_YEAR, SPEEDS } from './time';

describe('dateOfTick', () => {
  it("compte les mois à partir de janvier de l'an 1", () => {
    expect(dateOfTick(0)).toEqual({ year: 1, month: 0 });
    expect(dateOfTick(11)).toEqual({ year: 1, month: 11 });
    expect(dateOfTick(12)).toEqual({ year: 2, month: 0 });
    expect(dateOfTick(12 * 300 + 5)).toEqual({ year: 301, month: 5 });
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
