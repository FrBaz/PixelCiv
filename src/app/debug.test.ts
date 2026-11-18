import { describe, expect, it } from 'vitest';
import { Rng } from '../core/rng';
import { DAY_WINDOW, DebugSampler } from './debug';

describe('DebugSampler', () => {
  it('compte les images de la dernière seconde', () => {
    const sampler = new DebugSampler();
    for (let i = 0; i < 120; i++) sampler.frame(1000 / 60);
    const sample = sampler.sample();
    expect(sample.fps).toBeCloseTo(60, 0);
    expect(sample.worstFrameMs).toBeCloseTo(16.7, 1);
  });

  it("repère l'image la plus longue, puis l'oublie au bout d'une seconde", () => {
    const sampler = new DebugSampler();
    sampler.frame(80);
    for (let i = 0; i < 30; i++) sampler.frame(16);
    expect(sampler.sample().worstFrameMs).toBe(80);
    for (let i = 0; i < 70; i++) sampler.frame(16);
    expect(sampler.sample().worstFrameMs).toBe(16);
  });

  it('moyenne les derniers jours, pas mensuels et lots, et garde les marcheurs du dernier lot', () => {
    const sampler = new DebugSampler();
    expect(sampler.sample()).toMatchObject({
      dayMs: undefined,
      monthMs: undefined,
      worstMonthMs: undefined,
      batchDays: undefined,
      walkers: undefined,
    });
    // Des lots de trois jours ordinaires, d'abord lents, puis rapides : seuls comptent les
    // derniers lots, sur mille jours au moins.
    expect(DAY_WINDOW).toBe(1000);
    for (let batch = 0; batch < 500; batch++) {
      sampler.batch({ batchMs: 1, days: 3, dayMs: 2, walkers: 40, legs: 0 });
    }
    expect(sampler.sample().dayMs).toBe(2);
    for (let batch = 0; batch < 100; batch++) {
      sampler.batch({ batchMs: 1, days: 3, dayMs: 0.5, walkers: 40 + batch, legs: 0 });
    }
    // Les 300 jours rapides, et les 702 jours lents qui les précèdent.
    expect(sampler.sample().dayMs).toBeCloseTo((300 * 0.5 + 702 * 2) / 1002, 9);
    for (let batch = 100; batch < 334; batch++) {
      sampler.batch({ batchMs: 1, days: 3, dayMs: 0.5, walkers: 40 + batch, legs: 0 });
    }
    expect(sampler.sample().dayMs).toBe(0.5);
    expect(sampler.sample().batchDays).toBe(3);
    expect(sampler.sample().walkers).toBe(373);
    // Les pas mensuels : leur durée ne compte pas dans celle des jours ; les douze derniers.
    for (let month = 0; month < 14; month++) {
      sampler.batch({
        batchMs: 60,
        days: 1,
        monthMs: month < 2 ? 900 : 50 + month,
        walkers: 7,
        legs: 0,
      });
    }
    expect(sampler.sample().dayMs).toBe(0.5);
    expect(sampler.sample().monthMs).toBeCloseTo((52 + 63) / 2, 9);
    expect(sampler.sample().worstMonthMs).toBe(63);
    expect(sampler.sample().walkers).toBe(7);
    // Un lot de deux jours et d'un pas mensuel : deux jours ordinaires.
    sampler.batch({ batchMs: 5, days: 3, dayMs: 1, monthMs: 40, walkers: 3, legs: 0 });
    expect(sampler.sample().dayMs).toBeCloseTo((333 * 3 * 0.5 + 2) / 1001, 9);
    expect(sampler.sample().batchDays).toBeCloseTo((3 * 15 + 14 + 3) / 30, 9);
  });

  it('approche un jour de 4 µs, que l’horloge du worker ne mesure qu’à 0,1 ms près', () => {
    // Hors isolement cross-origin, un jour de 4 µs se mesure 0 ou 0,1 ms : ici, dans chaque
    // série de vingt-cinq jours, un seul, tiré au sort, mesure 0,1 ms. Les jours vont par
    // lots de trois, comme à ×16.
    const sampler = new DebugSampler();
    const random = new Rng('panneau').stream('jours');
    let measured = 0;
    for (let day = 0; day < 4 * DAY_WINDOW; day += 3) {
      let total = 0;
      for (let rank = day; rank < day + 3; rank++) {
        if (rank % 25 === 0) measured = rank + random.nextInt(25);
        if (rank === measured) total += 0.1;
      }
      sampler.batch({ batchMs: total, days: 3, dayMs: total / 3, walkers: 0, legs: 0 });
      if (day + 3 < DAY_WINDOW) continue;
      // Passé mille jours, la moyenne reste à un quart près de la vraie durée.
      const shown = sampler.sample().dayMs ?? 0;
      expect(shown).toBeGreaterThanOrEqual(0.003);
      expect(shown).toBeLessThanOrEqual(0.005);
    }
  });
});
