import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type GameCommand, type WorkerMessage } from '../core/protocol';
import { SaveError } from '../core/save/format';
import { monthDuration, NORMAL_MONTH_MS } from '../core/time';
import { CHUNK_SIZE, GENERATION_STAGES, LAYER_NAMES } from '../core/world';
import { firstCellOf, testData, testParams, testState, testWorld } from '../sim/testing';
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

function newHost(env: HostEnvironment): SimulationHost {
  return new SimulationHost(env, testData, generate);
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
  readonly sent: { message: WorkerMessage; transfer: Transferable[] }[] = [];
  private readonly timers = new Map<number, { at: number; callback: () => void }>();
  private nextHandle = 1;

  /**
   * Comme un vrai worker, un message posté est cloné et ses tampons transférés : ceux
   * de l'hôte sont détachés, et une couche envoyée sans copie le trahirait.
   */
  post(message: WorkerMessage, transfer: Transferable[]): void {
    this.sent.push({ message: structuredClone(message, { transfer }), transfer });
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

function greetedHost() {
  const env = new FakeEnvironment();
  const host = newHost(env);
  host.receive({ type: 'hello', protocol: PROTOCOL_VERSION });
  return { env, host };
}

async function startedHost(seed = 'graine') {
  const { env, host } = greetedHost();
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
    expect(entry?.transfer).toHaveLength(LAYER_NAMES.length);
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
    const { env, host } = await startedHost();
    host.receive({ type: 'setPaused', paused: true });
    const cell = landCell();
    host.receive({ type: 'game', command: paint(cell, 'taiga') });
    const saved = await saveOf(env, host, 1);

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

  it('répond sans signaler de défaut à une sauvegarde que le format refuse', async () => {
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
      { type: 'saveFailed', requestId: 43, reason: 'failed' },
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
