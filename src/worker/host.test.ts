import { describe, expect, it, vi } from 'vitest';
import type { GameData } from '../core/data';
import {
  CHRONICLE_PAGE,
  CHRONICLE_RECENT,
  FAUNA_GAIT,
  FAUNA_RUN,
  faunaBuffers,
  faunaLegBuffers,
  frameBuffers,
  GROUP_STRIDE,
  legBuffers,
  PROTOCOL_VERSION,
  type ChronicleView,
  type GameCommand,
  type GroupsFrame,
  type LoggedCommand,
  type SpawnGroupCommand,
} from '../core/protocol';
import { readSave, SaveError } from '../core/save/format';
import {
  batchDays,
  dayIndex,
  DAYS_PER_MONTH,
  daysDuration,
  MAX_BATCH_DAYS,
  MIN_BATCH_MS,
  monthDuration,
  NORMAL_DAY_MS,
  NORMAL_MONTH_MS,
  SPEEDS,
  type GameTime,
} from '../core/time';
import { worldCalendars } from '../core/snow';
import { CHUNK_SIZE, GENERATION_STAGES, LAYER_NAMES, WORLD_SIZES } from '../core/world';
import { advanceDay } from '../sim/day';
import { INTENTION, WALK } from '../sim/population';
import { replay } from '../sim/replay';
import { MIGRATIONS, restoreState } from '../sim/save';
import { fingerprint } from '../sim/step';
import {
  firstCellOf,
  neighboringGroups,
  scatteredGroups,
  testData,
  testHuman,
  testParams,
  testState,
  testWorld,
} from '../sim/testing';
import { SimulationHost, type HostEnvironment } from './host';
import { FakeEnvironment, testGenerator, WAKE_SLACK_MS } from './testing';

const generate = testGenerator;

function newHost(env: HostEnvironment, data: GameData = testData): SimulationHost {
  return new SimulationHost(env, data, generate);
}

/** Apparitions de `count` groupes de `members` personnes, répartis sur les terres. */
function spawns(count: number, members = 12, seed = 'graine'): SpawnGroupCommand[] {
  return scatteredGroups(testState(seed), count, members);
}

/** Une case de terre du monde de cette graine, que le pinceau peut peindre. */
function landCell(seed = 'graine'): { x: number; y: number } {
  return firstCellOf(testState(seed), (family) => family !== 'water');
}

function paint(cell: { x: number; y: number }, biome = 'desert'): GameCommand {
  return { type: 'paintBiome', x: cell.x, y: cell.y, biome };
}

function greetedHost(data: GameData = testData) {
  const env = new FakeEnvironment();
  const host = newHost(env, data);
  host.receive({ type: 'hello', protocol: PROTOCOL_VERSION });
  return { env, host };
}

async function startedHost(seed = 'graine', data: GameData = testData) {
  const { env, host } = greetedHost(data);
  host.receive({ type: 'newGame', params: testParams(seed) });
  await host.idle();
  return { env, host };
}

/** La dernière image des groupes envoyée, par l'instantané ou par un delta. */
function lastFrame(env: FakeEnvironment): GroupsFrame | undefined {
  let frame: GroupsFrame | undefined;
  for (const { message } of env.sent) {
    if (message.type === 'snapshot') frame = message.frame;
    if (message.type === 'delta' && message.frame !== undefined) frame = message.frame;
  }
  return frame;
}

/** Instant du dernier état envoyé, en jours écoulés (dayIndex). */
function lastInstant(env: FakeEnvironment): number {
  let instant = 0;
  for (const { message } of env.sent) {
    if (message.type === 'snapshot' || message.type === 'delta') instant = dayIndex(message.time);
  }
  return instant;
}

/** Instant (mois, jour) du dernier delta. */
function lastTime(env: FakeEnvironment): [number, number] | undefined {
  const time = env.messages('delta').at(-1)?.time;
  return time === undefined ? undefined : [time.tick, time.day];
}

describe('poignée de main', () => {
  it("répond prêt à la bonne version du protocole, avec l'auto-test du générateur", () => {
    const env = new FakeEnvironment();
    newHost(env).receive({ type: 'hello', protocol: PROTOCOL_VERSION });
    expect(env.messages('ready')).toEqual([
      { type: 'ready', protocol: PROTOCOL_VERSION, determinism: true },
    ]);
  });

  it('signale un générateur qui ne redonne pas le monde de référence', () => {
    const env = new FakeEnvironment();
    const host = new SimulationHost(env, testData, (params, onStage) => {
      const world = generate(params, onStage);
      world.biome[0] ^= 1;
      return world;
    });
    host.receive({ type: 'hello', protocol: PROTOCOL_VERSION });
    expect(env.messages('ready').at(0)?.determinism).toBe(false);
    // Même un générateur qui échoue laisse la poignée de main aboutir : le panneau le dira.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing = new FakeEnvironment();
    new SimulationHost(failing, testData, () => {
      throw new Error('générateur en panne');
    }).receive({ type: 'hello', protocol: PROTOCOL_VERSION });
    expect(failing.messages('ready').at(0)?.determinism).toBe(false);
    quiet.mockRestore();
  });

  it('refuse une autre version', () => {
    const env = new FakeEnvironment();
    newHost(env).receive({ type: 'hello', protocol: PROTOCOL_VERSION + 1 });
    expect(env.messages('ready')).toEqual([]);
    expect(env.messages('error').at(0)?.code).toBe('protocol');
  });

  it('refuse une commande de jeu avant la partie', () => {
    const { env, host } = greetedHost();
    host.receive({ type: 'game', command: paint({ x: 0, y: 0 }) });
    expect(env.messages('error').at(0)?.code).toBe('noGame');
  });

  it('ne traite rien sans poignée de main réussie', async () => {
    for (const hello of [[], [{ type: 'hello', protocol: PROTOCOL_VERSION + 1 }]] as const) {
      const env = new FakeEnvironment();
      const host = newHost(env);
      for (const message of hello) host.receive(message);
      host.receive({ type: 'newGame', params: testParams() });
      await host.idle();
      expect(env.messages('snapshot')).toEqual([]);
      expect(env.messages('error').map((error) => error.code)).toContain('protocol');
    }
  });
});

