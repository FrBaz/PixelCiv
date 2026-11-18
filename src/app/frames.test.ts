import { describe, expect, it } from 'vitest';
import {
  GROUP_STRIDE,
  NO_CARRIER,
  type GroupsFrame,
  type MainMessage,
  type SpawnGroupCommand,
} from '../core/protocol';
import { FIXED } from '../core/position';
import { dayDuration, dayIndex, DAYS_PER_MONTH, type GameTime, type SpeedId } from '../core/time';
import { groupPositions } from '../render/crowd';
import { scatteredGroups, testState } from '../sim/testing';
import { FrameQueue, MAX_FRAMES, type DatedFrame } from './frames';
import { PAUSE_CATCH_UP_MS } from './gameClock';
import { FRAME_MS, HostedGame } from './testing';

/** Une image de groupes d'un membre chacun, d'identifiants `ids`, sur la ligne 10. */
function frame(...ids: number[]): GroupsFrame {
  const count = ids.length;
  return {
    groups: Uint32Array.from(ids.flatMap((id) => [id, id, 10, 1, 1])),
    slots: Uint32Array.from(ids, (_, index) => index),
    ids: Uint32Array.from(ids),
    sprites: new Uint16Array(count),
    statures: new Uint8Array(count).fill(96),
    positions: Int32Array.from(
      ids.flatMap((id) => [id * FIXED + FIXED / 2, 10 * FIXED + FIXED / 2]),
    ),
    carriers: new Uint32Array(count).fill(NO_CARRIER),
    legs: {
      slots: new Uint32Array(0),
      days: new Uint32Array(0),
      start: new Int32Array(0),
      step: new Int32Array(0),
      count: new Uint16Array(0),
    },
  };
}

const time = (tick: number, day: number): GameTime => ({ tick, day });

/** Identifiants des groupes d'une image. */
const groupIds = (frame: GroupsFrame) =>
  Array.from(frame.groups.filter((_, index) => index % GROUP_STRIDE === 0));

/** Identifiants des groupes d'une image datée. */
const ids = (dated: DatedFrame | undefined) => (dated === undefined ? [] : groupIds(dated.frame));

/**
 * Position de chaque groupe d'une image datée, par identifiant : le barycentre de ses
 * membres, à leur position de l'image (2b.3, étape a : le rendu n'interpole pas encore les
 * étapes).
 */
function positionsAt(dated: DatedFrame, width: number): Map<number, [number, number]> {
  const count = dated.frame.groups.length / GROUP_STRIDE;
  const positions = new Float64Array(count * 2);
  groupPositions(dated.frame, width, positions, new Uint8Array(count));
  const map = new Map<number, [number, number]>();
  for (let rank = 0; rank < count; rank++) {
    map.set(dated.frame.groups[rank * GROUP_STRIDE] ?? 0, [
      positions[rank * 2] ?? 0,
      positions[rank * 2 + 1] ?? 0,
    ]);
  }
  return map;
}

