import { describe, expect, it, vi } from 'vitest';
import {
  GROUP_STRIDE,
  NO_CARRIER,
  type GroupsFrame,
  type LegArrays,
  type MainMessage,
  type SpawnGroupCommand,
} from '../core/protocol';
import { carriedSide, cellOf, FIXED, wrapFixedX } from '../core/position';
import {
  dayDuration,
  dayIndex,
  DAYS_PER_MONTH,
  monthDuration,
  type GameTime,
  type SpeedId,
} from '../core/time';
import type { SimState } from '../sim/state';
import { carriedOffset } from '../render/crowd';
import { scatteredGroups, testHuman, testState } from '../sim/testing';
import type { SimulationHost } from '../worker/host';
import {
  CrowdTimeline,
  datedFrame,
  FrameQueue,
  LegQueue,
  MAX_FRAMES,
  PositionMirror,
  type DatedFrame,
} from './frames';
import { PAUSE_CATCH_UP_MS } from './gameClock';
import { FRAME_MS, HostedGame } from './testing';

/** Aucune étape. */
const noLegs = (): LegArrays => ({
  slots: new Uint32Array(0),
  days: new Uint32Array(0),
  start: new Int32Array(0),
  step: new Int32Array(0),
  count: new Uint16Array(0),
});

/** Des étapes : [emplacement, jour, x, y, pas x, pas y, jours], en unités. */
function legs(...list: [number, number, number, number, number, number, number][]): LegArrays {
  return {
    slots: Uint32Array.from(list, (leg) => leg[0]),
    days: Uint32Array.from(list, (leg) => leg[1]),
    start: Int32Array.from(list.flatMap((leg) => [leg[2], leg[3]])),
    step: Int32Array.from(list.flatMap((leg) => [leg[4], leg[5]])),
    count: Uint16Array.from(list, (leg) => leg[6]),
  };
}

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
    legs: noLegs(),
  };
}

/**
 * Une image d'un seul groupe : ses membres [emplacement, x, y, porteur] (unités, porteur en
 * emplacement ou NO_CARRIER), d'identifiants 100 + emplacement, et les étapes en cours.
 */
function group(members: [number, number, number, number][], current = noLegs()): GroupsFrame {
  const count = members.length;
  return {
    groups: Uint32Array.from([7, 3, 4, count, 1]),
    slots: Uint32Array.from(members, (member) => member[0]),
    ids: Uint32Array.from(members, (member) => 100 + member[0]),
    sprites: new Uint16Array(count),
    statures: new Uint8Array(count).fill(96),
    positions: Int32Array.from(members.flatMap((member) => [member[1], member[2]])),
    carriers: Uint32Array.from(members, (member) => member[3]),
    legs: current,
  };
}

const time = (tick: number, day: number): GameTime => ({ tick, day });

/** Identifiants des groupes d'une image. */
const groupIds = (frame: GroupsFrame) =>
  Array.from(frame.groups.filter((_, index) => index % GROUP_STRIDE === 0));

/** Identifiants des groupes d'une image datée. */
const ids = (dated: DatedFrame | undefined) => (dated === undefined ? [] : groupIds(dated.frame));

/** Toute case se franchit. */
const anywhere = () => true;

/** Positions de tous les membres d'un miroir à l'instant `t`, en unités, par rang. */
function positionsOf(mirror: PositionMirror, t: number) {
  const count = mirror.frame?.ids.length ?? 0;
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const moving = new Uint8Array(count);
  for (let rank = 0; rank < mirror.groupCount; rank++) mirror.positions(rank, t, xs, ys, moving);
  return { xs, ys, moving };
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
});

