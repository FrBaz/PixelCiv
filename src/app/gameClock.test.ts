import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type TimeInfo } from '../core/protocol';
import {
  batchDays,
  dayDuration,
  dayIndex,
  DAYS_PER_MONTH,
  daysDuration,
  type SpeedId,
} from '../core/time';
import { testData, testParams } from '../sim/testing';
import { SimulationHost } from '../worker/host';
import { FakeEnvironment, testGenerator } from '../worker/testing';
import { GameClock, JUMP_MS, PAUSE_CATCH_UP_MS } from './gameClock';
import { FRAME_MS, HostedGame } from './testing';

/** Le temps d'un état : `days` jours écoulés depuis le début de la partie. */
function at(days: number, speed: SpeedId = 'normal', paused = false): TimeInfo {
  return {
    tick: Math.floor(days / DAYS_PER_MONTH),
    day: days % DAYS_PER_MONTH,
    paused,
    speed,
  };
}

/**
 * Une partie imitée : un état tous les `batch` jours à la vitesse `speed`, à l'heure, un
 * pas mensuel de `monthMs` retardant celui qui le porte, et une image toutes les 16,7 ms.
 * Renvoie, image par image, l'instant affiché et celui du dernier état reçu.
 */
function simulate(
  speed: SpeedId,
  seconds: number,
  { monthMs = 0, start = 0 }: { monthMs?: number; start?: number } = {},
): { now: number; shown: number; latest: number }[] {
  const clock = new GameClock();
  clock.reset(at(start, speed), 0);
  const batch = batchDays(speed);
  // Les lots de l'hôte : `batch` jours, à l'échéance du dernier, en s'arrêtant au pas
  // mensuel, que son coût retarde, et jamais avant le lot précédent.
  const arrivals: { at: number; days: number; month: boolean }[] = [];
  let days = start;
  let ready = 0;
  while (ready < seconds * 1000) {
    const monthEnd = (Math.floor(days / DAYS_PER_MONTH) + 1) * DAYS_PER_MONTH;
    const next = Math.min(days + batch, monthEnd);
    const month = next === monthEnd;
    ready = Math.max(ready, daysDuration(next - start, speed) + (month ? monthMs : 0));
    arrivals.push({ at: ready, days: next, month });
    days = next;
  }
  const frames: { now: number; shown: number; latest: number }[] = [];
  let next = 0;
  let latest = start;
  for (let now = 0; now < seconds * 1000; now += FRAME_MS) {
    for (let arrival = arrivals.at(next); arrival !== undefined && arrival.at <= now;) {
      clock.receive(at(arrival.days, speed), arrival.at);
      if (arrival.month) clock.monthStep(monthMs);
      latest = arrival.days;
      next++;
      arrival = arrivals.at(next);
    }
    frames.push({ now, shown: clock.advance(now), latest });
  }
  return frames;
}

