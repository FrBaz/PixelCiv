import { describe, expect, it } from 'vitest';
import { deltaFixedX } from '../core/position';
import { FAUNA_GAIT, FAUNA_RUN, type FaunaFrame, type FaunaLegArrays } from '../core/protocol';
import { dayIndex, DAYS_PER_MONTH } from '../core/time';
import { MAX_FRAMES } from './frames';
import { FaunaTimeline } from './faunaFrames';
import { advanceDay, step } from '../sim/day';
import { FaunaJournal, faunaFrame } from '../sim/fauna';
import type { SimState } from '../sim/state';
import { scatteredGroups, testData, testState } from '../sim/testing';

/** Une partie qui tourne comme dans le worker : ses lots d'un jour, leurs étapes, ses images. */
function playing(): { state: SimState; journal: FaunaJournal; first: FaunaFrame } {
  const state = testState('graine');
  step(state, scatteredGroups(state, 40), testData);
  const first = faunaFrame(state, testData);
  const journal = new FaunaJournal();
  state.fauna.journal = journal;
  return { state, journal, first };
}

/** Un jour du worker : ses étapes, et l'image du gibier au pas mensuel. */
function day(
  state: SimState,
  journal: FaunaJournal,
): { legs: FaunaLegArrays; frame: FaunaFrame | undefined } {
  const members = advanceDay(state, [], testData);
  return {
    legs: journal.take(),
    frame: members === undefined ? undefined : faunaFrame(state, testData),
  };
}