describe('partie', () => {
  it('génère le monde étape par étape, puis envoie un instantané complet, tampons transférés', async () => {
    const { env } = await startedHost();
    expect(env.messages('progress').map((progress) => progress.stage)).toEqual([
      ...GENERATION_STAGES,
    ]);
    expect(env.messages('progress').at(-1)).toMatchObject({ step: 4, steps: 5 });
    expect(env.messages('generated')).toHaveLength(1);
    const snapshot = env.messages('snapshot').at(0);
    expect(snapshot?.world).toEqual({ params: testParams(), size: { width: 512, height: 256 } });
    expect(snapshot?.layers.biome).toEqual(testWorld().biome);
    // Les calendriers de la neige et de la glace (protocole 8, ADR 0019) : huit octets par case,
    // ceux que le monde donne.
    const size = WORLD_SIZES.small;
    expect(snapshot?.calendars).toHaveLength(size.width * size.height * 8);
    expect(snapshot?.calendars).toEqual(
      worldCalendars(size, testWorld(), testData.biomes.entries, testData.seasons),
    );
    const entry = env.sent.find((sent) => sent.message.type === 'snapshot');
    // Les couches du monde et les calendriers, plus les sept tableaux de l'image des groupes et
    // les cinq des étapes en cours (ADR 0014), puis les quatre de l'image du gibier et les cinq
    // de ses étapes en cours (protocole 7, ADR 0018).
    expect(entry?.transfer).toHaveLength(LAYER_NAMES.length + 1 + 21);
    if (entry?.original.type === 'snapshot') {
      expect(entry.transfer).toContain(entry.original.calendars.buffer);
    }
    expect(snapshot?.fauna.ids.length).toBeGreaterThan(400);
    expect(snapshot?.time).toEqual({ tick: 0, day: 0, paused: false, speed: 'normal' });
    expect(entry?.transfer.every((buffer) => buffer instanceof ArrayBuffer)).toBe(true);
  });

  it('refuse des paramètres de monde invalides', async () => {
    const { env, host } = greetedHost();
    for (const params of [
      { ...testParams(), relief: 3 },
      { ...testParams(), size: 'géante' },
      { ...testParams(), seed: '' },
      { ...testParams(), extra: 1 },
    ]) {
      host.receive({ type: 'newGame', params } as never);
    }
    await host.idle();
    expect(env.messages('error').map((error) => error.code)).toEqual([
      'params',
      'params',
      'params',
      'params',
    ]);
    expect(env.messages('snapshot')).toEqual([]);
  });

  it("avance d'un jour à chaque échéance, et n'envoie que les blocs modifiés", async () => {
    const { env, host } = await startedHost();
    const cell = landCell();
    host.receive({ type: 'game', command: paint(cell) });
    env.advance(NORMAL_DAY_MS + WAKE_SLACK_MS);
    const delta = env.messages('delta').at(0);
    expect(delta?.time).toEqual({ tick: 0, day: 1, paused: false, speed: 'normal' });
    expect(delta?.days).toBe(1);
    expect(delta?.chunks).toHaveLength(1);
    const patch = delta?.chunks.at(0);
    expect(patch?.column).toBe(Math.floor(cell.x / CHUNK_SIZE));
    expect(patch?.row).toBe(Math.floor(cell.y / CHUNK_SIZE));
    expect(patch?.biome[(cell.y % CHUNK_SIZE) * CHUNK_SIZE + (cell.x % CHUNK_SIZE)]).toBe(
      testData.biomes.indexOf('desert'),
    );
    env.advance(NORMAL_DAY_MS);
    expect(env.messages('delta').at(1)?.chunks).toEqual([]);
    expect(lastTime(env)).toEqual([0, 2]);
  });

  it('fait durer une année exactement 80 s, 40 s, 10 s et 2,5 s', async () => {
    for (const [speed, year] of [
      ['slow', 80_000],
      ['normal', 40_000],
      ['fast', 10_000],
      ['faster', 2_500],
    ] as const) {
      const { env, host } = await startedHost();
      host.receive({ type: 'setSpeed', speed });
      env.advance(year - 1);
      expect(lastTime(env), speed).not.toEqual([12, 0]);
      env.advance(1);
      expect(lastTime(env), speed).toEqual([12, 0]);
      expect(env.messages('delta').reduce((sum, delta) => sum + delta.days, 0)).toBe(360);
      // Les douze pas mensuels tombent chacun à l'échéance de leur jour, à la milliseconde
      // supérieure, sans dérive.
      const months = env.timed('delta').filter(({ message }) => message.frame !== undefined);
      expect(months).toHaveLength(12);
      months.forEach(({ at }, month) => {
        const due = daysDuration((month + 1) * DAYS_PER_MONTH, speed);
        expect(at, speed).toBeGreaterThanOrEqual(due);
        expect(at, speed).toBeLessThan(due + WAKE_SLACK_MS);
      });
    }
  });

  it('mesure la durée des lots, du jour et du pas mensuel, coût factice compris', async () => {
    const { env, host } = await startedHost();
    host.receive({ type: 'debugStepCost', milliseconds: 200 });
    env.advancePerRead = 0.01;
    env.advance(NORMAL_MONTH_MS + 50);
    const stats = env.messages('stats');
    expect(stats.map((entry) => entry.stats.days)).toEqual(stats.map(() => 1));
    expect(stats).toHaveLength(DAYS_PER_MONTH);
    const daily = stats.slice(0, -1);
    expect(daily.every((entry) => entry.stats.monthMs === undefined)).toBe(true);
    expect(daily.every((entry) => (entry.stats.dayMs ?? 1) < 1)).toBe(true);
    const monthly = stats.at(-1)?.stats;
    expect(monthly?.monthMs).toBeGreaterThanOrEqual(200);
    expect(monthly?.monthMs).toBeLessThan(205);
    expect(monthly?.dayMs).toBeUndefined();
    expect(monthly?.batchMs).toBeGreaterThanOrEqual(monthly?.monthMs ?? Number.NaN);
  });

  it("compte dans la durée du lot son delta, jusqu'à son envoi (W-11)", async () => {
    const { env } = await startedHost();
    env.deltaCost = 40;
    env.advance(NORMAL_DAY_MS + WAKE_SLACK_MS);
    expect(env.messages('stats').at(0)?.stats.batchMs).toBeGreaterThanOrEqual(40);
  });

  it('compte les marcheurs à la fin du lot, sans ceux qui viennent d’arriver', async () => {
    const { env, host } = await startedHost();
    host.receive({ type: 'setPaused', paused: true });
    for (const command of spawns(30, 20)) host.receive({ type: 'game', command });
    // Au second mois, les jours où les marcheurs arrivent au camp.
    for (let day = 0; day < DAYS_PER_MONTH + 12; day++) host.receive({ type: 'stepOnce' });
    for (let request = 1; request <= 6; request++) {
      host.receive({ type: 'stepOnce' });
      const state = restoreState(await savedState(env, host, request), testData);
      let walking = 0;
      state.people.forEach((slot) => {
        if ((state.people.get('move', slot) & INTENTION) === WALK) walking++;
      });
      expect(walking).toBeGreaterThan(0);
      expect(env.messages('stats').at(-1)?.stats.walkers, `jour ${String(state.day)}`).toBe(
        walking,
      );
    }
  });
});

describe('aperçu', () => {
  it('répond par le biome et l’altitude du monde réduit, sans toucher à la partie', async () => {
    const { env, host } = await startedHost();
    host.receive({ type: 'preview', requestId: 5, params: testParams('aperçu'), width: 64 });
    const preview = env.messages('previewReady').at(0);
    expect(preview?.requestId).toBe(5);
    expect(preview?.size).toEqual({ width: 64, height: 32 });
    expect(preview?.biome).toHaveLength(64 * 32);
    expect(preview?.elevation).toHaveLength(64 * 32);
    const entry = env.sent.find((sent) => sent.message.type === 'previewReady');
    expect(entry?.transfer).toHaveLength(2);
    expect(env.messages('snapshot')).toHaveLength(1);
  });

  it('refuse une largeur ou des paramètres invalides', () => {
    const { env, host } = greetedHost();
    for (const width of [0, 63, 2048, Number.NaN]) {
      host.receive({ type: 'preview', requestId: 1, params: testParams(), width });
    }
    host.receive({
      type: 'preview',
      requestId: 2,
      params: { ...testParams(), humidity: 9 },
      width: 64,
    });
    expect(env.messages('error').map((error) => error.code)).toEqual([
      'params',
      'params',
      'params',
      'params',
      'params',
    ]);
    expect(env.messages('previewReady')).toEqual([]);
  });
});