describe('étapes datées et positions de l’instant affiché (ADR 0014)', () => {
  it('suit chaque étape à partir de son jour, la dernière reçue d’un même jour l’emportant', () => {
    const mirror = new PositionMirror({ carry: 0.2, passable: anywhere });
    mirror.reset({ at: 40, tick: 1, frame: group([[5, 3 * FIXED, 4 * FIXED, NO_CARRIER]]) }, 512);
    const queue = new LegQueue();
    // Le jour 41, une étape de deux jours vers l'est ; le jour 42, elle est remplacée, le même
    // jour, par un écart de côté d'un jour.
    queue.push(legs([5, 41, 3 * FIXED, 4 * FIXED, FIXED / 2, 0, 2]));
    queue.push(
      legs(
        [5, 42, 3.5 * FIXED, 4 * FIXED, FIXED / 2, 0, 3],
        [5, 42, 3.5 * FIXED, 4 * FIXED, 0, FIXED / 4, 1],
      ),
    );
    queue.applyUntil(40.5, mirror);
    expect(positionsOf(mirror, 40.5).xs[0]).toBe(3 * FIXED);
    expect(queue.size).toBe(3);
    queue.applyUntil(41, mirror);
    expect(positionsOf(mirror, 41).xs[0]).toBe(3 * FIXED);
    queue.applyUntil(41.5, mirror);
    const half = positionsOf(mirror, 41.5);
    // Entre deux jours, sur le segment du jour ; en marche.
    expect(half.xs[0]).toBe(3.25 * FIXED);
    expect(half.moving[0]).toBe(1);
    expect(queue.size).toBe(2);
    queue.applyUntil(42.5, mirror);
    const aside = positionsOf(mirror, 42.5);
    expect(aside.xs[0]).toBe(3.5 * FIXED);
    expect(aside.ys[0]).toBe(4 * FIXED + FIXED / 8);
    // L'étape finie, il se tient à son bout, et ne marche plus.
    const done = positionsOf(mirror, 50);
    expect(done.ys[0]).toBe(4.25 * FIXED);
    expect(done.moving[0]).toBe(0);
    expect(queue.size).toBe(0);
  });

  it('passe la couture au plus court, x toujours dans le monde', () => {
    const width = 8;
    const mirror = new PositionMirror({ carry: 0.2, passable: anywhere });
    const start = 7.75 * FIXED;
    mirror.reset(
      {
        at: 0,
        tick: 0,
        frame: group([[0, start, FIXED, NO_CARRIER]], legs([0, 0, start, FIXED, FIXED / 2, 0, 2])),
      },
      width,
    );
    const xs: number[] = [];
    for (let t = 0; t <= 2; t += 0.25) xs.push(positionsOf(mirror, t).xs[0] / FIXED);
    expect(xs).toEqual([7.75, 7.875, 0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75]);
    // Ce que le groupe peut atteindre se déroule depuis son origine, sans faire le tour du monde.
    const bounds = new Float64Array(5);
    mirror.bounds(0, bounds);
    expect(bounds[2] - bounds[1]).toBeLessThan(2 * FIXED);
  });

  it('porte le nourrisson contre sa mère, du côté de son identifiant, sauf sur l’eau', () => {
    const side = carriedSide(102);
    const reach = Math.round(side * testHuman.display.carry * FIXED);
    // Sa mère, l'emplacement 1, marche ; il est porté (emplacement 2).
    const x = 5 * FIXED + FIXED / 2;
    const members: [number, number, number, number][] = [
      [1, x, 6 * FIXED, NO_CARRIER],
      [2, x, 6 * FIXED, 1],
    ];
    const walking = legs([1, 0, x, 6 * FIXED, FIXED / 4, 0, 4]);
    const mirror = new PositionMirror({ carry: testHuman.display.carry, passable: anywhere });
    mirror.reset({ at: 0, tick: 0, frame: group(members, walking) }, 64);
    expect(mirror.carrierOf[1]).toBe(0);
    expect(mirror.firstCarried[0]).toBe(1);
    for (const t of [0, 0.5, 1, 3.25]) {
      const { xs, ys, moving } = positionsOf(mirror, t);
      expect(xs[1]).toBe(xs[0] + reach);
      expect(ys[1]).toBe(ys[0]);
      // Porté, il ne marche pas.
      expect(moving[1]).toBe(0);
    }
    // Contre une case d'eau, il se tient sur elle : là où le worker le pose à son sevrage.
    const dry = (cell: number) => cell === cellOf(x, 6 * FIXED, 64);
    const shore = new PositionMirror({ carry: testHuman.display.carry, passable: dry });
    shore.reset({ at: 0, tick: 0, frame: group(members) }, 64);
    // À 0,2 case du centre de sa case, il y reste.
    expect(positionsOf(shore, 0).xs[1]).toBe(x + reach);
    const edge = 5 * FIXED + (side > 0 ? FIXED - 100 : 100);
    shore.reset(
      {
        at: 0,
        tick: 0,
        frame: group([
          [1, edge, 6 * FIXED, NO_CARRIER],
          [2, edge, 6 * FIXED, 1],
        ]),
      },
      64,
    );
    expect(positionsOf(shore, 0).xs[1]).toBe(edge);
  });

  it('oublie à l’image suivante les étapes qu’elle remplace, et rend leurs tampons', () => {
    const recycled: string[] = [];
    const timeline = new CrowdTimeline({
      carry: 0.2,
      passable: anywhere,
      recycleFrame: (old) => recycled.push(`image ${String(old.groups[3])}`),
      recycleLegs: (old) => recycled.push(`étapes ${String(old.slots.length)}`),
    });
    timeline.reset(group([[0, FIXED, FIXED, NO_CARRIER]]), time(0, 0), 64);
    // Les étapes des jours 0 et 2, puis l'image du pas mensuel, qui reprend l'étape en cours.
    timeline.receive(time(0, 2), legs([0, 0, FIXED, FIXED, FIXED / 8, 0, 40]), undefined);
    timeline.receive(time(0, 3), legs([0, 2, FIXED * 1.25, FIXED, 0, FIXED / 8, 40]), undefined);
    const next = group(
      [
        [0, 1.25 * FIXED, 2 * FIXED, NO_CARRIER],
        [1, 1.25 * FIXED, 2 * FIXED, NO_CARRIER],
      ],
      legs([0, 30, 1.25 * FIXED, 2 * FIXED, 0, FIXED / 8, 30]),
    );
    timeline.receive(time(1, 0), undefined, next);
    timeline.show(1);
    expect(recycled).toEqual(['étapes 1']);
    expect(positionsOf(timeline.shown, 1).xs[0]).toBe(FIXED * 1.125);
    // L'horloge saute au-delà de l'image : les étapes qu'elle remplace s'oublient sans servir,
    // et l'image dépassée retourne au worker.
    timeline.show(31);
    expect(recycled).toEqual(['étapes 1', 'étapes 1', 'image 1']);
    expect(positionsOf(timeline.shown, 31).ys[0]).toBe(2 * FIXED + FIXED / 8);
    // Le dernier état reçu, à son instant, que l'outil d'apparition calcule à sa demande.
    expect(timeline.latestAt).toBe(30);
    expect(timeline.occupied(31, { width: 64, height: 32 })).toEqual(new Set([2 * 64 + 1]));
    timeline.clear();
    expect(recycled.at(-1)).toBe('image 2');
  });
});