describe('chronologie du gibier (protocole 7, ADR 0018, § 4)', () => {
  it('redonne, aux jours entiers, les positions du worker, images du pas mensuel comprises', () => {
    const { state, journal, first } = playing();
    const dropped: FaunaLegArrays[] = [];
    const frames: FaunaFrame[] = [];
    const timeline = new FaunaTimeline(
      (legs) => dropped.push(legs),
      (frame) => frames.push(frame),
    );
    timeline.reset(first, state, state.size.width);
    const point = new Float64Array(2);
    let checked = 0;
    for (let days = 0; days < DAYS_PER_MONTH + 12; days++) {
      const { legs, frame } = day(state, journal);
      timeline.receive(state, legs, frame);
      const now = dayIndex(state);
      timeline.show(now);
      const shown = timeline.frame;
      if (shown === undefined) throw new Error('pas d’image');
      const fauna = state.fauna;
      shown.slots.forEach((slot, index) => {
        if (fauna.alive[slot] !== 1 || fauna.id[slot] !== shown.ids[index]) return;
        timeline.position(index, now, point);
        expect(Math.abs(deltaFixedX(point[0], fauna.x[slot] ?? 0, state.size.width))).toBe(0);
        expect(point[1]).toBe(fauna.y[slot]);
        // L'allure de l'état, jamais la vitesse apparente : au galop en fuite, au repos sinon.
        const moving = (fauna.stepDays[slot] ?? 0) > 0;
        if (moving) expect(timeline.gait(index, now)).toBe(fauna.gait[slot]);
        checked++;
      });
    }
    expect(checked).toBeGreaterThan(10_000);
    // L'image du pas mensuel a remplacé la première, rendue au worker avec les étapes lues.
    expect(timeline.at).toBe(DAYS_PER_MONTH + DAYS_PER_MONTH);
    expect(frames).toContain(first);
    expect(dropped.length).toBeGreaterThan(DAYS_PER_MONTH);
  });

  it('montre chaque étape à son allure, et l’arrêt de zéro jour au repos, sur le segment du jour', () => {
    const timeline = new FaunaTimeline(() => undefined);
    const frame: FaunaFrame = {
      slots: Uint32Array.of(0, 4),
      ids: Uint32Array.of(10, 14),
      kinds: Uint8Array.of(0, FAUNA_RUN),
      positions: Int32Array.of(65_536, 65_536, 131_072, 65_536),
      legs: {
        slots: Uint32Array.of(4),
        days: Uint32Array.of(30),
        start: Int32Array.of(131_072, 65_536),
        step: Int32Array.of(65_536, 0),
        count: Uint16Array.of(3),
      },
    };
    timeline.reset(frame, { tick: 1, day: 0 }, 512);
    const point = new Float64Array(2);
    // L'animal en fuite de l'image : au galop, puis au repos à la fin de son étape.
    expect(timeline.gait(1, 31.5)).toBe(FAUNA_GAIT.run);
    expect(timeline.gait(1, 33)).toBe(FAUNA_GAIT.rest);
    timeline.position(1, 31.5, point);
    expect(point[0]).toBe(131_072 + 1.5 * 65_536);
    // Une étape au pas, puis, le même jour, l'arrêt qui la remplace : il reste à son départ.
    const legs = (count: number, gait: number): FaunaLegArrays => ({
      slots: Uint32Array.of(0),
      days: Uint32Array.of(31),
      start: Int32Array.of(65_536, 65_536),
      step: Int32Array.of(count === 0 ? 0 : 32_768, 0),
      count: Uint16Array.of(count),
      gaits: Uint8Array.of(gait),
    });
    timeline.receive({ tick: 1, day: 2 }, legs(4, FAUNA_GAIT.walk), undefined);
    timeline.show(31.5);
    expect(timeline.gait(0, 31.5)).toBe(FAUNA_GAIT.walk);
    expect(timeline.facing(0)).toBe(1);
    timeline.receive({ tick: 1, day: 2 }, legs(0, FAUNA_GAIT.rest), undefined);
    timeline.show(31.6);
    expect(timeline.gait(0, 31.6)).toBe(FAUNA_GAIT.rest);
    timeline.position(0, 33, point);
    expect(point[0]).toBe(65_536);
    // Le sens de sa dernière étape lui reste.
    expect(timeline.facing(0)).toBe(1);
  });

  it('ne bouge rien en pause : le même instant donne la même image et la même version', () => {
    const { state, journal, first } = playing();
    const timeline = new FaunaTimeline(() => undefined);
    timeline.reset(first, state, state.size.width);
    for (let days = 0; days < 5; days++) {
      const { legs, frame } = day(state, journal);
      timeline.receive(state, legs, frame);
    }
    const t = dayIndex(state) - 0.4;
    timeline.show(t);
    const version = timeline.version;
    const point = new Float64Array(2);
    const before = Array.from(first.slots, (_, index) => {
      timeline.position(index, t, point);
      return [point[0], point[1]];
    });
    timeline.show(t);
    expect(timeline.version).toBe(version);
    const after = Array.from(first.slots, (_, index) => {
      timeline.position(index, t, point);
      return [point[0], point[1]];
    });
    expect(after).toEqual(before);
  });

  it('garde le sens de chacun d’une image à l’autre, et montre tomber ceux qui manquent à la suivante', () => {
    const timeline = new FaunaTimeline(() => undefined);
    const frame = (ids: number[], slots: number[]): FaunaFrame => ({
      slots: Uint32Array.from(slots),
      ids: Uint32Array.from(ids),
      kinds: new Uint8Array(ids.length),
      positions: Int32Array.from(ids.flatMap((id) => [id * 65_536, 3 * 65_536])),
      legs: {
        slots: new Uint32Array(0),
        days: new Uint32Array(0),
        start: new Int32Array(0),
        step: new Int32Array(0),
        count: new Uint16Array(0),
      },
    });
    timeline.reset(frame([5, 6, 7], [0, 1, 2]), { tick: 0, day: 0 }, 512);
    // Le premier part vers l'ouest.
    timeline.receive(
      { tick: 0, day: 1 },
      {
        slots: Uint32Array.of(0),
        days: Uint32Array.of(0),
        start: Int32Array.of(5 * 65_536, 3 * 65_536),
        step: Int32Array.of(-65_536, 0),
        count: Uint16Array.of(1),
        gaits: Uint8Array.of(FAUNA_GAIT.walk),
      },
      undefined,
    );
    timeline.show(0.5);
    expect(timeline.facing(0)).toBe(-1);
    // L'image suivante : le premier y est encore, le deuxième est mort, un nouveau occupe son
    // emplacement, le troisième est mort.
    timeline.receive({ tick: 1, day: 0 }, undefined, frame([5, 9], [0, 1]));
    timeline.show(30);
    expect(timeline.facing(0)).toBe(-1);
    expect(timeline.facing(1)).toBe(0);
    const fallen = timeline.fallen;
    expect(fallen.count).toBe(2);
    expect([...fallen.ids]).toEqual([6, 7]);
    expect(fallen.at).toBe(30);
    expect([...fallen.positions]).toEqual([6 * 65_536, 3 * 65_536, 7 * 65_536, 3 * 65_536]);
    // Une partie nouvelle n'en a pas.
    const generation = fallen.generation;
    timeline.reset(frame([1], [0]), { tick: 0, day: 0 }, 512);
    expect(timeline.fallen.count).toBe(0);
    expect(generation).toBeGreaterThan(0);
  });

  it(`garde au plus ${String(MAX_FRAMES)} images en attente, et rend les autres`, () => {
    const dropped: FaunaFrame[] = [];
    const timeline = new FaunaTimeline(
      () => undefined,
      (frame) => dropped.push(frame),
    );
    const empty = (): FaunaFrame => ({
      slots: new Uint32Array(0),
      ids: new Uint32Array(0),
      kinds: new Uint8Array(0),
      positions: new Int32Array(0),
      legs: {
        slots: new Uint32Array(0),
        days: new Uint32Array(0),
        start: new Int32Array(0),
        step: new Int32Array(0),
        count: new Uint16Array(0),
      },
    });
    timeline.reset(empty(), { tick: 0, day: 0 }, 512);
    const sent = Array.from({ length: MAX_FRAMES + 5 }, (_, month) => {
      const frame = empty();
      timeline.receive({ tick: month + 1, day: 0 }, undefined, frame);
      return frame;
    });
    expect(timeline.queued).toBe(MAX_FRAMES);
    expect(dropped).toEqual(sent.slice(0, 5));
    // À l'instant de la dernière, toutes les autres sont rendues, la première comprise.
    timeline.show((MAX_FRAMES + 5) * DAYS_PER_MONTH);
    expect(timeline.frame).toBe(sent.at(-1));
    expect(dropped).toHaveLength(MAX_FRAMES + 5);
  });
});