describe('temps', () => {
  it('se met en pause, puis reprend', async () => {
    const { env, host } = await startedHost();
    host.receive({ type: 'setPaused', paused: true });
    expect(env.messages('time').at(-1)?.time).toEqual({
      tick: 0,
      day: 0,
      paused: true,
      speed: 'normal',
    });
    env.advance(5_000);
    expect(env.messages('delta')).toEqual([]);
    host.receive({ type: 'setPaused', paused: false });
    env.advance(NORMAL_DAY_MS + WAKE_SLACK_MS);
    expect(env.messages('delta').map((delta) => [delta.time.tick, delta.time.day])).toEqual([
      [0, 1],
    ]);
  });

  it('envoie un delta par jour à ×1, et à ×16 un lot de trois jours toutes les 16 ms au moins', async () => {
    const { env, host } = await startedHost();
    env.advance(NORMAL_MONTH_MS + WAKE_SLACK_MS);
    const daily = env.timed('delta');
    expect(daily).toHaveLength(DAYS_PER_MONTH);
    expect(daily.map(({ message }) => message.days)).toEqual(daily.map(() => 1));
    daily.forEach(({ at }, index) => {
      expect(at).toBeGreaterThanOrEqual((index + 1) * NORMAL_DAY_MS);
      expect(at).toBeLessThan((index + 1) * NORMAL_DAY_MS + WAKE_SLACK_MS);
    });
    host.receive({ type: 'setSpeed', speed: 'faster' });
    env.advance(daysDuration(4 * DAYS_PER_MONTH, 'faster'));
    const batches = env.timed('delta').slice(DAYS_PER_MONTH);
    expect(batches.length).toBeGreaterThan(30);
    for (let index = 1; index < batches.length; index++) {
      const gap = (batches[index]?.at ?? 0) - (batches[index - 1]?.at ?? 0);
      expect(gap).toBeGreaterThanOrEqual(MIN_BATCH_MS);
    }
    const days = batches.map(({ message }) => message.days);
    expect(days.every((count) => count === 2 || count === 3)).toBe(true);
    expect(days.filter((count) => count === 3).length).toBeGreaterThan(days.length * 0.8);
    // Une soixantaine de lots par seconde au plus : 48 à ×16.
    expect((batches.length * 1000) / daysDuration(4 * DAYS_PER_MONTH, 'faster')).toBeLessThan(
      1000 / MIN_BATCH_MS,
    );
  });

  it("n'avance que d'un jour à la demande, et seulement en pause, pas mensuel compris le trentième", async () => {
    const { env, host } = await startedHost();
    host.receive({ type: 'stepOnce' });
    expect(env.messages('delta')).toEqual([]);
    host.receive({ type: 'setPaused', paused: true });
    host.receive({ type: 'stepOnce' });
    expect(lastTime(env)).toEqual([0, 1]);
    expect(env.messages('delta').at(-1)?.days).toBe(1);
    for (let day = 2; day < DAYS_PER_MONTH; day++) host.receive({ type: 'stepOnce' });
    expect(lastTime(env)).toEqual([0, DAYS_PER_MONTH - 1]);
    expect(env.messages('delta').filter((delta) => delta.frame !== undefined)).toEqual([]);
    host.receive({ type: 'stepOnce' });
    expect(lastTime(env)).toEqual([1, 0]);
    expect(env.messages('delta').at(-1)?.frame).toBeDefined();
    expect(env.messages('stats').at(-1)?.stats.monthMs).toBeDefined();
    // Le jour suivant durera un jour entier à la reprise.
    host.receive({ type: 'setPaused', paused: false });
    env.advance(NORMAL_DAY_MS - 1);
    expect(lastTime(env)).toEqual([1, 0]);
    env.advance(1 + WAKE_SLACK_MS);
    expect(lastTime(env)).toEqual([1, 1]);
  });

  it('ne rattrape pas son retard par rafales : un pas mensuel de 200 ms à ×16', async () => {
    const { env, host } = await startedHost();
    host.receive({ type: 'setSpeed', speed: 'faster' });
    host.receive({ type: 'debugStepCost', milliseconds: 200 });
    env.advancePerRead = 0.01;
    env.advance(3_000);
    const batches = env.timed('delta');
    // Jamais plus de huit jours par lot, ni deux lots à moins de 16 ms l'un de l'autre. Le
    // pas laisse plus de seize jours de retard : l'hôte repart de maintenant, et les lots
    // suivants gardent leurs trois jours, sans rafale de rattrapage.
    const days = batches.map(({ message }) => message.days);
    expect(Math.max(...days)).toBeLessThanOrEqual(MAX_BATCH_DAYS);
    expect(Math.max(...days)).toBe(batchDays('faster'));
    for (let index = 1; index < batches.length; index++) {
      const gap = (batches[index]?.at ?? 0) - (batches[index - 1]?.at ?? 0);
      expect(gap).toBeGreaterThanOrEqual(MIN_BATCH_MS - 1e-6);
    }
    // Un pas de 200 ms, un mois de 208 ms à ×16 : la partie va aussi vite qu'elle le peut.
    expect(monthDuration('faster')).toBeLessThan(400);
    const months = batches.filter(({ message }) => message.frame !== undefined).length;
    expect(months).toBeGreaterThanOrEqual(6);
    expect(months).toBeLessThan(12);
  });

  it('garde la durée de l’année à ×16 malgré un pas mensuel de 52 ms', async () => {
    const { env, host } = await startedHost();
    host.receive({ type: 'setSpeed', speed: 'faster' });
    host.receive({ type: 'debugStepCost', milliseconds: 52 });
    env.advancePerRead = 0.01;
    env.advance(2_600);
    expect(lastInstant(env)).toBeGreaterThanOrEqual(12 * DAYS_PER_MONTH);
    // Chaque pas mensuel commence à l'échéance de son jour, à un lot près : le retard
    // d'un pas se rattrape avant le suivant, au plus huit jours par lot, et ne s'ajoute pas
    // de mois en mois.
    const months = env.timed('delta').filter(({ message }) => message.frame !== undefined);
    expect(months).toHaveLength(12);
    const lot = MIN_BATCH_MS + daysDuration(1, 'faster');
    months.forEach(({ at }, month) => {
      const due = daysDuration((month + 1) * DAYS_PER_MONTH, 'faster');
      expect(at - 52).toBeGreaterThanOrEqual(due - 1);
      expect(at - 52).toBeLessThan(due + lot + 1);
    });
    expect(Math.max(...env.messages('delta').map((delta) => delta.days))).toBeLessThanOrEqual(
      MAX_BATCH_DAYS,
    );
  });
});

describe('commandes de jeu', () => {
  it("s'appliquent au début du jour suivant, qui les journalise", async () => {
    const { env, host } = await startedHost();
    env.advance(NORMAL_DAY_MS * 3 + WAKE_SLACK_MS);
    host.receive({ type: 'game', command: paint(landCell(), 'desert') });
    expect(env.messages('delta').at(-1)?.chunks).toEqual([]);
    expect(env.messages('delta')).toHaveLength(3);
    env.advance(NORMAL_DAY_MS);
    expect(lastTime(env)).toEqual([0, 4]);
    expect(env.messages('delta').at(-1)?.chunks).toHaveLength(1);
    // Un coup de pinceau ne change pas l'image des groupes : elle ne part pas.
    expect(env.messages('delta').at(-1)?.frame).toBeUndefined();
    const log = (await savedState(env, host, 1)).json as { commandLog: unknown[] };
    expect(log.commandLog).toEqual([{ tick: 0, day: 3, command: paint(landCell(), 'desert') }]);
  });

  it("s'appliquent dès leur réception en pause, à l'instant courant (U-7)", async () => {
    const commands = spawns(2);
    // En pause : chaque groupe apparaît aussitôt, dans un delta sans jour, au même instant.
    const { env, host } = await startedHost();
    host.receive({ type: 'setPaused', paused: true });
    for (const [rank, command] of commands.entries()) {
      host.receive({ type: 'game', command });
      const delta = env.messages('delta').at(-1);
      expect(env.messages('delta')).toHaveLength(rank + 1);
      expect(delta?.time).toEqual({ tick: 0, day: 0, paused: true, speed: 'normal' });
      expect(delta?.days).toBe(0);
      expect(delta?.frame?.groups).toHaveLength((rank + 1) * GROUP_STRIDE);
      expect(delta?.chronicle.map((fact) => fact.kind)).toEqual(['groupAppeared']);
    }
    expect(env.messages('stats')).toEqual([]);
    // Hors pause, les mêmes commandes attendent le premier jour.
    const { env: running, host: other } = await startedHost();
    for (const command of commands) other.receive({ type: 'game', command });
    expect(running.messages('delta')).toEqual([]);
    // Trois mois plus tard, les deux parties n'en font qu'une : mêmes groupes, même état,
    // même journal, où les commandes datent du premier instant.
    for (let day = 0; day < 3 * DAYS_PER_MONTH; day++) host.receive({ type: 'stepOnce' });
    running.advance(NORMAL_MONTH_MS * 3);
    expect(lastTime(env)).toEqual([3, 0]);
    expect(lastTime(running)).toEqual([3, 0]);
    expect(lastFrame(env)).toEqual(lastFrame(running));
    const paused = await savedState(env, host, 1);
    expect(paused).toEqual(await savedState(running, other, 1));
    expect((paused.json as { commandLog: unknown }).commandLog).toEqual(
      commands.map((command) => ({ tick: 0, day: 0, command })),
    );
  });

  it("s'appliquent à la mise en pause si elles attendaient encore leur jour (U-7)", async () => {
    const { env, host } = await startedHost();
    for (const command of spawns(1)) host.receive({ type: 'game', command });
    expect(env.messages('delta')).toEqual([]);
    host.receive({ type: 'setPaused', paused: true });
    expect(lastTime(env)).toEqual([0, 0]);
    expect(env.messages('delta').at(-1)?.frame?.groups).toHaveLength(GROUP_STRIDE);
  });

  it('donnent la même partie en pause, en marche et au rejeu, sur des cases voisines (U-7)', async () => {
    // Le second groupe pose ses membres d'après les places du premier : en pause, chaque
    // commande s'applique seule ; en marche et au rejeu, les deux d'un lot.
    const commands = neighboringGroups(testState(), 20);
    const { env, host } = await startedHost();
    host.receive({ type: 'setPaused', paused: true });
    for (const command of commands) host.receive({ type: 'game', command });
    for (let day = 0; day < 2 * DAYS_PER_MONTH; day++) host.receive({ type: 'stepOnce' });
    const { env: running, host: other } = await startedHost();
    for (const command of commands) other.receive({ type: 'game', command });
    running.advance(NORMAL_MONTH_MS * 2 + WAKE_SLACK_MS);
    expect(lastTime(env)).toEqual([2, 0]);
    expect(lastTime(running)).toEqual([2, 0]);
    const paused = await savedState(env, host, 1);
    const print = fingerprint(restoreState(paused, testData));
    expect(fingerprint(restoreState(await savedState(running, other, 1), testData))).toBe(print);
    const json = paused.json as { day: number; commandLog: LoggedCommand[] };
    expect(json.commandLog).toEqual(commands.map((command) => ({ tick: 0, day: 0, command })));
    const until = { tick: paused.meta.tick, day: json.day };
    expect(fingerprint(replay(testParams(), testWorld(), json.commandLog, until, testData))).toBe(
      print,
    );
  });
});