/** L'état de l'hôte, que les tests lisent sans passer par une sauvegarde. */
function hostState(host: SimulationHost): SimState | undefined {
  return (host as unknown as { state: SimState | undefined }).state;
}

/** Copie profonde d'un message reçu : un second miroir le lit sans partager ses tampons. */
const copy = <T>(value: T): T => structuredClone(value);

describe('positions du fil principal avec le vrai hôte (ADR 0013, ADR 0014)', () => {
  it('ne calcule le dernier état reçu qu’à la demande de l’outil d’apparition, aux mêmes cases', async () => {
    const game = new HostedGame();
    const { crowd } = game;
    const reset = vi.spyOn(crowd.latest, 'reset');
    const apply = vi.spyOn(crowd.latest, 'apply');
    const touched = () => reset.mock.calls.length + apply.mock.calls.length;
    // Le dernier état, tel que le suivait la chronologie à chaque message : les étapes reçues,
    // puis l'image, qui les remplace. Des copies : la chronologie rend ses tampons au worker.
    const eager = new PositionMirror({ carry: testHuman.display.carry, passable: game.passable });
    let eagerAt = 0;
    game.onMessage = (message) => {
      if (message.type === 'snapshot') {
        eager.reset(datedFrame(copy(message.frame), message.time), message.world.size.width);
        eagerAt = dayIndex(message.time);
      }
      if (message.type !== 'delta') return;
      const started = message.legs;
      for (let index = 0; index < (started?.slots.length ?? 0); index++) {
        eager.apply(
          started?.slots[index] ?? 0,
          started?.days[index] ?? 0,
          started?.start[2 * index] ?? 0,
          started?.start[2 * index + 1] ?? 0,
          started?.step[2 * index] ?? 0,
          started?.step[2 * index + 1] ?? 0,
          started?.count[index] ?? 0,
        );
      }
      if (message.frame !== undefined) {
        eager.reset(datedFrame(copy(message.frame), message.time), game.columns);
      }
      eagerAt = Math.max(eagerAt, dayIndex(message.time));
    };
    await game.start();
    const state = testState();
    for (const command of scatteredGroups(state, 30, 30)) {
      game.host.receive({ type: 'game', command });
    }
    game.host.receive({ type: 'setSpeed', speed: 'faster' });
    let seen = touched();
    let asked = 0;
    let ahead = 0;
    for (let image = 1; image <= 600; image++) {
      const shown = game.frame();
      // Ni les messages ni l'image ne touchent au miroir du dernier état.
      expect(touched()).toBe(seen);
      if (image % 25 !== 0) continue;
      const cells = crowd.occupied(shown, state.size);
      expect(cells).toEqual(eager.cells(eagerAt, state.size, crowd.shown.cells(shown, state.size)));
      expect(crowd.latest.frame).toBeUndefined();
      seen = touched();
      asked++;
      if (eagerAt > shown) ahead++;
    }
    expect(asked).toBe(24);
    expect(ahead).toBeGreaterThan(10);
  });

  it('borne les étapes quand la carte ne se dessine plus, comme dans un onglet en arrière-plan', async () => {
    const game = new HostedGame();
    // Les jours des étapes reçues, dès le début de la partie.
    const days: number[] = [];
    game.onMessage = (message) => {
      if (message.type === 'delta') days.push(...(message.legs?.days ?? []));
    };
    await game.start();
    const { env, host, crowd } = game;
    for (const command of scatteredGroups(testState(), 30, 30)) {
      host.receive({ type: 'game', command });
    }
    host.receive({ type: 'setSpeed', speed: 'faster' });
    for (let image = 0; image < 30; image++) game.frame();
    const recycled = game.recycledLegs;
    // Plus de MAX_FRAMES mois à ×16 : les messages arrivent, mais aucune image ne se dessine.
    env.advance((MAX_FRAMES + 8) * monthDuration('faster'));
    game.flush();
    expect(crowd.frames.size).toBe(MAX_FRAMES);
    // Ne restent que les étapes parties depuis la plus ancienne image gardée ; les autres
    // sont rendues au worker.
    const oldest = crowd.frames.oldest()?.at ?? Number.NaN;
    expect(crowd.legs.size).toBe(days.filter((day) => day >= oldest).length);
    expect(crowd.legs.size).toBeLessThan(0.8 * days.length);
    expect(game.recycledLegs - recycled).toBeGreaterThan(50);
    // Au retour, la première image montre le dernier état, aux positions du worker.
    const state = hostState(host);
    if (state === undefined) throw new Error('pas de partie');
    expect(dayIndex(state)).toBe(crowd.latestAt);
    crowd.show(crowd.latestAt);
    const { shown } = crowd;
    const { xs, ys } = positionsOf(shown, crowd.latestAt);
    const { x, y } = state.people.columns;
    let compared = 0;
    for (let member = 0; member < (shown.frame?.ids.length ?? 0); member++) {
      if ((shown.carrierOf[member] ?? -1) >= 0) continue;
      const slot = shown.frame?.slots[member] ?? 0;
      expect([xs[member], ys[member]], String(slot)).toEqual([x[slot], y[slot]]);
      compared++;
    }
    expect(compared).toBeGreaterThan(500);
  });

  it('redonne aux jours entiers les positions du worker, interpole sans couper l’eau ni rien faire sauter : vitesses, pause, pas unique, chargement en cours de mois, couture', async () => {
    const game = new HostedGame();
    await game.start();
    const { env, host, clock, crowd } = game;
    // Des groupes nombreux, qui se scindent ; d'autres au bord de la couture.
    const width = 512;
    const state = testState();
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
    // Les positions du worker à l'instant de chaque delta et de chaque instantané, relevées
    // à leur envoi, par emplacement.
    const recorded = new Map<number, { x: ArrayLike<number>; y: ArrayLike<number> }>();
    const post = env.post.bind(env);
    env.post = (message, transfer) => {
      const current = hostState(host);
      if ((message.type === 'delta' || message.type === 'snapshot') && current !== undefined) {
        const { x, y } = current.people.columns;
        recorded.set(dayIndex(message.time), { x: x.slice(), y: y.slice() });
      }
      post(message, transfer);
    };
    // Un second miroir, nourri de copies des mêmes messages, regardé à chaque jour entier ;
    // il part de l'instantané de la partie.
    const exact = new CrowdTimeline({ carry: testHuman.display.carry, passable: game.passable });
    const snapshot = env.messages('snapshot').at(-1);
    if (snapshot === undefined) throw new Error('pas d’instantané');
    exact.reset(copy(snapshot.frame), snapshot.time, width);
    let checked = dayIndex(snapshot.time);
    let compared = 0;
    let fastest = 0;
    const compare = (latest: number) => {
      for (let day = checked + 1; day <= latest; day++) {
        const worker = recorded.get(day);
        if (worker === undefined) continue;
        exact.show(day);
        const shown = exact.shown;
        const frame = shown.frame;
        if (frame === undefined) continue;
        const { xs, ys } = positionsOf(shown, day);
        for (let member = 0; member < frame.ids.length; member++) {
          if ((shown.carrierOf[member] ?? -1) >= 0) continue;
          const slot = frame.slots[member] ?? 0;
          if (xs[member] !== worker.x[slot] || ys[member] !== worker.y[slot]) {
            throw new Error(`jour ${String(day)}, emplacement ${String(slot)} : écart au worker`);
          }
          compared++;
        }
      }
      checked = Math.max(checked, latest);
    };
    // Ce que suit chaque image : la vitesse et la pause des derniers temps reçus, et le retard
    // de l'horloge au dernier changement.
    let speed: SpeedId = 'normal';
    let paused = false;
    let change = { at: 0, lag: 0 };
    game.onMessage = (message) => {
      if (message.type === 'snapshot') {
        exact.reset(copy(message.frame), message.time, message.world.size.width);
        checked = dayIndex(message.time) - 1;
        compare(dayIndex(message.time));
      }
      if (message.type === 'delta') {
        const { legs: started } = message;
        for (let index = 0; index < (started?.slots.length ?? 0); index++) {
          const sx = (started?.step[2 * index] ?? 0) / FIXED;
          const sy = (started?.step[2 * index + 1] ?? 0) / FIXED;
          fastest = Math.max(fastest, Math.sqrt(sx * sx + sy * sy));
        }
        exact.receive(
          message.time,
          started === undefined ? undefined : copy(started),
          message.frame === undefined ? undefined : copy(message.frame),
        );
        // Une commande en pause : l'image d'un même instant se compare à nouveau.
        if (message.days === 0) checked = dayIndex(message.time) - 1;
        compare(dayIndex(message.time));
      }
      if (message.type !== 'delta' && message.type !== 'time') return;
      if (message.time.speed !== speed || message.time.paused !== paused) {
        change = { at: game.now, lag: clock.received - clock.instant };
      }
      speed = message.time.speed;
      paused = message.time.paused;
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
    let previous = new Map<number, { x: number; y: number; carried: boolean; edge: boolean }>();
    let previousShown = clock.instant;
    let previousSpeed: SpeedId = speed;
    let previousFrame: GroupsFrame | undefined;
    let crossings = 0;
    let switches = 0;
    let moves = 0;
    let between = 0;
    let loaded = false;
    let carriedSeen = 0;
    let squeezed = 0;
    while (game.now < 11_000) {
      const shown = game.frame();
      const mirror = crowd.shown;
      const frame = mirror.frame;
      if (frame === undefined) continue;
      if (frame !== previousFrame) switches++;
      previousFrame = frame;
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
      const { xs, ys } = positionsOf(mirror, shown);
      const now = new Map<number, { x: number; y: number; carried: boolean; edge: boolean }>();
      if (!Number.isInteger(shown)) between++;
      for (let member = 0; member < frame.ids.length; member++) {
        const x = (xs[member] ?? 0) / FIXED;
        const y = (ys[member] ?? 0) / FIXED;
        // Dans le monde, à travers la couture, et jamais sur l'eau.
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(width);
        const carried = (mirror.carrierOf[member] ?? -1) >= 0;
        if (carried) carriedSeen++;
        if (!game.passable(cellOf(xs[member] ?? 0, ys[member] ?? 0, width))) {
          throw new Error(`${String(frame.ids[member])} sur l'eau, à ${game.now.toFixed(0)} ms`);
        }
        const id = frame.ids[member] ?? 0;
        // Un porté contre l'eau : à son plein écart, il y serait.
        const mother = mirror.carrierOf[member] ?? -1;
        const reach = wrapFixedX(
          (xs[mother] ?? 0) + carriedOffset(id, testHuman.display.carry),
          width,
        );
        const edge = carried && !game.passable(cellOf(reach, ys[mother] ?? 0, width));
        now.set(id, { x, y, carried, edge });
        const before = previous.get(id);
        if (before === undefined) continue;
        let dx = Math.abs(x - before.x);
        if (dx > width / 2) {
          dx = width - dx;
          crossings++;
        }
        const moved = Math.sqrt(dx * dx + (y - before.y) ** 2);
        if (moved > 0) moves++;
        // Rien ne saute : au plus l'étape la plus rapide, sur les jours affichés entre deux
        // images.
        // Un nourrisson porté s'écarte au plus de display.carry case par jour de sa mère ;
        // contre l'eau, son écart se resserre vers elle d'un coup, de display.carry au plus.
        const aside = carried || before.carried ? testHuman.display.carry : 0;
        const squeeze = edge || before.edge ? testHuman.display.carry : 0;
        const bound = (fastest + aside) * advance;
        if (moved > bound + squeeze + 1e-6) {
          throw new Error(
            `${String(id)} saute de ${moved.toFixed(3)} case à ${game.now.toFixed(0)} ms`,
          );
        }
        if (moved > bound + 1e-6) squeezed++;
      }
      previous = now;
      previousShown = shown;
      previousSpeed = speed;
      for (const [at, message] of plan) {
        if (at > game.now - FRAME_MS && at <= game.now) host.receive(message);
      }
      if (!loaded && game.now >= load) {
        // En pause, l'horloge arrêtée sur le dernier état, au milieu d'un mois : une
        // sauvegarde, rechargée, montre les mêmes individus aux mêmes positions.
        loaded = true;
        expect(clock.instant).toBe(clock.received);
        expect(clock.today().day).toBeGreaterThan(0);
        host.receive({ type: 'save', requestId: 1 });
        await host.idle();
        const saved = env.messages('saved').at(0);
        if (saved === undefined) throw new Error('pas de sauvegarde');
        host.receive({ type: 'load', requestId: 2, data: saved.data });
        await host.idle();
        game.flush();
        expect(env.messages('loaded')).toHaveLength(1);
        crowd.show(clock.instant);
        expect(clock.instant).toBe(previousShown);
        const reloaded = positionsOf(crowd.shown, clock.instant);
        const reframe = crowd.shown.frame;
        if (reframe === undefined) throw new Error('pas d’image');
        expect(Array.from(reframe.ids).sort((a, b) => a - b)).toEqual(
          [...previous.keys()].sort((a, b) => a - b),
        );
        for (let member = 0; member < reframe.ids.length; member++) {
          const before = previous.get(reframe.ids[member] ?? 0);
          expect((reloaded.xs[member] ?? 0) / FIXED).toBe(before?.x);
          expect((reloaded.ys[member] ?? 0) / FIXED).toBe(before?.y);
        }
      }
    }
    // Plus de quinze pas mensuels, chacun à son instant, des individus qui marchent entre
    // deux jours, et des milliers de positions égales à celles du worker.
    expect(switches).toBeGreaterThanOrEqual(15);
    expect(dayIndex(clock.today())).toBeGreaterThan(15 * DAYS_PER_MONTH);
    expect(loaded).toBe(true);
    expect(crossings).toBeGreaterThan(0);
    expect(moves).toBeGreaterThan(1000);
    expect(between).toBeGreaterThan(100);
    expect(compared).toBeGreaterThan(100_000);
    expect(fastest).toBeGreaterThan(0.5);
    expect(fastest).toBeLessThan(4);
    // Les tampons lus sont rendus à l'hôte.
    expect(game.recycled).toBeGreaterThan(100);
    // Des nourrissons portés, contre leur mère, jamais sur l'eau non plus ; rares sont ceux
    // que l'eau a fait se resserrer d'un coup.
    expect(carriedSeen).toBeGreaterThan(10_000);
    expect(squeezed).toBeLessThan(10);
  });
});
