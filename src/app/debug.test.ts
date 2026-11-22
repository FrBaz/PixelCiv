import { describe, expect, it } from 'vitest';
import { Rng } from '../core/rng';
import {
  NO_CARRIER,
  type FaunaFrame,
  type FaunaLegArrays,
  type GroupsFrame,
  type HumanLegArrays,
} from '../core/protocol';
import {
  ANIMAL_BYTES,
  DAY_WINDOW,
  DebugSampler,
  displayOverrides,
  DrawCallCounter,
  FAUNA_LEG_BYTES,
  faunaBytes,
  HUMAN_LEG_BYTES,
  LEG_BYTES,
  MEMBER_BYTES,
  positionBytes,
} from './debug';

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
      sampler.batch({
        batchMs: 1,
        days: 3,
        dayMs: 2,
        walkers: 40,
        legs: 0,
        animals: 0,
        faunaLegs: 0,
      });
    }
    expect(sampler.sample().dayMs).toBe(2);
    for (let batch = 0; batch < 100; batch++) {
      sampler.batch({
        batchMs: 1,
        days: 3,
        dayMs: 0.5,
        walkers: 40 + batch,
        legs: 0,
        animals: 0,
        faunaLegs: 0,
      });
    }
    // Les 300 jours rapides, et les 702 jours lents qui les précèdent.
    expect(sampler.sample().dayMs).toBeCloseTo((300 * 0.5 + 702 * 2) / 1002, 9);
    for (let batch = 100; batch < 334; batch++) {
      sampler.batch({
        batchMs: 1,
        days: 3,
        dayMs: 0.5,
        walkers: 40 + batch,
        legs: 0,
        animals: 0,
        faunaLegs: 0,
      });
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
        animals: 0,
        faunaLegs: 0,
      });
    }
    expect(sampler.sample().dayMs).toBe(0.5);
    expect(sampler.sample().monthMs).toBeCloseTo((52 + 63) / 2, 9);
    expect(sampler.sample().worstMonthMs).toBe(63);
    expect(sampler.sample().walkers).toBe(7);
    // Un lot de deux jours et d'un pas mensuel : deux jours ordinaires.
    sampler.batch({
      batchMs: 5,
      days: 3,
      dayMs: 1,
      monthMs: 40,
      walkers: 3,
      legs: 0,
      animals: 0,
      faunaLegs: 0,
    });
    expect(sampler.sample().dayMs).toBeCloseTo((333 * 3 * 0.5 + 2) / 1001, 9);
    expect(sampler.sample().batchDays).toBeCloseTo((3 * 15 + 14 + 3) / 30, 9);
  });

  it('moyenne le jour du gibier sur les mêmes jours, et garde ses animaux du dernier lot', () => {
    const sampler = new DebugSampler();
    expect(sampler.sample()).toMatchObject({ animals: undefined, faunaDayMs: undefined });
    sampler.batch({
      batchMs: 3,
      days: 3,
      dayMs: 1,
      walkers: 0,
      legs: 0,
      animals: 600,
      faunaLegs: 40,
      faunaMs: 0.3,
    });
    sampler.batch({
      batchMs: 3,
      days: 1,
      dayMs: 1,
      walkers: 0,
      legs: 0,
      animals: 612,
      faunaLegs: 9,
      faunaMs: 0.7,
    });
    // Le pas mensuel d'un lot n'en est pas : seuls ses jours ordinaires comptent.
    sampler.batch({
      batchMs: 60,
      days: 1,
      monthMs: 50,
      walkers: 0,
      legs: 0,
      animals: 605,
      faunaLegs: 0,
    });
    expect(sampler.sample().faunaDayMs).toBeCloseTo((3 * 0.3 + 0.7) / 4, 9);
    expect(sampler.sample().animals).toBe(605);
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
      sampler.batch({
        batchMs: total,
        days: 3,
        dayMs: total / 3,
        walkers: 0,
        legs: 0,
        animals: 0,
        faunaLegs: 0,
      });
      if (day + 3 < DAY_WINDOW) continue;
      // Passé mille jours, la moyenne reste à un quart près de la vraie durée.
      const shown = sampler.sample().dayMs ?? 0;
      expect(shown).toBeGreaterThanOrEqual(0.003);
      expect(shown).toBeLessThanOrEqual(0.005);
    }
  });

  it('compte les positions reçues sur la dernière seconde, et ce que coûtent les individus à chaque image', () => {
    const sampler = new DebugSampler();
    expect(sampler.sample(0)).toMatchObject({ legsPerSecond: 0, positionBytesPerSecond: 0 });
    expect(sampler.sample().legsPerSecond).toBeUndefined();
    // Une étape pèse 26 octets (ADR 0014) ; celle d'un humain 27, son octet d'activité compris,
    // et un membre de l'image 24 (protocole 9, ADR 0021).
    expect([LEG_BYTES, HUMAN_LEG_BYTES, MEMBER_BYTES]).toEqual([26, 27, 24]);
    const legs = (count: number): HumanLegArrays => ({
      slots: new Uint32Array(count),
      days: new Uint32Array(count),
      start: new Int32Array(2 * count),
      step: new Int32Array(2 * count),
      count: new Uint16Array(count),
      acts: new Uint8Array(count),
    });
    const frame: GroupsFrame = {
      groups: new Uint32Array(2 * 5),
      slots: new Uint32Array(30),
      ids: new Uint32Array(30),
      sprites: new Uint16Array(30),
      statures: new Uint8Array(30),
      positions: new Int32Array(60),
      carriers: new Uint32Array(30).fill(NO_CARRIER),
      activities: new Uint8Array(30),
      legs: legs(4),
    };
    expect(positionBytes(legs(10), undefined)).toBe(270);
    expect(positionBytes(undefined, frame)).toBe(4 * 27 + 30 * 24 + 2 * 5 * 4);
    // Le gibier (relecture 2b.6, problème 20) : une étape pèse 27 octets, allure comprise, un
    // animal de l'image 17, et ses étapes en cours 26.
    expect([FAUNA_LEG_BYTES, ANIMAL_BYTES]).toEqual([27, 17]);
    const faunaLegs: FaunaLegArrays = { ...legs(6), gaits: new Uint8Array(6) };
    const fauna: FaunaFrame = {
      slots: new Uint32Array(12),
      ids: new Uint32Array(12),
      kinds: new Uint8Array(12),
      positions: new Int32Array(24),
      legs: legs(3),
    };
    expect(faunaBytes(faunaLegs, undefined)).toBe(6 * 27);
    expect(faunaBytes(undefined, fauna)).toBe(12 * 17 + 3 * 26);
    expect(faunaBytes(undefined, undefined)).toBe(0);
    // Dix deltas par seconde, de 100 étapes : 1 000 étapes par seconde ; ceux d'il y a plus
    // d'une seconde ne comptent plus.
    for (let at = 0; at < 3000; at += 100) sampler.receive(at, 100, 2600);
    expect(sampler.sample(2950)).toMatchObject({
      legsPerSecond: 1000,
      positionBytesPerSecond: 26000,
    });
    expect(sampler.sample(4000).legsPerSecond).toBe(0);
    // Le coût moyen des images de la dernière seconde, et ce que dessine la dernière.
    for (let frameIndex = 0; frameIndex < 90; frameIndex++) {
      const slow = frameIndex < 20;
      sampler.frame(1000 / 60, {
        positionsMs: slow ? 9 : 1,
        sortMs: 0.5,
        spritesMs: 2,
        drawn: 1200 + frameIndex,
        textures: 300,
        cached: 400,
        pages: 2,
        drawCalls: 12,
        decorObjects: 3000 + frameIndex,
        decorMs: slow ? 4 : 0.5,
        faunaLayerMs: slow ? 1 : 0.25,
      });
    }
    const sample = sampler.sample();
    // Le décor (ADR 0017) : ses objets de la dernière image, la moyenne de sa mise à jour ; à
    // part, celle du gibier (relecture 2b.6, problème 20).
    expect(sample.decorObjects).toBe(3089);
    expect(sample.decorMs).toBeCloseTo(0.5, 9);
    expect(sample.faunaLayerMs).toBeCloseTo(0.25, 9);
    expect(sample.crowd.positions).toBeCloseTo(1, 9);
    expect(sample.crowd.sort).toBeCloseTo(0.5, 9);
    // Sans mesure de la mise à jour, du rendu ni de la chronologie, rien n'en est compté.
    expect(sample.main).toEqual({ update: 0, render: 0 });
    expect(sample.timeline).toEqual({ show: 0, receive: 0 });
    expect(sample).toMatchObject({
      drawn: 1289,
      textures: 300,
      cachedTextures: 400,
      pages: 2,
      drawCalls: 12,
    });
  });

  it('moyenne ce que coûte une image au fil principal : mise à jour, rendu et chronologie', () => {
    const sampler = new DebugSampler();
    const people = {
      positionsMs: 1,
      sortMs: 0.25,
      spritesMs: 2,
      drawn: 1300,
      textures: 300,
      cached: 400,
      pages: 1,
    };
    // Les images lentes de plus d'une seconde ne comptent plus.
    for (let frameIndex = 0; frameIndex < 90; frameIndex++) {
      const old = frameIndex < 20;
      sampler.frame(1000 / 60, {
        ...people,
        updateMs: old ? 50 : 6,
        renderMs: old ? 50 : 5,
        showMs: old ? 9 : 0.4,
        receiveMs: old ? 9 : 0.3,
      });
    }
    const sample = sampler.sample();
    expect(sample.main.update).toBeCloseTo(6, 9);
    expect(sample.main.render).toBeCloseTo(5, 9);
    expect(sample.timeline.show).toBeCloseTo(0.4, 9);
    expect(sample.timeline.receive).toBeCloseTo(0.3, 9);
  });

  it('compte les images dessinées, et ne mesure le rendu que sur elles (rendu à la demande)', () => {
    const sampler = new DebugSampler();
    const people = {
      positionsMs: 0,
      sortMs: 0,
      spritesMs: 0,
      drawn: 10,
      textures: 3,
      cached: 3,
      pages: 1,
    };
    // En pause, une image dessinée sur quinze : le pas de la mer animée, quatre fois par seconde.
    for (let frameIndex = 0; frameIndex < 120; frameIndex++) {
      const rendered = frameIndex % 15 === 0;
      sampler.frame(1000 / 60, {
        ...people,
        updateMs: 0.1,
        renderMs: rendered ? 4 : 0,
        drawCalls: rendered ? 9 : 0,
        rendered,
      });
    }
    const sample = sampler.sample();
    expect(sample.fps).toBeCloseTo(60, 0);
    expect(sample.drawnFps).toBeCloseTo(4, 0);
    expect(sample.main.render).toBeCloseTo(4, 9);
    // Les appels de dessin : ceux de la dernière image dessinée.
    expect(sample.drawCalls).toBe(9);
    // Sans réponse, une image compte comme dessinée.
    const plain = new DebugSampler();
    for (let i = 0; i < 60; i++) plain.frame(1000 / 60);
    expect(plain.sample().drawnFps).toBeCloseTo(60, 0);
  });

  it('compte les appels de dessin WebGL de chaque image', () => {
    const calls: string[] = [];
    const gl = {
      drawElements: (mode: number) => {
        calls.push(`elements ${String(mode)}`);
      },
      drawArrays: (mode: number) => {
        calls.push(`arrays ${String(mode)}`);
      },
    };
    const counter = new DrawCallCounter(gl);
    gl.drawElements(4);
    gl.drawElements(4);
    gl.drawArrays(5);
    expect(counter.take()).toBe(3);
    expect(counter.take()).toBe(0);
    // Les appels arrivent toujours au contexte.
    expect(calls).toEqual(['elements 4', 'elements 4', 'arrays 5']);
    expect(new DrawCallCounter(undefined).take()).toBe(0);
  });
});