describe('images des groupes datées (ADR 0013, ADR 0014)', () => {
  it('montre l’image de l’instant affiché : apparitions et disparitions à leur instant', () => {
    const queue = new FrameQueue();
    queue.reset(frame(1, 2), time(0, 0));
    // Le pas mensuel : le groupe 2 a rejoint un voisin, le groupe 3 est né d'une scission.
    queue.push(frame(1, 3), time(1, 0));
    expect(ids(queue.at(0))).toEqual([1, 2]);
    expect(ids(queue.at(29.99))).toEqual([1, 2]);
    expect(ids(queue.at(30))).toEqual([1, 3]);
    // Une image dépassée s'oublie ; l'horloge ne revient pas en arrière.
    expect(queue.size).toBe(1);
    // Une commande en pause : l'image d'un même instant remplace la précédente.
    queue.push(frame(1, 3, 4), time(1, 12));
    queue.push(frame(1, 3, 4, 5), time(1, 12));
    expect(queue.size).toBe(2);
    expect(ids(queue.at(41.5))).toEqual([1, 3]);
    expect(ids(queue.at(42))).toEqual([1, 3, 4, 5]);
    expect(ids(queue.latest())).toEqual([1, 3, 4, 5]);
  });

  it('borne la file, comme dans un onglet en arrière-plan où la carte ne se dessine plus', () => {
    const queue = new FrameQueue();
    queue.reset(frame(1), time(0, 0));
    for (let month = 1; month <= 40; month++) queue.push(frame(month), time(month, 0));
    expect(queue.size).toBe(MAX_FRAMES);
    expect(ids(queue.latest())).toEqual([40]);
    // Au retour, l'horloge a suivi les états reçus : la dernière image.
    expect(ids(queue.at(40 * DAYS_PER_MONTH))).toEqual([40]);
    expect(queue.size).toBe(1);
  });

  it('rend au worker les tampons des images qu’elle oublie', () => {
    const dropped: GroupsFrame[] = [];
    const queue = new FrameQueue((old) => dropped.push(old));
    const first = frame(1);
    queue.reset(first, time(0, 0));
    const second = frame(2);
    queue.push(second, time(1, 0));
    expect(dropped).toEqual([]);
    queue.at(DAYS_PER_MONTH);
    expect(dropped).toEqual([first]);
    // Une image d'un même instant remplace la précédente, qui part aussi.
    const third = frame(3);
    queue.push(third, time(1, 0));
    expect(dropped).toEqual([first, second]);
    queue.clear();
    expect(dropped).toEqual([first, second, third]);
  });

  it('suit l’horloge avec le vrai hôte : vitesses, pause, pas unique, chargement, couture, scissions', async () => {
    const game = new HostedGame();
    await game.start();
    const { env, host, clock, frames } = game;
    // Des groupes nombreux, qui se scindent ; d'autres au bord de la couture.
    const width = 512;
    const state = testState();
    // Les cases franchissables des deux colonnes de part et d'autre de la couture, une sur
    // vingt, où des groupes apparaissent aussi.
    const seam: SpawnGroupCommand[] = [];
    for (let y = 0; y < state.size.height; y++) {
      for (const x of [width - 1, 0]) {
        if (!Number.isFinite(state.cost[y * width + x] ?? Number.NaN) || (y * 7 + x) % 20 !== 0) {
          continue;
        }
        seam.push({ type: 'spawnGroup', x, y, species: 'human', subspecies: 'plains', count: 30 });
      }
    }
    expect(seam.length).toBeGreaterThan(3);
    const commands = [...scatteredGroups(state, 40, 34), ...seam];
    for (const command of commands) host.receive({ type: 'game', command });
    // Ce que suit chaque image : la vitesse et la pause des derniers temps reçus, le retard
    // de l'horloge au dernier changement, la marche la plus rapide reçue, et le groupe
    // d'origine de chaque groupe né d'une scission.
    let speed: SpeedId = 'normal';
    let paused = false;
    let change = { at: 0, lag: 0 };
    const parentOf = new Map<number, number>();
    let latestIds = new Set<number>();
    game.onMessage = (message) => {
      if (message.type !== 'delta' && message.type !== 'time') return;
      if (message.time.speed !== speed || message.time.paused !== paused) {
        change = { at: game.now, lag: clock.received - clock.instant };
      }
      speed = message.time.speed;
      paused = message.time.paused;
      if (message.type !== 'delta' || message.frame === undefined) return;
      const { frame } = message;
      // Les groupes nés d'une scission au pas mensuel, par identifiants croissants, et les
      // faits de la chronique qui donnent leur groupe d'origine, dans le même ordre.
      const present = groupIds(frame);
      const born = present.filter((id) => !latestIds.has(id)).sort((a, b) => a - b);
      const splits = message.chronicle.filter((fact) => fact.kind === 'groupSplit');
      if (splits.length > 0) {
        expect(born).toHaveLength(splits.length);
        splits.forEach((fact, rank) => parentOf.set(born[rank] ?? 0, fact.groupId));
      }
      latestIds = new Set(present);
    };
    // Le scénario : à chaque instant (ms), des messages entre deux images. À ×16, un pas
    // mensuel de 52 ms, le seuil du banc d'essai à 10 000 individus.
    env.advancePerRead = 0.01;
    const plan: [number, MainMessage][] = [
      [3_500, { type: 'setSpeed', speed: 'fast' }],
      [4_500, { type: 'debugStepCost', milliseconds: 52 }],
      [4_500, { type: 'setSpeed', speed: 'faster' }],
      [5_700, { type: 'setSpeed', speed: 'slow' }],
      [6_500, { type: 'setSpeed', speed: 'faster' }],
      [7_300, { type: 'setSpeed', speed: 'normal' }],
      [8_000, { type: 'setPaused', paused: true }],
      [8_400, { type: 'stepOnce' }],
      [8_500, { type: 'stepOnce' }],
      [8_600, { type: 'stepOnce' }],
      [9_300, { type: 'setPaused', paused: false }],
      [10_000, { type: 'setSpeed', speed: 'faster' }],
    ];
    const load = 9_000;
    let previous = new Map<number, [number, number]>();
    let previousShown = clock.instant;
    let previousSpeed: SpeedId = speed;
    let previousFrame: DatedFrame | undefined;
    let crossings = 0;
    let switches = 0;
    let children = 0;
    let loaded = false;
    while (game.now < 11_000) {
      const shown = game.frame();
      const dated = frames.at(shown);
      if (dated === undefined) continue;
      if (dated !== previousFrame) switches++;
      previousFrame = dated;
      // L'instant affiché : au plus le double de la vitesse de la partie (de la plus rapide
      // des deux autour d'un changement), ou, dans la seconde d'un changement de vitesse ou
      // de pause, le rattrapage en 0,3 s de son retard, plus un jour.
      const nominal = FRAME_MS / Math.min(dayDuration(speed), dayDuration(previousSpeed));
      const catchUp =
        game.now - change.at < 1000 ? ((change.lag + 1) * FRAME_MS) / PAUSE_CATCH_UP_MS : 0;
      const advance = shown - previousShown;
      expect(advance).toBeGreaterThanOrEqual(0);
      expect(advance, `${speed}, à ${game.now.toFixed(0)} ms`).toBeLessThanOrEqual(
        Math.max(2 * nominal, catchUp) + 1e-9,
      );
      const now = positionsAt(dated, width);
      for (const [id, [x, y]] of now) {
        // Dans le monde, à travers la couture ; le rendu des étapes, qui ne fera rien sauter
        // d'une image à l'autre, vient avec l'étape (b) de 2b.3.
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(width);
        expect(y).toBeGreaterThanOrEqual(0);
        const parent = parentOf.get(id);
        const before =
          previous.get(id) ?? (parent === undefined ? undefined : previous.get(parent));
        if (before === undefined) continue;
        if (!previous.has(id)) children++;
        if (Math.abs(x - before[0]) > width / 2) crossings++;
      }
      previous = now;
      previousShown = shown;
      previousSpeed = speed;
      for (const [at, message] of plan) {
        if (at > game.now - FRAME_MS && at <= game.now) host.receive(message);
      }
      if (!loaded && game.now >= load) {
        // En pause, l'horloge arrêtée sur le dernier état : une sauvegarde, rechargée, montre
        // les mêmes groupes aux mêmes positions.
        loaded = true;
        expect(clock.instant).toBe(clock.received);
        host.receive({ type: 'save', requestId: 1 });
        await host.idle();
        const saved = env.messages('saved').at(0);
        if (saved === undefined) throw new Error('pas de sauvegarde');
        host.receive({ type: 'load', requestId: 2, data: saved.data });
        await host.idle();
        game.flush();
        expect(env.messages('loaded')).toHaveLength(1);
        const reloaded = frames.at(clock.instant);
        if (reloaded === undefined) throw new Error('pas d’image');
        expect(clock.instant).toBe(previousShown);
        // Les mêmes groupes ; l'image relue donne les positions de l'instant de la
        // sauvegarde, que le rendu des étapes (2b.3, étape b) montrera sans saut.
        expect([...positionsAt(reloaded, width).keys()]).toEqual([...previous.keys()]);
      }
    }
    // Plus de quinze pas mensuels, et l'image de l'apparition, chacune à son instant.
    expect(switches).toBeGreaterThanOrEqual(15);
    expect(dayIndex(clock.today())).toBeGreaterThan(15 * DAYS_PER_MONTH);
    expect(loaded).toBe(true);
    expect(crossings).toBeGreaterThan(0);
    expect(children).toBeGreaterThan(0);
  });
});