describe('horloge du rendu (ADR 0013)', () => {
  it('ne dépasse jamais le dernier état reçu, ni ne recule', () => {
    for (const speed of ['slow', 'normal', 'fast', 'faster'] as const) {
      for (const monthMs of [0, 30, 150]) {
        let previous = 0;
        for (const frame of simulate(speed, 6, { monthMs })) {
          expect(frame.shown).toBeLessThanOrEqual(frame.latest);
          expect(frame.shown).toBeGreaterThanOrEqual(previous);
          previous = frame.shown;
        }
      }
    }
  });

  it('garde à peu près le retard visé, juste avant chaque état', () => {
    for (const speed of ['slow', 'normal', 'fast', 'faster'] as const) {
      const frames = simulate(speed, 12);
      // En régime établi : le retard en jours reste entre ½ et 2 lots et demi.
      const lags = frames.slice(frames.length / 2).map((frame) => frame.latest - frame.shown);
      const batch = batchDays(speed);
      expect(Math.min(...lags), speed).toBeGreaterThan(0);
      expect(Math.max(...lags), speed).toBeLessThan(2.5 * batch + 1e-9);
      const mean = lags.reduce((sum, lag) => sum + lag, 0) / lags.length;
      expect(mean, speed).toBeGreaterThan(0.5 * batch);
      expect(mean, speed).toBeLessThan(1.6 * batch);
    }
    // Un pas mensuel long : le retard visé le couvre, et l'horloge ne s'arrête pas.
    const slow = simulate('faster', 12, { monthMs: 120 });
    const tail = slow.slice(slow.length / 2);
    let stalls = 0;
    for (let index = 1; index < tail.length; index++) {
      if ((tail[index]?.shown ?? 0) === (tail[index - 1]?.shown ?? 0)) stalls++;
    }
    expect(stalls).toBe(0);
  });

  it('avance entre la moitié et le double de la vitesse de la partie', () => {
    for (const speed of ['slow', 'normal', 'fast', 'faster'] as const) {
      const nominal = FRAME_MS / dayDuration(speed);
      const frames = simulate(speed, 8, { monthMs: 40 });
      for (let index = 1; index < frames.length; index++) {
        const step = (frames[index]?.shown ?? 0) - (frames[index - 1]?.shown ?? 0);
        expect(step / nominal, speed).toBeLessThanOrEqual(2 + 1e-9);
      }
    }
    // Sans retard, elle ralentit, jamais en deçà de la moitié, tant qu'un état la précède.
    const clock = new GameClock();
    clock.reset(at(0), 0);
    clock.receive(at(1), 0);
    clock.receive(at(2), 1);
    const before = clock.advance(1);
    const after = clock.advance(1 + FRAME_MS);
    expect((after - before) / (FRAME_MS / dayDuration('normal'))).toBeGreaterThanOrEqual(0.5);
  });

  it('se fige en pause sur le dernier état, en 0,3 s au plus, et repart de là sans saut', () => {
    const clock = new GameClock();
    clock.reset(at(0), 0);
    let now = 0;
    let shown = 0;
    let latest = 0;
    const frame = () => {
      now += FRAME_MS;
      const next = clock.advance(now);
      // Jamais un saut : au plus deux fois la vitesse de la partie, ou le rattrapage de pause.
      expect(next - shown).toBeLessThanOrEqual(
        Math.max(2 * (FRAME_MS / dayDuration('normal')), (FRAME_MS * 3) / PAUSE_CATCH_UP_MS) + 1e-9,
      );
      expect(next).toBeGreaterThanOrEqual(shown);
      shown = next;
    };
    // En marche, un jour par lot.
    for (let index = 0; index < 120; index++) {
      if (index % 7 === 0) clock.receive(at(++latest), now);
      frame();
    }
    // Pause : l'horloge rejoint le dernier état, puis s'arrête.
    clock.receive(at(latest, 'normal', true), now);
    const paused = now;
    while (now - paused < PAUSE_CATCH_UP_MS) frame();
    expect(shown).toBe(latest);
    for (let index = 0; index < 30; index++) frame();
    expect(shown).toBe(latest);
    // Un jour demandé en pause : elle y va, à la vitesse de la partie.
    clock.receive(at(++latest, 'normal', true), now);
    frame();
    expect(shown).toBeLessThan(latest);
    for (let index = 0; index < 20; index++) frame();
    expect(shown).toBe(latest);
    // Reprise, puis changement de vitesse : elle repart de là, sans saut.
    clock.receive(at(latest, 'normal'), now);
    for (let index = 0; index < 60; index++) {
      if (index % 7 === 3) clock.receive(at(++latest), now);
      frame();
    }
    clock.receive(at(latest, 'slow'), now);
    for (let index = 0; index < 60; index++) {
      if (index % 13 === 5) clock.receive(at(++latest, 'slow'), now);
      frame();
    }
    expect(shown).toBeGreaterThan(latest - 3);
  });

  it('ne saute pas quand la vitesse change en pause, pendant le rattrapage', () => {
    // Dix jours de retard à ×16, 69 ms ; la pause, puis ×½, où ils dureraient 2,2 s : le
    // rattrapage de la pause les finit en 0,3 s, sans saut.
    const clock = new GameClock();
    clock.reset(at(0, 'faster'), 0);
    clock.receive(at(10, 'faster'), 0);
    clock.receive(at(10, 'faster', true), 0);
    clock.receive(at(10, 'slow', true), 0);
    expect(10 * dayDuration('slow')).toBeGreaterThan(JUMP_MS);
    let shown = clock.instant;
    for (let now = FRAME_MS; now <= PAUSE_CATCH_UP_MS + FRAME_MS; now += FRAME_MS) {
      const next = clock.advance(now);
      expect(next - shown).toBeLessThanOrEqual((10 * FRAME_MS) / PAUSE_CATCH_UP_MS + 1e-9);
      shown = next;
    }
    expect(shown).toBe(10);
  });

  it('saute au dernier état au-delà d’une seconde de retard, comme à l’instantané', () => {
    const clock = new GameClock();
    clock.reset(at(40), 0);
    expect(clock.instant).toBe(40);
    // Le fil principal arrêté, un onglet gelé par exemple : les états arrivent d'un coup.
    for (let day = 41; day <= 60; day++) clock.receive(at(day), 0);
    expect(dayDuration('normal') * 20).toBeGreaterThan(JUMP_MS);
    expect(clock.advance(FRAME_MS)).toBe(60);
    // En deçà, elle rattrape sans sauter.
    clock.receive(at(62), FRAME_MS);
    expect(clock.advance(2 * FRAME_MS)).toBeLessThan(62);
  });

  it('donne le mois des saisons et le jour de la date à l’instant affiché', () => {
    const clock = new GameClock();
    clock.reset({ tick: 13, day: 15, paused: true, speed: 'normal' }, 0);
    expect(clock.month()).toBeCloseTo(1.5, 12);
    expect(clock.today()).toEqual({ tick: 13, day: 15 });
    clock.reset({ tick: 23, day: 29, paused: true, speed: 'normal' }, 0);
    expect(clock.month()).toBeCloseTo(11 + 29 / 30, 12);
    clock.receive({ tick: 24, day: 0, paused: true, speed: 'normal' }, 0);
    // Le jour suivant n'est pas encore affiché : la date et les saisons attendent l'horloge.
    expect(clock.today()).toEqual({ tick: 23, day: 29 });
    clock.advance(PAUSE_CATCH_UP_MS);
    expect(clock.today()).toEqual({ tick: 24, day: 0 });
    expect(clock.month()).toBe(0);
  });

  it('garde, avec le vrai hôte, une vitesse affichée à 10 % près de celle de la partie', async () => {
    for (const speed of ['slow', 'normal', 'fast'] as const) {
      const env = new FakeEnvironment();
      const host = new SimulationHost(env, testData, testGenerator);
      host.receive({ type: 'hello', protocol: PROTOCOL_VERSION });
      host.receive({ type: 'newGame', params: testParams() });
      await host.idle();
      host.receive({ type: 'setSpeed', speed });
      const clock = new GameClock();
      let delivered = 0;
      const deliver = () => {
        for (const entry of env.sent.slice(delivered)) {
          delivered++;
          const { message } = entry;
          if (message.type === 'snapshot') clock.reset(message.time, entry.at);
          if (message.type === 'delta' || message.type === 'time') {
            clock.receive(message.time, entry.at);
          }
          if (message.type === 'stats' && message.stats.monthMs !== undefined) {
            clock.monthStep(message.stats.monthMs);
          }
        }
      };
      const speeds: number[] = [];
      let previous = 0;
      const nominal = FRAME_MS / dayDuration(speed);
      for (let frame = 0; frame < 60 * 12; frame++) {
        env.advance(FRAME_MS);
        deliver();
        const shown = clock.advance(env.time);
        if (frame >= 60 * 4) speeds.push((shown - previous) / nominal);
        previous = shown;
      }
      expect(Math.min(...speeds), speed).toBeGreaterThan(0.9);
      expect(Math.max(...speeds), speed).toBeLessThan(1.1);
      expect(dayIndex(clock.today()), speed).toBeGreaterThan(0);
    }
  });

  it('ne saute pas de ×16 à ×½ ni à ×1, avec le vrai hôte, pas mensuel lent compris', async () => {
    // À ×16, le retard visé couvre le pas mensuel : 7,5 jours pour 52 ms, le seuil du banc
    // d'essai à 10 000 individus. Ce retard, compté en jours, durerait 1,7 s à ×½ : l'horloge
    // le résorbe en 0,3 s environ, sans saut. Trente changements par cas, à des instants
    // différents du mois de jeu.
    let checked = 0;
    for (const cost of [0, 20, 52]) {
      for (const speed of ['slow', 'normal'] as const) {
        const game = new HostedGame();
        await game.start();
        game.env.advancePerRead = 0.01;
        game.host.receive({ type: 'debugStepCost', milliseconds: cost });
        const nominal = FRAME_MS / dayDuration(speed);
        // Instant affiché et retard de l'horloge, quand l'image reçoit chaque changement.
        const switches: { shown: number; lag: number }[] = [];
        game.onMessage = (message) => {
          if (message.type === 'time' && message.time.speed === speed) {
            const { instant, received } = game.clock;
            switches.push({ shown: instant, lag: received - instant });
          }
        };
        for (let phase = 0; phase < 30; phase++) {
          game.host.receive({ type: 'setSpeed', speed: 'faster' });
          for (const until = game.now + 1000 + phase * 7; game.now < until;) game.frame();
          game.host.receive({ type: 'setSpeed', speed });
          let previous: number | undefined;
          for (const until = game.now + 700; game.now < until;) {
            const shown = game.frame();
            const switched = switches.at(phase);
            if (switched === undefined) continue;
            // Au plus un jour par image, et pas plus vite que le rattrapage d'une pause du
            // même retard, plus le jour du premier lot, qui peut arriver aussitôt.
            const step = shown - (previous ?? switched.shown);
            const bound = Math.max(
              2 * nominal,
              ((switched.lag + 1) * FRAME_MS) / PAUSE_CATCH_UP_MS,
            );
            const label = `${speed}, ${cost} ms, phase ${phase}`;
            expect(step, label).toBeLessThanOrEqual(Math.min(1, bound) + 1e-9);
            previous = shown;
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(6 * 30 * 30);
  });
});
