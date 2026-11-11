import { describe, expect, it, vi } from 'vitest';
import type { GameData } from '../core/data';
import {
  CHRONICLE_PAGE,
  CHRONICLE_RECENT,
  GROUP_STRIDE,
  PROTOCOL_VERSION,
  type ChronicleView,
  type GameCommand,
  type SpawnGroupCommand,
  type WorkerMessage,
} from '../core/protocol';
import { readSave, SaveError } from '../core/save/format';
import { monthDuration, NORMAL_MONTH_MS } from '../core/time';
import { CHUNK_SIZE, GENERATION_STAGES, LAYER_NAMES } from '../core/world';
import { MIGRATIONS } from '../sim/save';
import {
  firstCellOf,
  scatteredGroups,
  testData,
  testHuman,
  testParams,
  testState,
  testWorld,
} from '../sim/testing';
import { generateWorld } from '../worldgen/generate';
import { SimulationHost, type HostEnvironment, type WorldGenerator } from './host';

/**
 * Générateur des tests : le monde Petit de la graine, généré une fois pour toutes ; les
 * aperçus, plus petits, se génèrent vraiment.
 */
const generate: WorldGenerator = (params, onStage) => {
  for (const stage of GENERATION_STAGES) onStage(stage);
  if (params.size.width === 512) return testWorld(params.seed);
  return generateWorld(params, testData);
};

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

/** Imitation du worker : horloge, minuteries et messages sous contrôle du test. */
class FakeEnvironment implements HostEnvironment {
  time = 0;
  /** Avance de l'horloge à chaque lecture : une attente active finit donc par aboutir. */
  advancePerRead = 0;
  /** Durée de l'envoi d'un delta, comme la copie d'une grosse image : l'horloge avance d'autant. */
  deltaCost = 0;
  readonly sent: { message: WorkerMessage; transfer: Transferable[] }[] = [];
  private readonly timers = new Map<number, { at: number; callback: () => void }>();
  private nextHandle = 1;

  /**
   * Comme un vrai worker, un message posté est cloné et ses tampons transférés : ceux
   * de l'hôte sont détachés, et une couche envoyée sans copie le trahirait.
   */
  post(message: WorkerMessage, transfer: Transferable[]): void {
    this.sent.push({ message: structuredClone(message, { transfer }), transfer });
    if (message.type === 'delta') this.time += this.deltaCost;
  }

  now(): number {
    const time = this.time;
    this.time += this.advancePerRead;
    return time;
  }

  setTimer(callback: () => void, delay: number): number {
    const handle = this.nextHandle++;
    this.timers.set(handle, { at: this.time + delay, callback });
    return handle;
  }

  clearTimer(handle: number): void {
    this.timers.delete(handle);
  }

