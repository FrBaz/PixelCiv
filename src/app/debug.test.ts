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

  it('moyenne les derniers pas', () => {
    const sampler = new DebugSampler();
    expect(sampler.sample().stepMs).toBeUndefined();
    for (let i = 0; i < 40; i++) sampler.step(i < 10 ? 500 : 200);
    expect(sampler.sample().stepMs).toBe(200);
    expect(sampler.sample().worstStepMs).toBe(200);
  });
});
