import { describe, expect, it } from 'vitest';
import { DebugSampler } from './debug';

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

  it('moyenne les derniers jours, pas mensuels et lots, et garde les marches du dernier lot', () => {
    const sampler = new DebugSampler();
    expect(sampler.sample()).toMatchObject({
      dayMs: undefined,
      monthMs: undefined,
      worstMonthMs: undefined,
      batchDays: undefined,
      walks: undefined,
    });
    // Des lots de trois jours ordinaires, d'abord lents, puis rapides : seuls les trente
    // derniers jours comptent.
    for (let batch = 0; batch < 20; batch++) {
      sampler.batch({ batchMs: 1, days: 3, dayMs: batch < 10 ? 2 : 0.5, walks: 40 + batch });
    }
    expect(sampler.sample().dayMs).toBe(0.5);
    expect(sampler.sample().batchDays).toBe(3);
    expect(sampler.sample().walks).toBe(59);
    // Les pas mensuels : leur durée ne compte pas dans celle des jours ; les douze derniers.
    for (let month = 0; month < 14; month++) {
      sampler.batch({ batchMs: 60, days: 1, monthMs: month < 2 ? 900 : 50 + month, walks: 7 });
    }
    expect(sampler.sample().dayMs).toBe(0.5);
    expect(sampler.sample().monthMs).toBeCloseTo((52 + 63) / 2, 9);
    expect(sampler.sample().worstMonthMs).toBe(63);
    expect(sampler.sample().walks).toBe(7);
    // Un lot de deux jours et d'un pas mensuel : deux jours ordinaires.
    sampler.batch({ batchMs: 5, days: 3, dayMs: 1, monthMs: 40, walks: 3 });
    expect(sampler.sample().batchDays).toBeCloseTo((3 * 15 + 14 + 3) / 30, 9);
  });
});
