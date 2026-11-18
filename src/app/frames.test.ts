import { describe, expect, it } from 'vitest';
import { deltaX } from '../core/cylinder';
import {
  GROUP_STRIDE,
  PROTOCOL_VERSION,
  type GroupsFrame,
  type SpawnGroupCommand,
} from '../core/protocol';
import { dayIndex, DAYS_PER_MONTH, type GameTime } from '../core/time';
import { emptyWalks } from '../core/walk';
import { groupPositions } from '../render/crowd';
import { scatteredGroups, testData, testParams, testState } from '../sim/testing';
import { SimulationHost } from '../worker/host';
import { FakeEnvironment, testGenerator } from '../worker/testing';
import { datedFrame, FrameQueue, MAX_FRAMES, walkDay, type DatedFrame } from './frames';
import { GameClock } from './gameClock';

/** Une image de groupes au repos, d'identifiants `ids`, sur la ligne 10. */
function frame(...ids: number[]): GroupsFrame {
  return {
    groups: Uint32Array.from(ids.flatMap((id) => [id, id, 10, 1, 1])),
    sprites: new Uint16Array(ids.length),
    walks: emptyWalks(),
  };
}

const time = (tick: number, day: number): GameTime => ({ tick, day });

/** Identifiants des groupes d'une image datée. */
const ids = (dated: DatedFrame | undefined) =>
  dated === undefined
    ? []
    : Array.from(dated.frame.groups.filter((_, index) => index % GROUP_STRIDE === 0));

/** Position de chaque groupe d'une image datée à l'instant `shown`, par identifiant. */
function positionsAt(
  dated: DatedFrame,
  shown: number,
  width: number,
): Map<number, [number, number]> {
  const count = dated.frame.groups.length / GROUP_STRIDE;
  const positions = new Float64Array(count * 2);
  groupPositions(
    dated.frame,
    dated.walkOf,
    walkDay(dated, shown),
    width,
    positions,
    new Uint8Array(count),
  );
  const map = new Map<number, [number, number]>();
  for (let rank = 0; rank < count; rank++) {
    map.set(dated.frame.groups[rank * GROUP_STRIDE] ?? 0, [
      positions[rank * 2] ?? 0,
      positions[rank * 2 + 1] ?? 0,
    ]);
  }
  return map;
}

describe('images des groupes datées (ADR 0013)', () => {
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

  it('borne la file, comme dans un onglet en arrière-plan où l’horloge n’avance pas', () => {
    const queue = new FrameQueue();
    queue.reset(frame(1), time(0, 0));
    for (let month = 1; month <= 40; month++) queue.push(frame(month), time(month, 0));
    expect(queue.size).toBe(MAX_FRAMES);
    expect(ids(queue.latest())).toEqual([40]);
    // L'horloge saute au dernier état : la dernière image.
    expect(ids(queue.at(40 * DAYS_PER_MONTH))).toEqual([40]);
    expect(queue.size).toBe(1);
  });

  it('date les marches de leur mois, et retrouve la marche de chaque groupe', () => {
    const groups = frame(7, 8);
    const walks = {
      groups: Uint32Array.of(8),
      ends: Uint32Array.of(2),
      cells: Uint32Array.of(10 * 512 + 8, 10 * 512 + 9),
      costs: Float64Array.of(0, 1),
      budgets: Float64Array.of(30),
    };
    const dated = datedFrame({ ...groups, walks }, time(3, 12));
    expect(dated.at).toBe(3 * DAYS_PER_MONTH + 12);
    expect(dated.walkOf).toEqual(new Map([[8, 0]]));
    expect(walkDay(dated, 3 * DAYS_PER_MONTH + 12.5)).toBe(12.5);
    expect(walkDay(dated, 4 * DAYS_PER_MONTH + 3)).toBe(DAYS_PER_MONTH);
    const at = positionsAt(dated, 3 * DAYS_PER_MONTH + 0.5, 512);
    expect(at.get(7)).toEqual([7.5, 10.5]);
    expect(at.get(8)).toEqual([9, 10.5]);
  });

  it('ne fait rien sauter, avec le vrai hôte : ni au pas mensuel, ni à la couture, ni à une scission', async () => {
    const env = new FakeEnvironment();
    const host = new SimulationHost(env, testData, testGenerator);
    host.receive({ type: 'hello', protocol: PROTOCOL_VERSION });
    host.receive({ type: 'newGame', params: testParams() });
    await host.idle();
    // Des groupes nombreux, qui se scindent ; deux au bord de la couture.
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
    const clock = new GameClock();
    const queue = new FrameQueue();
    let delivered = 0;
    const FRAME_MS = 1000 / 60;
    let previous = new Map<number, [number, number]>();
    let previousFrame: DatedFrame | undefined;
    let crossings = 0;
    let switches = 0;
    let largest = 0;
    for (let t = FRAME_MS; t < 4 * 3_334; t += FRAME_MS) {
      env.advance(t - env.time);
      for (const entry of env.sent.slice(delivered)) {
        delivered++;
        const { message } = entry;
        if (message.type === 'snapshot') {
          clock.reset(message.time, entry.at);
          queue.reset(message.frame, message.time);
        }
        if (message.type === 'delta') {
          if (message.frame !== undefined) queue.push(message.frame, message.time);
          clock.receive(message.time, entry.at);
        }
      }
      const shown = clock.advance(t);
      const dated = queue.at(shown);
      if (dated === undefined) continue;
      if (dated !== previousFrame) switches++;
      previousFrame = dated;
      const now = positionsAt(dated, shown, width);
      for (const [id, [x, y]] of now) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(width);
        const before = previous.get(id);
        if (before === undefined) continue;
        // Au plus court, à travers la couture : jamais plus d'une case d'une image à l'autre.
        const dx = deltaX(before[0], x, width);
        const step = Math.hypot(dx, y - before[1]);
        largest = Math.max(largest, step);
        expect(step).toBeLessThan(1);
        if (Math.abs(x - before[0]) > width / 2) crossings++;
      }
      previous = now;
    }
    // Quatre mois : quatre pas mensuels, et l'image de l'apparition, chacune à son instant.
    expect(switches).toBeGreaterThanOrEqual(5);
    expect(dayIndex(clock.today())).toBeGreaterThan(3 * DAYS_PER_MONTH);
    expect(crossings).toBeGreaterThan(0);
    expect(largest).toBeGreaterThan(0.05);
  });
});
