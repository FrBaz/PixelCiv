import { Ticker, UPDATE_PRIORITY, type Application } from 'pixi.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderOnDemand, timeRendering } from './renderer';

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

describe('rendu à la demande (ADR 0010, tâche 2b.4)', () => {
  /** Une application factice : son ticker rend la scène à chaque tic, comme le TickerPlugin. */
  function application() {
    const ticker = new Ticker();
    const rendered: number[] = [];
    let tick = 0;
    const app = {
      ticker,
      render: () => {
        rendered.push(tick);
      },
    };
    ticker.add(app.render, app, UPDATE_PRIORITY.LOW);
    const update = () => {
      tick++;
      ticker.update(tick * 16);
    };
    return { app: app as unknown as Application, ticker, rendered, update };
  }

  it('ne rend la scène que si on le demande, à la place du rendu de chaque image', () => {
    const { app, ticker, rendered, update } = application();
    let wanted = false;
    const frames = renderOnDemand(app, () => wanted);
    update();
    update();
    expect(rendered).toEqual([]);
    expect(frames.drawn).toBe(false);
    wanted = true;
    update();
    expect(rendered).toEqual([3]);
    expect(frames).toEqual({ drawn: true, count: 1 });
    wanted = false;
    update();
    expect(frames).toEqual({ drawn: false, count: 1 });
    ticker.destroy();
  });

  it('ne mesure que les images dessinées', () => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const { app, ticker, update } = application();
    let wanted = true;
    const frames = renderOnDemand(app, () => wanted);
    const measured: number[] = [];
    timeRendering(
      ticker,
      (milliseconds) => measured.push(milliseconds),
      () => frames.drawn,
    );
    ticker.add(
      () => {
        clock += 3;
      },
      undefined,
      UPDATE_PRIORITY.LOW,
    );
    update();
    wanted = false;
    update();
    update();
    expect(measured).toHaveLength(1);
    ticker.destroy();
  });
});
