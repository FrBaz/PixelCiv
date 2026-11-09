import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type WorkerMessage } from '../core/protocol';
import { CHUNK_SIZE } from '../core/world';
import { monthDuration, NORMAL_MONTH_MS } from '../core/time';
import { SimulationHost, type HostEnvironment } from './host';

/** Imitation du worker : horloge, minuteries et messages sous contrôle du test. */
class FakeEnvironment implements HostEnvironment {
  time = 0;
  /** Avance de l'horloge à chaque lecture : une attente active finit donc par aboutir. */
  advancePerRead = 0;
  readonly sent: { message: WorkerMessage; transfer: Transferable[] }[] = [];
  private readonly timers = new Map<number, { at: number; callback: () => void }>();
  private nextHandle = 1;

  post(message: WorkerMessage, transfer: Transferable[]): void {
    this.sent.push({ message, transfer });
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
  const host = new SimulationHost(env);
  host.receive({ type: 'hello', protocol: PROTOCOL_VERSION });
  return { env, host };
}

async function startedHost(seed = 'graine') {
  const { env, host } = greetedHost();
  host.receive({ type: 'newGame', seed, size: 'small' });
  await host.idle();
  return { env, host };
}

describe('poignée de main', () => {
  it('répond prêt à la bonne version du protocole', () => {
    const env = new FakeEnvironment();
    new SimulationHost(env).receive({ type: 'hello', protocol: PROTOCOL_VERSION });
    expect(env.messages('ready')).toEqual([{ type: 'ready', protocol: PROTOCOL_VERSION }]);
  });

  it('refuse une autre version', () => {
    const env = new FakeEnvironment();
    new SimulationHost(env).receive({ type: 'hello', protocol: PROTOCOL_VERSION + 1 });
    expect(env.messages('ready')).toEqual([]);
    expect(env.messages('error').at(0)?.code).toBe('protocol');
  });

  it('refuse une commande de jeu avant la partie', () => {
    const { env, host } = greetedHost();
    host.receive({ type: 'game', command: { type: 'paint', x: 0, y: 0, value: 1 } });
    expect(env.messages('error').at(0)?.code).toBe('noGame');
  });

  it('ne traite rien sans poignée de main réussie', async () => {
    for (const hello of [[], [{ type: 'hello', protocol: PROTOCOL_VERSION + 1 }]] as const) {
      const env = new FakeEnvironment();
      const host = new SimulationHost(env);
      for (const message of hello) host.receive(message);
      host.receive({ type: 'newGame', seed: 'graine', size: 'small' });
      await host.idle();
      expect(env.messages('snapshot')).toEqual([]);
      expect(env.messages('error').map((error) => error.code)).toContain('protocol');
    }
  });
});

describe('partie', () => {
  it('envoie un instantané complet, avec ses tampons transférés', async () => {
    const { env } = await startedHost();
    const snapshot = env.messages('snapshot').at(0);
    expect(snapshot?.world).toEqual({ seed: 'graine', size: { width: 512, height: 256 } });
    expect(snapshot?.chunks).toHaveLength(32);
    const entry = env.sent.find((sent) => sent.message.type === 'snapshot');
    expect(entry?.transfer).toHaveLength(32);
    expect(entry?.transfer.every((buffer) => buffer instanceof ArrayBuffer)).toBe(true);
    expect(snapshot?.chunks.at(0)?.cells.byteLength).toBe(CHUNK_SIZE * CHUNK_SIZE);
  });

  it("avance d'un pas par mois, et envoie les blocs modifiés", async () => {
    const { env, host } = await startedHost();
    host.receive({ type: 'game', command: { type: 'paint', x: 70, y: 3, value: 9 } });
    env.advance(NORMAL_MONTH_MS);
    const delta = env.messages('delta').at(0);
    expect(delta?.time.tick).toBe(1);
    const painted = delta?.chunks.find((chunk) => chunk.column === 1 && chunk.row === 0);
    expect(painted?.cells[3 * CHUNK_SIZE + 6]).toBe(9);
    // Les promeneurs de test peignent chaque mois : leurs blocs suivent dans les deltas.
    env.advance(NORMAL_MONTH_MS);
    expect(env.messages('delta').at(1)?.chunks.length).toBeGreaterThan(0);
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
    host.receive({ type: 'game', command: { type: 'paint', x: 1, y: 7, value: 9 } });
    const paintedIn = (index: number) =>
      env
        .messages('delta')
        .at(index)
        ?.chunks.find((chunk) => chunk.column === 0 && chunk.row === 0)?.cells[7 * CHUNK_SIZE + 1];
    expect(paintedIn(-1)).not.toBe(9);
    env.advance(NORMAL_MONTH_MS);
    expect(env.messages('delta').at(-1)?.time.tick).toBe(4);
    expect(paintedIn(-1)).toBe(9);
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
    host.receive({ type: 'game', command: { type: 'paint', x: 3, y: 4, value: 9 } });
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
    expect(snapshot?.chunks.at(0)?.cells[4 * CHUNK_SIZE + 3]).toBe(9);
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

/** Valeur d'une case dans le dernier envoi qui contient son bloc. */
function cellSent(env: FakeEnvironment, x: number, y: number): number | undefined {
  const column = Math.floor(x / CHUNK_SIZE);
  const row = Math.floor(y / CHUNK_SIZE);
  const sent = env.sent
    .map((entry) => entry.message)
    .flatMap((message) =>
      message.type === 'snapshot' || message.type === 'delta' ? message.chunks : [],
    )
    .filter((chunk) => chunk.column === column && chunk.row === row)
    .at(-1);
  return sent?.cells[(y % CHUNK_SIZE) * CHUNK_SIZE + (x % CHUNK_SIZE)];
}

describe('commandes en attente', () => {
  it('sont sauvegardées, et appliquées après rechargement', async () => {
    const { env, host } = await startedHost();
    host.receive({ type: 'setPaused', paused: true });
    host.receive({ type: 'game', command: { type: 'paint', x: 10, y: 10, value: 9 } });
    const saved = await saveOf(env, host, 1);

    const { env: other, host: loader } = greetedHost();
    loader.receive({ type: 'setPaused', paused: true });
    loader.receive({ type: 'load', requestId: 2, data: saved.data });
    await until(() => other.messages('loaded').length > 0);
    loader.receive({ type: 'stepOnce' });
    expect(cellSent(other, 10, 10)).toBe(9);
  });

  it('sont vérifiées à la réception', async () => {
    const { env, host } = await startedHost();
    host.receive({ type: 'setPaused', paused: true });
    const invalid: unknown[] = [
      { type: 'paint', x: Number.NaN, y: 1, value: 9 },
      { type: 'paint', x: 1, y: Number.POSITIVE_INFINITY, value: 9 },
      { type: 'paint', x: 1.5, y: 1, value: 9 },
      { type: 'paint', x: 1, y: 1, value: 300 },
      { type: 'paint', x: 1, y: 1, value: 9, extra: true },
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
    expect(env.messages('snapshot').map((snapshot) => snapshot.world.seed)).toEqual(['A', 'B']);
  });

  it('ne laisse pas un chargement écraser la partie demandée ensuite', async () => {
    const { env: source, host: sourceHost } = await startedHost('ancienne');
    const saved = await saveOf(source, sourceHost, 1);
    const { env, host } = greetedHost();
    host.receive({ type: 'load', requestId: 2, data: saved.data });
    host.receive({ type: 'newGame', seed: 'nouvelle', size: 'small' });
    await host.idle();
    expect(env.messages('snapshot').map((snapshot) => snapshot.world.seed)).toEqual([
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