describe('fiches (IHM-02)', () => {
  it('répondent par la fiche demandée, ou par rien pour une cible inconnue (W-10)', async () => {
    const { env: before, host: waiting } = greetedHost();
    waiting.receive({ type: 'inspect', requestId: 1, target: { kind: 'person', id: 1 } });
    expect(before.messages('inspection')).toEqual([{ type: 'inspection', requestId: 1 }]);

    const { env, host } = await startedHost();
    host.receive({ type: 'setPaused', paused: true });
    for (const command of spawns(1)) host.receive({ type: 'game', command });
    host.receive({ type: 'stepOnce' });
    const id = lastFrame(env)?.groups[0] ?? 0;
    host.receive({ type: 'inspect', requestId: 2, target: { kind: 'group', id } });
    const group = env.messages('inspection').at(-1);
    expect(group).toMatchObject({ requestId: 2, group: { id, size: 12 } });
    const member = group?.group?.members.at(0)?.id ?? 0;
    host.receive({ type: 'inspect', requestId: 3, target: { kind: 'person', id: member } });
    expect(env.messages('inspection').at(-1)).toMatchObject({
      requestId: 3,
      person: { id: member, alive: true, group: { id } },
    });
    for (const target of [
      { kind: 'person', id: 999_999 },
      { kind: 'group', id: id + 1 },
      { kind: 'person', id: -4 },
    ] as const) {
      host.receive({ type: 'inspect', requestId: 4, target });
      expect(env.messages('inspection').at(-1)).toEqual({ type: 'inspection', requestId: 4 });
    }
  });
});

describe("apparition d'un groupe (CRE-03)", () => {
  /** Journal et commandes en attente d'une partie, d'après sa sauvegarde. */
  async function logOf(env: FakeEnvironment, host: SimulationHost, requestId: number) {
    const saved = await saveOf(env, host, requestId);
    const save = await readSave(new Uint8Array(saved.data), MIGRATIONS);
    return save.json as { readonly commandLog: unknown[]; readonly pending: unknown[] };
  }

  it('refuse dès sa réception une espèce, une sous-espèce ou une case impossibles (W-10, W-13)', async () => {
    const { env, host } = await startedHost();
    host.receive({ type: 'setPaused', paused: true });
    const valid = spawns(1).at(0);
    if (valid === undefined) throw new Error('aucune case');
    const water = firstCellOf(testState(), (family) => family === 'water');
    const refused: GameCommand[] = [
      { ...valid, species: 'dragon' },
      { ...valid, subspecies: 'sylvains' },
      { ...valid, subspecies: 'human' },
      { ...valid, ...water },
      { ...valid, y: -1 },
      { ...valid, y: 256 },
    ];
    for (const command of refused) host.receive({ type: 'game', command });
    expect(env.messages('error').map((error) => error.code)).toEqual(refused.map(() => 'command'));
    // Rien n'attend ni n'entre au journal : le jour suivant ne fait apparaître personne.
    host.receive({ type: 'stepOnce' });
    expect(lastFrame(env)?.groups).toHaveLength(0);
    expect(env.messages('delta').at(-1)?.chronicle).toEqual([]);
    expect(await logOf(env, host, 1)).toMatchObject({ commandLog: [], pending: [] });
    // La même apparition, sur sa case de terre : en pause, le groupe apparaît aussitôt (U-7).
    host.receive({ type: 'game', command: valid });
    expect(env.messages('delta').at(-1)?.frame?.groups).toHaveLength(GROUP_STRIDE);
    expect(
      env
        .messages('delta')
        .at(-1)
        ?.chronicle.map((fact) => fact.kind),
    ).toEqual(['groupAppeared']);
  });

  it('écarte, sans figer la partie, une apparition qui lève une exception (L-2)', async () => {
    // Des humains que le schéma refuserait : leurs couples se forment après leur fécondité.
    const broken: GameData = {
      ...testData,
      species: {
        entries: [{ ...testHuman, couple: { ...testHuman.couple, minAge: 60 } }],
        indexOf: (id) => (id === testHuman.id ? 0 : undefined),
      },
    };
    const { env, host } = await startedHost('graine', broken);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const command of spawns(1)) host.receive({ type: 'game', command });
    try {
      env.advance(NORMAL_MONTH_MS * 3);
    } finally {
      quiet.mockRestore();
    }
    expect(env.messages('error').map((error) => error.code)).toEqual(['command']);
    expect(env.messages('error').at(0)?.detail).toContain('spawnGroup');
    // La partie continue, à sa cadence, sans groupe ni fait ; la commande n'est pas au journal.
    expect(env.messages('delta')).toHaveLength(3 * DAYS_PER_MONTH);
    expect(lastTime(env)).toEqual([3, 0]);
    for (const delta of env.messages('delta')) {
      expect(delta.frame?.groups ?? []).toHaveLength(0);
      expect(delta.chronicle).toEqual([]);
    }
    expect(await logOf(env, host, 1)).toMatchObject({ commandLog: [], pending: [] });
  });
});

describe('chronique (CHR-01)', () => {
  /** Faits reçus d'un hôte, de l'instantané aux deltas, dans l'ordre. */
  function received(env: FakeEnvironment): ChronicleView[] {
    return env.sent.flatMap(({ message }) =>
      message.type === 'snapshot' || message.type === 'delta' ? message.chronicle : [],
    );
  }
  const ranks = (facts: readonly ChronicleView[]) => facts.map((fact) => fact.index);
  const consecutive = (facts: readonly ChronicleView[]) =>
    ranks(facts).map((_, offset) => (facts[0]?.index ?? 0) + offset);

  it("livre chaque fait une fois, de l'instantané aux deltas, avant comme après un chargement (W-10)", async () => {
    const { env, host } = await startedHost();
    // Des groupes apparaissent de mois en mois : leurs faits arrivent dans plusieurs deltas.
    const commands = spawns(40, 2);
    for (let wave = 0; wave < 4; wave++) {
      for (const command of commands.slice(wave * 10, wave * 10 + 10)) {
        host.receive({ type: 'game', command });
      }
      env.advance(NORMAL_MONTH_MS * 3);
    }
    env.advance(NORMAL_MONTH_MS * 12);
    const facts = received(env);
    expect(facts.length).toBeGreaterThanOrEqual(40);
    expect(
      env.messages('delta').filter((delta) => delta.chronicle.length > 0).length,
    ).toBeGreaterThanOrEqual(4);
    expect(ranks(facts)).toEqual(consecutive(facts));
    expect(facts[0]?.index).toBe(0);
    // Rechargée, la partie redonne ses derniers faits, à l'identique, puis la suite.
    const saved = await saveOf(env, host, 1);
    const { env: other, host: loader } = greetedHost();
    loader.receive({ type: 'load', requestId: 2, data: saved.data });
    await until(() => other.messages('loaded').length > 0);
    expect(other.messages('snapshot').at(0)?.chronicle).toEqual(facts.slice(-CHRONICLE_RECENT));
    other.advance(NORMAL_MONTH_MS * 12);
    const after = received(other);
    expect(ranks(after)).toEqual(consecutive(after));
    expect(after.length).toBeGreaterThanOrEqual(facts.length);
  });

  it('donne les faits plus anciens par pages, et pas au-delà de ceux déjà envoyés (D-13)', async () => {
    const { env: before, host: waiting } = greetedHost();
    waiting.receive({ type: 'chronicle', requestId: 1, before: 10 });
    expect(before.messages('chroniclePage')).toEqual([
      { type: 'chroniclePage', requestId: 1, facts: [] },
    ]);

    const { env, host } = await startedHost();
    host.receive({ type: 'setPaused', paused: true });
    const total = CHRONICLE_RECENT + 30;
    for (const command of spawns(total, 2)) host.receive({ type: 'game', command });
    host.receive({ type: 'stepOnce' });
    const facts = received(env);
    expect(facts.length).toBeGreaterThanOrEqual(total);
    const saved = await saveOf(env, host, 2);
    const { env: other, host: loader } = greetedHost();
    loader.receive({ type: 'load', requestId: 3, data: saved.data });
    await until(() => other.messages('loaded').length > 0);
    // L'instantané n'a que les derniers faits ; le reste vient page après page.
    let kept = other.messages('snapshot').at(0)?.chronicle ?? [];
    expect(kept).toHaveLength(CHRONICLE_RECENT);
    for (let request = 10; (kept[0]?.index ?? 0) > 0; request++) {
      loader.receive({ type: 'chronicle', requestId: request, before: kept[0]?.index ?? 0 });
      const page = other.messages('chroniclePage').at(-1);
      expect(page?.requestId).toBe(request);
      expect(page?.facts.length).toBeLessThanOrEqual(CHRONICLE_PAGE);
      kept = [...(page?.facts ?? []), ...kept];
    }
    expect(kept).toEqual(facts);
    // Une demande au-delà du dernier fait envoyé s'arrête à lui : les suivants viendront
    // avec les deltas.
    loader.receive({ type: 'chronicle', requestId: 99, before: 1_000_000 });
    expect(other.messages('chroniclePage').at(-1)?.facts.at(-1)).toEqual(facts.at(-1));
  });
});