  /** Fait passer `milliseconds`, en déclenchant dans l'ordre les minuteries échues. */
  advance(milliseconds: number): void {
    const end = this.time + milliseconds;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort(([, a], [, b]) => a.at - b.at)
        .at(0);
      if (due === undefined) break;
      const [handle, timer] = due;
      this.timers.delete(handle);
      this.time = Math.max(this.time, timer.at);
      timer.callback();
    }
    this.time = Math.max(this.time, end);
  }

  /** Messages envoyés d'un type donné. */
  messages<T extends WorkerMessage['type']>(type: T): Extract<WorkerMessage, { type: T }>[] {
    return this.sent
      .map((entry) => entry.message)
      .filter((message): message is Extract<WorkerMessage, { type: T }> => message.type === type);
  }
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
    const entry = env.sent.find((sent) => sent.message.type === 'snapshot');
    // Les couches du monde, plus les deux tableaux de l'image des groupes.
    expect(entry?.transfer).toHaveLength(LAYER_NAMES.length + 2);
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

  it("avance d'un pas par mois, et n'envoie que les blocs modifiés", async () => {
    const { env, host } = await startedHost();
    const cell = landCell();
    host.receive({ type: 'game', command: paint(cell) });
    env.advance(NORMAL_MONTH_MS);
    const delta = env.messages('delta').at(0);
    expect(delta?.time.tick).toBe(1);
    expect(delta?.chunks).toHaveLength(1);
    const patch = delta?.chunks.at(0);
    expect(patch?.column).toBe(Math.floor(cell.x / CHUNK_SIZE));
    expect(patch?.row).toBe(Math.floor(cell.y / CHUNK_SIZE));
    expect(patch?.biome[(cell.y % CHUNK_SIZE) * CHUNK_SIZE + (cell.x % CHUNK_SIZE)]).toBe(
      testData.biomes.indexOf('desert'),
    );
    env.advance(NORMAL_MONTH_MS);
    expect(env.messages('delta').at(1)?.chunks).toEqual([]);
  });

  it('fait durer une année environ 10 s', async () => {
    const { env } = await startedHost();
    env.advance(10_000);
    expect(env.messages('delta').at(-1)?.time.tick).toBe(12);
  });

  it('mesure la durée des pas, coût factice compris', async () => {
    const { env, host } = await startedHost();
    host.receive({ type: 'debugStepCost', milliseconds: 200 });
    env.advancePerRead = 1;
    env.advance(NORMAL_MONTH_MS);
    const stats = env.messages('stats').at(0)?.stats;
    expect(stats?.stepMs).toBeGreaterThanOrEqual(200);
    expect(stats?.stepMs).toBeLessThan(210);
  });

  it("compte dans la durée du pas son delta, jusqu'à son envoi (W-11)", async () => {
    const { env } = await startedHost();
    env.deltaCost = 40;
    env.advance(NORMAL_MONTH_MS);
    expect(env.messages('stats').at(0)?.stats.stepMs).toBeGreaterThanOrEqual(40);
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
    expect(env.messages('time').at(-1)?.time).toEqual({ tick: 0, paused: true, speed: 'normal' });
    env.advance(5_000);
    expect(env.messages('delta')).toEqual([]);
    host.receive({ type: 'setPaused', paused: false });
    env.advance(NORMAL_MONTH_MS);
    expect(env.messages('delta').map((delta) => delta.time.tick)).toEqual([1]);
  });

  it('avance plus vite en vitesse rapide', async () => {
    const { env, host } = await startedHost();
    host.receive({ type: 'setSpeed', speed: 'fast' });
    env.advance(10_000 / 4);
    expect(env.messages('delta').at(-1)?.time).toEqual({ tick: 12, paused: false, speed: 'fast' });
  });

  it("n'avance que d'un pas à la demande, et seulement en pause", async () => {
    const { env, host } = await startedHost();
    host.receive({ type: 'stepOnce' });
    expect(env.messages('delta')).toEqual([]);
    host.receive({ type: 'setPaused', paused: true });
    host.receive({ type: 'stepOnce' });
    expect(env.messages('delta').map((delta) => delta.time.tick)).toEqual([1]);
  });

  it('ne rattrape pas son retard par rafales', async () => {
    const { env, host } = await startedHost();
    host.receive({ type: 'setSpeed', speed: 'faster' });
    host.receive({ type: 'debugStepCost', milliseconds: 200 });
    env.advancePerRead = 1;
    env.advance(2_000);
    // Un pas de 200 ms tous les 52 ms demandés : la simulation va aussi vite qu'elle peut.
    const steps = env.messages('delta').length;
    expect(monthDuration('faster')).toBeLessThan(200);
    expect(steps).toBeGreaterThanOrEqual(8);
    expect(steps).toBeLessThanOrEqual(11);
  });
});

