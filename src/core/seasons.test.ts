import { describe, expect, it } from 'vitest';
import {
  extremeMonths,
  MONTH_CENTERS,
  monthlyPrecipitation,
  monthlyTemperature,
  rainSeasonality,
  seasonFactor,
} from './seasons';

describe('saisons (C1, D8)', () => {
  it("culminent à la mi-juillet au nord, à la mi-janvier au sud, d'un mois à l'autre sans saut", () => {
    expect(seasonFactor(6.5)).toBeCloseTo(1, 12);
    expect(seasonFactor(0.5)).toBeCloseTo(-1, 12);
    expect(monthlyTemperature(10, 8, false, 6.5)).toBeCloseTo(18, 12);
    expect(monthlyTemperature(10, 8, true, 6.5)).toBeCloseTo(2, 12);
    expect(Math.abs(seasonFactor(3.999) - seasonFactor(4))).toBeLessThan(0.001);
  });

  it("bornent l'année par les mois extrêmes que l'on voit à l'écran (D13)", () => {
    const { warmest, coldest } = extremeMonths(10, 8);
    expect(warmest).toBe(18);
    expect(coldest).toBe(2);
    for (let month = 0; month < 12; month += 0.05) {
      const t = monthlyTemperature(10, 8, false, month);
      expect(t).toBeLessThanOrEqual(warmest + 1e-12);
      expect(t).toBeGreaterThanOrEqual(coldest - 1e-12);
    }
  });

  it('donnent aux tropiques une saison sèche en hiver et des pluies en été (SAI-02)', () => {
    expect(rainSeasonality(0)).toBeLessThan(0.1);
    expect(rainSeasonality(0.2)).toBeCloseTo(0.9, 6);
    expect(rainSeasonality(0.7)).toBeLessThan(0.01);
    // Au nord, vers 18° : juillet pleut près de vingt fois plus que janvier.
    const july = monthlyPrecipitation(1200, 0.2, false, 6.5);
    const january = monthlyPrecipitation(1200, 0.2, false, 0.5);
    expect(july / january).toBeGreaterThan(15);
    // Au sud, les saisons s'inversent.
    expect(monthlyPrecipitation(1200, 0.2, true, 0.5)).toBeCloseTo(july, 9);
    // Les douze mois redonnent la pluie annuelle.
    const total = MONTH_CENTERS.reduce(
      (sum, month) => sum + monthlyPrecipitation(1200, 0.2, false, month),
      0,
    );
    expect(total).toBeCloseTo(1200, 6);
  });
});