/** Attend qu'une condition se vérifie, le temps que les opérations asynchrones aboutissent. */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(condition()).toBe(true);
}

describe('sauvegarde', () => {
  it('envoie un fichier compressé, transféré, puis le recharge dans un autre hôte', async () => {
    const { env, host } = await startedHost();
    const cell = landCell();
    host.receive({ type: 'game', command: paint(cell) });
    env.advance(NORMAL_MONTH_MS * 2 + WAKE_SLACK_MS);
    host.receive({ type: 'save', requestId: 7 });
    await until(() => env.messages('saved').length > 0);
    const saved = env.messages('saved').at(0);
    expect(saved?.requestId).toBe(7);
    expect(saved?.meta).toEqual({ seed: 'graine', tick: 2 });
    const entry = env.sent.find((sent) => sent.message.type === 'saved');
    expect(entry?.transfer).toEqual([saved?.data]);

    const { env: other, host: loader } = greetedHost();
    loader.receive({ type: 'load', requestId: 8, data: saved?.data ?? new ArrayBuffer(0) });
    await until(() => other.messages('loaded').length > 0);
    expect(other.messages('loaded')).toEqual([{ type: 'loaded', requestId: 8 }]);
    const snapshot = other.messages('snapshot').at(0);
    expect(snapshot?.time.tick).toBe(2);
    expect(snapshot?.world.params).toEqual(testParams());
    expect(snapshot?.layers.biome[cell.y * 512 + cell.x]).toBe(testData.biomes.indexOf('desert'));
  });

  it('se relit, prise en pause juste après une commande appliquée aussitôt (U-7)', async () => {
    const spawn = spawns(1).at(0);
    if (spawn === undefined) throw new Error('aucune case');
    const pause = (host: SimulationHost) => {
      host.receive({ type: 'setPaused', paused: true });
    };
    const variants: [label: string, play: (host: SimulationHost) => void, groups: number][] = [
      [
        'apparition en pause',
        (host) => {
          pause(host);
          host.receive({ type: 'game', command: spawn });
        },
        1,
      ],
      [
        'coup de pinceau en pause',
        (host) => {
          pause(host);
          host.receive({ type: 'game', command: paint(landCell()) });
        },
        0,
      ],
      [
        // Reçue en marche, la commande attend le pas ; la mise en pause l'applique.
        'commande reçue en marche, puis pause',
        (host) => {
          host.receive({ type: 'game', command: spawn });
          pause(host);
        },
        1,
      ],
    ];
    const last = (environment: FakeEnvironment) => environment.messages('delta').at(-1);
    for (const [label, play, groups] of variants) {
      const { env, host } = await startedHost();
      env.advance(NORMAL_MONTH_MS * 2 + WAKE_SLACK_MS);
      play(host);
      // La commande est au journal, à l'instant même de la sauvegarde, et rien n'attend plus.
      const saved = await saveOf(env, host, 1);
      const json = (await readSave(new Uint8Array(saved.data), MIGRATIONS)).json as {
        readonly commandLog: readonly { readonly tick: number; readonly day: number }[];
        readonly pending: readonly unknown[];
      };
      const logged = json.commandLog.map((entry) => [entry.tick, entry.day]);
      expect(saved.meta.tick, label).toBe(2);
      expect(logged, label).toEqual([[2, 0]]);
      expect(json.pending, label).toEqual([]);
      // Un autre hôte la charge, puis les deux parties avancent de trois mois : même image
      // des groupes, même état.
      const { env: other, host: loader } = greetedHost();
      loader.receive({ type: 'setPaused', paused: true });
      loader.receive({ type: 'load', requestId: 2, data: saved.data });
      await until(() => other.messages('loaded').length + other.messages('loadFailed').length > 0);
      expect(other.messages('loadFailed'), label).toEqual([]);
      expect(other.messages('loaded'), label).toEqual([{ type: 'loaded', requestId: 2 }]);
      for (let day = 0; day < 3 * DAYS_PER_MONTH; day++) {
        host.receive({ type: 'stepOnce' });
        loader.receive({ type: 'stepOnce' });
      }
      expect(last(other)?.time.tick, label).toBe(5);
      expect(lastFrame(other)?.groups, label).toHaveLength(groups * GROUP_STRIDE);
      expect(lastFrame(other), label).toEqual(lastFrame(env));
      expect(await fingerprintOf(other, loader, 3), label).toBe(await fingerprintOf(env, host, 3));
    }
  });

  it("refuse un fichier qui n'est pas une sauvegarde, sans toucher à la partie", async () => {
    const { env, host } = await startedHost();
    host.receive({ type: 'load', requestId: 9, data: new TextEncoder().encode('bonjour').buffer });
    await until(() => env.messages('loadFailed').length > 0);
    expect(env.messages('loadFailed')).toEqual([
      { type: 'loadFailed', requestId: 9, reason: 'format' },
    ]);
    expect(env.messages('snapshot')).toHaveLength(1);
  });
});

/** État d'une partie, d'après sa sauvegarde relue : métadonnées, JSON et tableaux. */
async function savedState(env: FakeEnvironment, host: SimulationHost, requestId: number) {
  const saved = await saveOf(env, host, requestId);
  return readSave(new Uint8Array(saved.data), MIGRATIONS);
}

/** Empreinte de l'état d'une partie, d'après sa sauvegarde relue (ADR 0003). */
async function fingerprintOf(env: FakeEnvironment, host: SimulationHost, requestId: number) {
  return fingerprint(restoreState(await savedState(env, host, requestId), testData));
}

/** Sauvegarde la partie d'un hôte et renvoie le fichier. */
async function saveOf(env: FakeEnvironment, host: SimulationHost, requestId: number) {
  host.receive({ type: 'save', requestId });
  await until(() => env.messages('saved').some((saved) => saved.requestId === requestId));
  const saved = env.messages('saved').find((message) => message.requestId === requestId);
  if (saved === undefined) throw new Error('pas de sauvegarde');
  return saved;
}

/** Biome d'une case dans le dernier envoi qui la contient : instantané ou bloc modifié. */
function biomeSent(env: FakeEnvironment, x: number, y: number): number | undefined {
  const column = Math.floor(x / CHUNK_SIZE);
  const row = Math.floor(y / CHUNK_SIZE);
  let biome: number | undefined;
  for (const { message } of env.sent) {
    if (message.type === 'snapshot') biome = message.layers.biome[y * message.world.size.width + x];
    if (message.type === 'delta') {
      const patch = message.chunks.find((chunk) => chunk.column === column && chunk.row === row);
      if (patch !== undefined)
        biome = patch.biome[(y % CHUNK_SIZE) * CHUNK_SIZE + (x % CHUNK_SIZE)];
    }
  }
  return biome;
}