describe('commandes de jeu', () => {
  it("s'appliquent au début du pas suivant", async () => {
    const { env, host } = await startedHost();
    env.advance(NORMAL_MONTH_MS * 3);
    host.receive({ type: 'game', command: paint(landCell(), 'desert') });
    expect(env.messages('delta').at(-1)?.chunks).toEqual([]);
    env.advance(NORMAL_MONTH_MS);
    expect(env.messages('delta').at(-1)?.time.tick).toBe(4);
    expect(env.messages('delta').at(-1)?.chunks).toHaveLength(1);
  });

  it("s'appliquent dès leur réception en pause, comme au début du pas suivant (U-7)", async () => {
    const commands = spawns(2);
    // En pause : chaque groupe apparaît aussitôt, dans un delta sans pas, au même mois.
    const { env, host } = await startedHost();
    host.receive({ type: 'setPaused', paused: true });
    for (const [rank, command] of commands.entries()) {
      host.receive({ type: 'game', command });
      const delta = env.messages('delta').at(-1);
      expect(env.messages('delta')).toHaveLength(rank + 1);
      expect(delta?.time).toEqual({ tick: 0, paused: true, speed: 'normal' });
      expect(delta?.frame.groups).toHaveLength((rank + 1) * GROUP_STRIDE);
      expect(delta?.chronicle.map((fact) => fact.kind)).toEqual(['groupAppeared']);
    }
    expect(env.messages('stats')).toEqual([]);
    // Hors pause, les mêmes commandes attendent le premier pas.
    const { env: running, host: other } = await startedHost();
    for (const command of commands) other.receive({ type: 'game', command });
    expect(running.messages('delta')).toEqual([]);
    // Trois mois plus tard, les deux parties n'en font qu'une : mêmes groupes, même état,
    // même journal, où les commandes datent du premier pas.
    for (let month = 0; month < 3; month++) host.receive({ type: 'stepOnce' });
    running.advance(NORMAL_MONTH_MS * 3);
    const last = (environment: FakeEnvironment) => environment.messages('delta').at(-1);
    expect(last(env)?.time.tick).toBe(3);
    expect(last(running)?.time.tick).toBe(3);
    expect(last(env)?.frame).toEqual(last(running)?.frame);
    const paused = await savedState(env, host, 1);
    expect(paused).toEqual(await savedState(running, other, 1));
    expect((paused.json as { commandLog: unknown }).commandLog).toEqual(
      commands.map((command) => ({ tick: 0, command })),
    );
  });

  it("s'appliquent à la mise en pause si elles attendaient encore leur pas (U-7)", async () => {
    const { env, host } = await startedHost();
    for (const command of spawns(1)) host.receive({ type: 'game', command });
    expect(env.messages('delta')).toEqual([]);
    host.receive({ type: 'setPaused', paused: true });
    expect(env.messages('delta').at(-1)?.time.tick).toBe(0);
    expect(env.messages('delta').at(-1)?.frame.groups).toHaveLength(GROUP_STRIDE);
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
    const id = env.messages('delta').at(-1)?.frame.groups[0] ?? 0;
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
    // Rien n'attend ni n'entre au journal : le pas suivant ne fait apparaître personne.
    host.receive({ type: 'stepOnce' });
    expect(env.messages('delta').at(-1)?.frame.groups).toHaveLength(0);
    expect(env.messages('delta').at(-1)?.chronicle).toEqual([]);
    expect(await logOf(env, host, 1)).toMatchObject({ commandLog: [], pending: [] });
    // La même apparition, sur sa case de terre : en pause, le groupe apparaît aussitôt (U-7).
    host.receive({ type: 'game', command: valid });
    expect(env.messages('delta').at(-1)?.frame.groups).toHaveLength(GROUP_STRIDE);
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
    expect(env.messages('delta').map((delta) => delta.time.tick)).toEqual([1, 2, 3]);
    for (const delta of env.messages('delta')) {
      expect(delta.frame.groups).toHaveLength(0);
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
    env.advance(NORMAL_MONTH_MS * 2);
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
  it('ne retarde pas le pas quand la vitesse ou la reprise ne changent rien', async () => {
    const { env, host } = await startedHost();
    for (let month = 0; month < 18; month++) {
      env.advance(NORMAL_MONTH_MS * 0.9);
      host.receive({ type: 'setSpeed', speed: 'normal' });
      host.receive({ type: 'setPaused', paused: false });
    }
    // 18 × 0,9 mois de temps réel : 16 pas.
    expect(env.messages('delta')).toHaveLength(16);
  });

  it("garde l'avancée du mois à travers une pause", async () => {
    const { env, host } = await startedHost();
    env.advance(NORMAL_MONTH_MS * 0.75);
    host.receive({ type: 'setPaused', paused: true });
    env.advance(NORMAL_MONTH_MS * 10);
    host.receive({ type: 'setPaused', paused: false });
    env.advance(NORMAL_MONTH_MS * 0.3);
    expect(env.messages('delta').map((delta) => delta.time.tick)).toEqual([1]);
  });

  it('change de vitesse au prorata du mois restant', async () => {
    const { env, host } = await startedHost();
    env.advance(NORMAL_MONTH_MS / 2);
    host.receive({ type: 'setSpeed', speed: 'fast' });
    // Il restait un demi-mois en vitesse normale, soit un huitième de mois à ×4.
    env.advance(NORMAL_MONTH_MS / 8 - 1);
    expect(env.messages('delta')).toEqual([]);
    env.advance(2);
    expect(env.messages('delta')).toHaveLength(1);
  });
});
