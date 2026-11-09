import { describe, expect, it } from 'vitest';
import { NORMAL_MONTH_MS } from '../core/time';
import { SeasonClock } from './seasonClock';

describe('horloge des saisons', () => {
  it('avance le mois en continu entre deux pas, au rythme de la vitesse', () => {
    const clock = new SeasonClock();
    clock.update({ tick: 13, paused: false, speed: 'normal' }, 1000);
    expect(clock.month(1000)).toBeCloseTo(1, 10);
    expect(clock.month(1000 + NORMAL_MONTH_MS / 2)).toBeCloseTo(1.5, 10);
    // Sans pas, il s'arrête juste avant le mois suivant.
    expect(clock.month(1000 + NORMAL_MONTH_MS * 3)).toBeCloseTo(1.999, 10);
    clock.update({ tick: 14, paused: false, speed: 'fast' }, 2000);
    expect(clock.month(2000 + NORMAL_MONTH_MS / 8)).toBeCloseTo(2.5, 10);
  });

  it('se fige en pause, là où le mois en était, et repart de là', () => {
    const clock = new SeasonClock();
    clock.update({ tick: 0, paused: false, speed: 'normal' }, 0);
    clock.update({ tick: 0, paused: true, speed: 'normal' }, NORMAL_MONTH_MS / 4);
    expect(clock.month(NORMAL_MONTH_MS * 10)).toBeCloseTo(0.25, 10);
    clock.update({ tick: 0, paused: false, speed: 'normal' }, NORMAL_MONTH_MS * 10);
    expect(clock.month(NORMAL_MONTH_MS * 10 + NORMAL_MONTH_MS / 4)).toBeCloseTo(0.5, 10);
  });

  it('boucle sur douze mois', () => {
    const clock = new SeasonClock();
    clock.update({ tick: 23, paused: true, speed: 'normal' }, 0);
    expect(clock.month(0)).toBe(11);
    clock.update({ tick: 24, paused: true, speed: 'normal' }, 1);
    expect(clock.month(1)).toBe(0);
  });
});
