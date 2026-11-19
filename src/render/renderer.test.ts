import { Ticker, UPDATE_PRIORITY } from 'pixi.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { timeRendering } from './renderer';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mesure du rendu (débogage, ADR 0014)', () => {
  it('mesure le seul rendu de la scène, que PixiJS fait après les rappels de l’image', () => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const ticker = new Ticker();
    const order: string[] = [];
    // Le rendu de l'application, à la priorité LOW, puis un rappel de l'image, ajouté après.
    ticker.add(
      () => {
        order.push('rendu');
        clock += 5;
      },
      undefined,
      UPDATE_PRIORITY.LOW,
    );
    const measured: number[] = [];
    timeRendering(ticker, (milliseconds) => measured.push(milliseconds));
    ticker.add(() => {
      order.push('image');
      clock += 7;
    });
    ticker.update(16);
    ticker.update(32);
    expect(order).toEqual(['image', 'rendu', 'image', 'rendu']);
    expect(measured).toEqual([5, 5]);
    ticker.destroy();
  });
});