describe('commandes en attente', () => {
  it('sont sauvegardées, et appliquées après rechargement', async () => {
    // Hors pause, la commande attend le pas suivant, qui ne vient pas avant la sauvegarde.
    const { env, host } = await startedHost();
    const cell = landCell();
    host.receive({ type: 'game', command: paint(cell, 'taiga') });
    const saved = await saveOf(env, host, 1);
    expect(env.messages('delta')).toEqual([]);

    const { env: other, host: loader } = greetedHost();
    loader.receive({ type: 'setPaused', paused: true });
    loader.receive({ type: 'load', requestId: 2, data: saved.data });
    await until(() => other.messages('loaded').length > 0);
    expect(biomeSent(other, cell.x, cell.y)).not.toBe(testData.biomes.indexOf('taiga'));
    loader.receive({ type: 'stepOnce' });
    expect(biomeSent(other, cell.x, cell.y)).toBe(testData.biomes.indexOf('taiga'));
  });

  it('sont vérifiées à la réception', async () => {
    const { env, host } = await startedHost();
    host.receive({ type: 'setPaused', paused: true });
    const invalid: unknown[] = [
      { type: 'paintBiome', x: Number.NaN, y: 1, biome: 'desert' },
      { type: 'paintBiome', x: 1, y: Number.POSITIVE_INFINITY, biome: 'desert' },
      { type: 'paintBiome', x: 1.5, y: 1, biome: 'desert' },
      { type: 'paintBiome', x: 1, y: 1, biome: 'volcan' },
      { type: 'paintBiome', x: 1, y: 1, biome: 'Desert' },
      { type: 'paintBiome', x: 1, y: 1, biome: 'desert', extra: true },
      { type: 'feu' },
    ];
    for (const command of invalid) {
      host.receive({ type: 'game', command } as never);
    }
    expect(env.messages('error').map((error) => error.code)).toEqual(invalid.map(() => 'command'));
    // La partie reste sauvegardable et relisible.
    const saved = await saveOf(env, host, 3);
    const { env: other, host: loader } = greetedHost();
    loader.receive({ type: 'load', requestId: 4, data: saved.data });
    await until(() => other.messages('loaded').length > 0);
  });
});

describe('file des opérations', () => {
  it("garde la dernière partie demandée, quel que soit l'ordre de fin des chargements", async () => {
    const { env: envA, host: hostA } = await startedHost('A');
    const { env: envB, host: hostB } = await startedHost('B');
    envA.advance(NORMAL_MONTH_MS * 5);
    const big = await saveOf(envA, hostA, 1);
    const small = await saveOf(envB, hostB, 2);

    const { env, host } = greetedHost();
    host.receive({ type: 'load', requestId: 3, data: big.data });
    host.receive({ type: 'load', requestId: 4, data: small.data });
    await host.idle();
    expect(env.messages('loaded').map((loaded) => loaded.requestId)).toEqual([3, 4]);
    expect(env.messages('snapshot').map((snapshot) => snapshot.world.params.seed)).toEqual([
      'A',
      'B',
    ]);
  });

  it('ne laisse pas un chargement écraser la partie demandée ensuite', async () => {
    const { env: source, host: sourceHost } = await startedHost('ancienne');
    const saved = await saveOf(source, sourceHost, 1);
    const { env, host } = greetedHost();
    host.receive({ type: 'load', requestId: 2, data: saved.data });
    host.receive({ type: 'newGame', params: testParams('nouvelle') });
    await host.idle();
    expect(env.messages('snapshot').map((snapshot) => snapshot.world.params.seed)).toEqual([
      'ancienne',
      'nouvelle',
    ]);
  });

  it('sauvegarde la partie chargée, et non celle qui la précédait', async () => {
    const { env: source, host: sourceHost } = await startedHost('chargée');
    const saved = await saveOf(source, sourceHost, 1);
    const { env, host } = await startedHost('précédente');
    host.receive({ type: 'load', requestId: 2, data: saved.data });
    const again = await saveOf(env, host, 3);
    expect(again.meta.seed).toBe('chargée');
  });

  it("répond à une sauvegarde dont l'écriture échoue, avec son numéro de requête", async () => {
    const { env, host } = await startedHost();
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const original = globalThis.CompressionStream;
    // Un constructeur qui lève : la compression est indisponible.
    globalThis.CompressionStream = function () {
      throw new TypeError('CompressionStream indisponible');
    } as unknown as typeof CompressionStream;
    try {
      host.receive({ type: 'save', requestId: 42 });
      await host.idle();
    } finally {
      globalThis.CompressionStream = original;
      quiet.mockRestore();
    }
    expect(env.messages('saveFailed')).toEqual([
      { type: 'saveFailed', requestId: 42, reason: 'failed' },
    ]);
    expect(env.messages('error').map((error) => error.code)).toEqual(['internal']);
  });

  it('répond, avec sa raison et sans signaler de défaut, à une sauvegarde trop grande', async () => {
    const { env, host } = await startedHost();
    const original = globalThis.CompressionStream;
    // Un refus du format, comme un en-tête trop grand.
    globalThis.CompressionStream = function () {
      throw new SaveError('size', 'en-tête trop grand');
    } as unknown as typeof CompressionStream;
    try {
      host.receive({ type: 'save', requestId: 43 });
      await host.idle();
    } finally {
      globalThis.CompressionStream = original;
    }
    expect(env.messages('saveFailed')).toEqual([
      { type: 'saveFailed', requestId: 43, reason: 'size' },
    ]);
    expect(env.messages('error')).toEqual([]);
  });

  it('répond à une sauvegarde demandée avant toute partie', async () => {
    const { env, host } = greetedHost();
    host.receive({ type: 'save', requestId: 5 });
    await host.idle();
    expect(env.messages('saveFailed')).toEqual([
      { type: 'saveFailed', requestId: 5, reason: 'noGame' },
    ]);
  });
});

describe('cadence', () => {
  it('se réveille à l’échéance, jamais avant, avec des minuteries tronquées à la milliseconde', async () => {
    // Comme dans un navigateur : 111,11 ms deviendraient 111, avant l'échéance du jour.
    const env = new FakeEnvironment();
    env.browserTimers = true;
    const host = newHost(env);
    host.receive({ type: 'hello', protocol: PROTOCOL_VERSION });
    host.receive({ type: 'newGame', params: testParams() });
    await host.idle();
    env.advance(NORMAL_MONTH_MS + WAKE_SLACK_MS);
    const daily = env.messages('delta');
    // Chaque réveil fait son jour : aucun réveil à vide.
    expect(env.fired).toBe(daily.length);
    expect(daily.map((delta) => delta.days)).toEqual(daily.map(() => 1));
    expect(daily).toHaveLength(DAYS_PER_MONTH);
    // À ×16, depuis le début d'un mois : des lots de trois jours, le pas mensuel compris.
    host.receive({ type: 'setSpeed', speed: 'faster' });
    env.advance(daysDuration(4 * DAYS_PER_MONTH, 'faster'));
    const batches = env.messages('delta').slice(DAYS_PER_MONTH);
    expect(batches.length).toBeGreaterThanOrEqual(39);
    expect(batches.map((delta) => delta.days)).toEqual(batches.map(() => batchDays('faster')));
    expect(env.fired).toBe(DAYS_PER_MONTH + batches.length);
  });

  it('ne retarde pas le jour quand la vitesse ou la reprise ne changent rien', async () => {
    const { env, host } = await startedHost();
    for (let day = 0; day < 18; day++) {
      env.advance(NORMAL_DAY_MS * 0.9);
      host.receive({ type: 'setSpeed', speed: 'normal' });
      host.receive({ type: 'setPaused', paused: false });
    }
    // 18 × 0,9 jour de temps réel : 16 jours.
    expect(env.messages('delta')).toHaveLength(16);
  });

  it('garde le reste du jour à travers une pause', async () => {
    const { env, host } = await startedHost();
    env.advance(NORMAL_DAY_MS * 0.75);
    host.receive({ type: 'setPaused', paused: true });
    env.advance(NORMAL_DAY_MS * 10);
    host.receive({ type: 'setPaused', paused: false });
    env.advance(NORMAL_DAY_MS * 0.24);
    expect(env.messages('delta')).toEqual([]);
    env.advance(NORMAL_DAY_MS * 0.02);
    expect(env.messages('delta').map((delta) => [delta.time.tick, delta.time.day])).toEqual([
      [0, 1],
    ]);
  });

  it('change de vitesse au prorata du jour restant', async () => {
    const { env, host } = await startedHost();
    env.advance(NORMAL_DAY_MS / 2);
    host.receive({ type: 'setSpeed', speed: 'fast' });
    // Il restait un demi-jour en vitesse normale, soit un huitième de jour à ×4.
    env.advance(NORMAL_DAY_MS / 8 - 1);
    expect(env.messages('delta')).toEqual([]);
    env.advance(2);
    expect(env.messages('delta')).toHaveLength(1);
    // En pause, le changement de vitesse garde aussi l'avancée du jour.
    const { env: other, host: paused } = await startedHost();
    paused.receive({ type: 'setSpeed', speed: 'fast' });
    other.advance(daysDuration(0.5, 'fast'));
    paused.receive({ type: 'setPaused', paused: true });
    paused.receive({ type: 'setSpeed', speed: 'slow' });
    paused.receive({ type: 'setPaused', paused: false });
    other.advance(daysDuration(0.5, 'slow') - 1);
    expect(other.messages('delta')).toEqual([]);
    other.advance(2);
    expect(other.messages('delta')).toHaveLength(1);
  });

  it('ne garde, de ×16 à ×½, qu’un jour d’avance au plus : ni lot de rattrapage, ni lot de deux jours', async () => {
    // À ×16, l'horaire devance l'état de près de trois jours entre deux lots, et de sept et
    // demi après un pas mensuel de 52 ms : à ×½, chaque jour reste un lot d'un jour.
    for (const [label, cost] of [
      ['15 ms après un lot', 0],
      ['juste après un pas mensuel de 52 ms', 52],
    ] as const) {
      const { env, host } = await startedHost();
      host.receive({ type: 'setSpeed', speed: 'faster' });
      host.receive({ type: 'debugStepCost', milliseconds: cost });
      env.advancePerRead = 0.01;
      env.advance(500);
      // Jusqu'au lot suivant, ou à celui du prochain pas mensuel.
      for (let count = env.messages('delta').length; ;) {
        env.advance(1);
        const deltas = env.messages('delta');
        if (deltas.length > count && (cost === 0 || deltas.at(-1)?.frame !== undefined)) break;
        count = deltas.length;
      }
      if (cost === 0) env.advance(15);
      const switched = env.time;
      const already = env.messages('delta').length;
      host.receive({ type: 'setSpeed', speed: 'slow' });
      env.advance(5 * daysDuration(1, 'slow'));
      const after = env.timed('delta').slice(already, already + 4);
      expect(
        after.map(({ message }) => message.days),
        label,
      ).toEqual([1, 1, 1, 1]);
      expect((after[0]?.at ?? Number.POSITIVE_INFINITY) - switched, label).toBeLessThan(
        daysDuration(1, 'slow'),
      );
    }
  });
});