describe("réglages de débogage de l'affichage (ADR 0015)", () => {
  const read = (search: string) => displayOverrides(new URLSearchParams(search));

  it("ne change rien sans eux : l'onde allumée, au pas et au mois du jeu", () => {
    expect(read('?seed=abc&zoom=2')).toEqual({
      waves: true,
      waveStep: undefined,
      month: undefined,
      effects: undefined,
    });
  });

  it("éteint l'onde, fixe son pas et le mois de la carte", () => {
    expect(read('?waves=off&waveStep=42&month=1.3')).toEqual({
      waves: false,
      waveStep: 42,
      month: 1.3,
      effects: undefined,
    });
    // Le cran du réglage des effets, pour les captures (ADR 0020) : un cran connu, ou rien.
    expect(read('?effects=reduced').effects).toBe('reduced');
    expect(read('?effects=off').effects).toBe('off');
    expect(read('?effects=moyen').effects).toBeUndefined();
    expect(read('?waveStep=0&month=0').waveStep).toBe(0);
    expect(read('?waveStep=0&month=0').month).toBe(0);
    expect(read('?waves=on').waves).toBe(true);
  });

  it('ignore un pas qui n’est pas un entier positif, et un mois hors de l’année', () => {
    for (const step of ['-1', '2.5', 'abc', '', '1e400']) {
      expect(read(`?waveStep=${step}`).waveStep).toBeUndefined();
    }
    for (const month of ['-0.5', '12.5', 'NaN', 'Infinity', 'mars']) {
      expect(read(`?month=${month}`).month).toBeUndefined();
    }
  });
});