describe('deux horloges (ADR 0013)', () => {
  /**
   * Joue la partie jusqu'à l'instant `target` : à sa vitesse tant qu'il reste plus de huit
   * jours, un lot n'en faisant pas plus, puis en pause, jour par jour.
   */
  function reach(env: FakeEnvironment, host: SimulationHost, target: GameTime): void {
    const goal = dayIndex(target);
    host.receive({ type: 'setPaused', paused: false });
    while (lastInstant(env) < goal - MAX_BATCH_DAYS) env.advance(1);
    host.receive({ type: 'setPaused', paused: true });
    expect(lastInstant(env)).toBeLessThanOrEqual(goal);
    while (lastInstant(env) < goal) host.receive({ type: 'stepOnce' });
    expect(lastInstant(env)).toBe(goal);
  }

  it('donne le même état au même instant à ×½, ×1, ×4 et ×16, pauses et changements de vitesse compris', async () => {
    const commands = spawns(6, 20);
    const plan: [GameTime, GameCommand[]][] = [
      [{ tick: 0, day: 12 }, commands.slice(0, 3)],
      [{ tick: 1, day: 29 }, commands.slice(3, 5)],
      [{ tick: 2, day: 9 }, [paint(landCell()), ...commands.slice(5)]],
    ];
    const end: GameTime = { tick: 4, day: 3 };
    const prints: string[] = [];
    let log: unknown;
    for (const speed of SPEEDS) {
      const { env, host } = await startedHost();
      host.receive({ type: 'setSpeed', speed });
      const other = speed === 'faster' ? 'slow' : 'faster';
      for (const [instant, due] of plan) {
        // En cours de jour : une pause, une reprise, un détour par une autre vitesse.
        host.receive({ type: 'setPaused', paused: false });
        env.advance(daysDuration(0.4, speed));
        host.receive({ type: 'setPaused', paused: true });
        env.advance(500);
        host.receive({ type: 'setPaused', paused: false });
        host.receive({ type: 'setSpeed', speed: other });
        env.advance(daysDuration(0.3, other));
        host.receive({ type: 'setSpeed', speed });
        reach(env, host, instant);
        // En pause, les commandes s'appliquent à l'instant même.
        for (const command of due) host.receive({ type: 'game', command });
      }
      reach(env, host, end);
      const saved = await savedState(env, host, 1);
      expect([saved.meta.tick, (saved.json as { day: number }).day], speed).toEqual([4, 3]);
      log ??= (saved.json as { commandLog: unknown }).commandLog;
      expect((saved.json as { commandLog: unknown }).commandLog, speed).toEqual(log);
      prints.push(fingerprint(restoreState(saved, testData)));
    }
    expect(new Set(prints).size).toBe(1);
    // Le même journal, rejoué jour par jour, redonne cet état.
    const replayed = replay(testParams(), testWorld(), log as LoggedCommand[], end, testData);
    expect(fingerprint(replayed)).toBe(prints[0]);
  });

  it("garde ses calendriers après l'instantané : la pêche de l'hôte est celle du rejeu (ADR 0019)", async () => {
    // L'instantané transfère une copie des calendriers ; l'état garde les siens, que la pêche
    // lit à chaque pas mensuel. Quinze mois de soixante groupes, printemps du nord compris :
    // détachés, ils rendraient à la pêche la rampe de l'instant, et l'état s'écarterait du rejeu.
    const { env, host } = await startedHost();
    const sent = env.sent.find((entry) => entry.message.type === 'snapshot');
    if (sent?.original.type !== 'snapshot') throw new Error('pas d’instantané');
    expect(sent.original.calendars.byteLength).toBe(0);
    const commands = spawns(60, 20);
    host.receive({ type: 'setSpeed', speed: 'faster' });
    for (const command of commands) host.receive({ type: 'game', command });
    env.advance(monthDuration('faster') * 15 + WAKE_SLACK_MS);
    host.receive({ type: 'setPaused', paused: true });
    const saved = await savedState(env, host, 1);
    const json = saved.json as { day: number; commandLog: LoggedCommand[] };
    const until = { tick: saved.meta.tick, day: json.day };
    expect(until.tick).toBeGreaterThanOrEqual(15);
    const replayed = replay(testParams(), testWorld(), json.commandLog, until, testData);
    expect(fingerprint(restoreState(saved, testData))).toBe(fingerprint(replayed));
  });

  it('se rejoue au jour près, commandes reçues en marche et en pause comprises', async () => {
    const { env, host } = await startedHost();
    host.receive({ type: 'setSpeed', speed: 'fast' });
    const commands = spawns(8, 15);
    const cell = landCell();
    // En marche, des commandes reçues à toute heure, appliquées au début du jour suivant.
    for (const [rank, command] of commands.slice(0, 4).entries()) {
      env.advance(37 + rank * 211);
      host.receive({ type: 'game', command });
    }
    env.advance(300);
    host.receive({ type: 'game', command: paint(cell, 'steppe') });
    // En pause, d'autres, appliquées aussitôt ; puis un jour, et une reprise.
    host.receive({ type: 'setPaused', paused: true });
    for (const command of commands.slice(4, 6)) host.receive({ type: 'game', command });
    host.receive({ type: 'stepOnce' });
    host.receive({ type: 'game', command: commands[6] ?? paint(cell) });
    host.receive({ type: 'setPaused', paused: false });
    env.advance(1_234);
    host.receive({ type: 'game', command: commands[7] ?? paint(cell) });
    env.advance(daysDuration(17.5, 'fast'));
    host.receive({ type: 'setPaused', paused: true });
    const saved = await savedState(env, host, 1);
    const json = saved.json as { day: number; commandLog: LoggedCommand[] };
    const instants = json.commandLog.map((entry) => dayIndex(entry));
    expect(json.commandLog).toHaveLength(9);
    // Des commandes à plusieurs instants, et en cours de mois.
    expect(new Set(instants).size).toBeGreaterThan(4);
    expect(json.commandLog.some((entry) => entry.day !== 0)).toBe(true);
    const until = { tick: saved.meta.tick, day: json.day };
    const replayed = replay(testParams(), testWorld(), json.commandLog, until, testData);
    expect(fingerprint(replayed)).toBe(fingerprint(restoreState(saved, testData)));
  });

  it('n’envoie l’image des groupes, avec les positions, que quand elle change, et les étapes à chaque lot', async () => {
    const { env, host } = await startedHost();
    host.receive({ type: 'game', command: paint(landCell()) });
    for (const command of spawns(10, 25)) host.receive({ type: 'game', command });
    env.advance(NORMAL_DAY_MS * 5);
    host.receive({ type: 'game', command: paint(landCell(), 'steppe') });
    env.advance(NORMAL_MONTH_MS * 2 - NORMAL_DAY_MS * 5 + WAKE_SLACK_MS);
    const deltas = env.messages('delta');
    expect(deltas).toHaveLength(2 * DAYS_PER_MONTH);
    const framed = deltas.flatMap((delta, index) => (delta.frame === undefined ? [] : [index]));
    // Le premier jour, qui fait apparaître les groupes, puis les deux pas mensuels ; ni les
    // coups de pinceau ni les jours ordinaires.
    expect(framed).toEqual([0, DAYS_PER_MONTH - 1, 2 * DAYS_PER_MONTH - 1]);
    // Les étapes de chaque lot sont datées de ses jours.
    const legs = deltas.flatMap((delta) => (delta.legs === undefined ? [] : [delta]));
    expect(legs.length).toBeGreaterThan(DAYS_PER_MONTH / 2);
    for (const delta of legs) {
      const end = dayIndex(delta.time);
      for (const day of delta.legs?.days ?? []) {
        expect(day).toBeLessThan(end);
        expect(day).toBeGreaterThanOrEqual(end - delta.days);
      }
    }
    // L'image porte chaque membre, et l'étape en cours de chaque marcheur.
    const frame = deltas.at(-1)?.frame;
    if (frame === undefined) throw new Error('pas d’image');
    let members = 0;
    for (let at = 0; at < frame.groups.length; at += GROUP_STRIDE)
      members += frame.groups[at + 3] ?? 0;
    expect(frame.positions.length).toBe(2 * members);
    expect(frame.legs.slots.length).toBe(frame.legs.count.length);
    // Les tampons de l'image et des étapes voyagent sans copie.
    const entry = env.sent.findLast((sent) => sent.message.type === 'delta');
    expect(entry?.transfer.length).toBeGreaterThanOrEqual(12);
    // Les statistiques comptent les marcheurs et les étapes du lot.
    const stats = env.messages('stats');
    expect(stats.some((message) => message.stats.walkers > 0)).toBe(true);
    expect(stats.some((message) => message.stats.legs > 0)).toBe(true);
  });

  it('envoie l’image du gibier à l’instantané et au pas mensuel, et ses étapes datées, à leur allure, à chaque lot', async () => {
    const { env, host } = await startedHost();
    for (const command of spawns(10, 25)) host.receive({ type: 'game', command });
    env.advance(NORMAL_MONTH_MS * 2 + WAKE_SLACK_MS);
    const deltas = env.messages('delta');
    expect(deltas).toHaveLength(2 * DAYS_PER_MONTH);
    // L'image du gibier : aux seuls pas mensuels, ni à l'apparition des groupes ni les autres jours.
    const framed = deltas.flatMap((delta, index) => (delta.fauna === undefined ? [] : [index]));
    expect(framed).toEqual([DAYS_PER_MONTH - 1, 2 * DAYS_PER_MONTH - 1]);
    // Ses étapes, chaque lot, datées de ses jours, chacune avec son allure.
    const legged = deltas.filter((delta) => delta.faunaLegs !== undefined);
    expect(legged.length).toBeGreaterThan(DAYS_PER_MONTH);
    let runs = 0;
    for (const delta of legged) {
      const legs = delta.faunaLegs;
      if (legs === undefined) continue;
      expect(legs.gaits.length).toBe(legs.slots.length);
      const end = dayIndex(delta.time);
      for (let leg = 0; leg < legs.slots.length; leg++) {
        expect(legs.days[leg]).toBeLessThan(end);
        expect(legs.days[leg]).toBeGreaterThanOrEqual(end - delta.days);
        const gait = legs.gaits[leg] ?? 0;
        expect([FAUNA_GAIT.rest, FAUNA_GAIT.walk, FAUNA_GAIT.run]).toContain(gait);
        // Une étape d'arrêt, et elle seule, a l'allure du repos.
        expect(gait === FAUNA_GAIT.rest).toBe(legs.count[leg] === 0);
        if (gait === FAUNA_GAIT.run) runs++;
      }
    }
    expect(runs).toBeGreaterThan(0);
    // L'image porte chaque animal ; son étape en cours, avec l'allure de l'état.
    const frame = deltas.at(-1)?.fauna;
    if (frame === undefined) throw new Error('pas d’image du gibier');
    expect(frame.positions.length).toBe(2 * frame.ids.length);
    expect(frame.legs.slots.length).toBeLessThanOrEqual(frame.ids.length);
    expect([...frame.kinds].every((kind) => (kind & ~0x7f) === 0)).toBe(true);
    expect([...frame.kinds].some((kind) => (kind & FAUNA_RUN) === 0)).toBe(true);
    // Les tampons voyagent sans copie : ceux de l'image, et ceux des étapes de chaque lot,
    // allures comprises (relecture 2b.6, problème 15).
    const entry = env.sent.findLast((sent) => sent.message.type === 'delta');
    expect(entry?.transfer).toEqual(expect.arrayContaining(faunaBuffers(frame)));
    // Le message posté par l'hôte garde ses tableaux : transférés, ils sont détachés (un tableau
    // copié garderait sa longueur), et chacun de leurs tampons est dans la liste du transfert.
    let transferred = 0;
    for (const sent of env.sent) {
      const posted = sent.original;
      const received = sent.message;
      if (posted.type !== 'delta' || posted.faunaLegs === undefined) continue;
      if (received.type !== 'delta' || (received.faunaLegs?.slots.length ?? 0) === 0) continue;
      for (const buffer of faunaLegBuffers(posted.faunaLegs)) {
        expect(sent.transfer).toContain(buffer);
        expect(buffer.byteLength).toBe(0);
      }
      expect(posted.faunaLegs.gaits.buffer.byteLength).toBe(0);
      transferred++;
    }
    expect(transferred).toBeGreaterThan(DAYS_PER_MONTH);
    // Les statistiques comptent les animaux, leurs étapes et le jour du gibier.
    const stats = env.messages('stats');
    expect(stats.every((message) => message.stats.animals > 400)).toBe(true);
    expect(stats.some((message) => message.stats.faunaLegs > 0)).toBe(true);
    expect(stats.some((message) => (message.stats.faunaMs ?? -1) >= 0)).toBe(true);
  });

  it('reprend les tampons que le fil principal lui rend', async () => {
    const { env, host } = await startedHost();
    for (const command of spawns(6, 20)) host.receive({ type: 'game', command });
    // Un mois et trois jours : les groupes, apparus au repos, se mettent en route.
    env.advance(NORMAL_MONTH_MS + NORMAL_DAY_MS * 3 + WAKE_SLACK_MS);
    // Ceux que le fil principal a reçus, de l'image et des étapes de chaque delta.
    const returned = env
      .messages('delta')
      .flatMap((delta) => [
        ...(delta.frame === undefined ? [] : frameBuffers(delta.frame)),
        ...(delta.legs === undefined ? [] : legBuffers(delta.legs)),
        ...(delta.fauna === undefined ? [] : faunaBuffers(delta.fauna)),
        ...(delta.faunaLegs === undefined ? [] : faunaLegBuffers(delta.faunaLegs)),
      ])
      .filter((buffer) => buffer.byteLength > 0);
    expect(returned.length).toBeGreaterThan(5);
    const before = host.pool.reused;
    // Rendus, ils servent aux envois suivants : moins de tampons neufs.
    host.receive({ type: 'recycle', buffers: returned });
    expect(host.pool.size).toBeGreaterThan(0);
    env.advance(NORMAL_DAY_MS * 3);
    expect(host.pool.reused).toBeGreaterThan(before);
  });

  it('donne les mêmes positions à toutes les vitesses', async () => {
    const prints: string[] = [];
    for (const speed of ['slow', 'normal', 'fast', 'faster'] as const) {
      const { env, host } = await startedHost();
      host.receive({ type: 'setSpeed', speed });
      for (const command of spawns(6, 20)) host.receive({ type: 'game', command });
      // Une vingtaine de jours de jeu à chaque vitesse, mouvement et pas mensuel compris.
      env.advance(daysDuration(20, speed) + WAKE_SLACK_MS);
      host.receive({ type: 'setPaused', paused: true });
      const saved = await savedState(env, host, 1);
      const state = restoreState(saved, testData);
      expect(dayIndex(state)).toBeGreaterThan(15);
      // De là, jusqu'à un même instant : la vitesse n'a rien changé à l'état.
      while (dayIndex(state) < DAYS_PER_MONTH + 10) advanceDay(state, [], testData);
      prints.push(fingerprint(state));
    }
    expect(new Set(prints).size).toBe(1);
  });
});
