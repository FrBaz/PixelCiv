import { describe, expect, it } from 'vitest';
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

function startedHost() {
  const env = new FakeEnvironment();
  const host = new SimulationHost(env);
  host.receive({ type: 'hello', protocol: PROTOCOL_VERSION });
  host.receive({ type: 'newGame', seed: 'graine', size: 'small' });
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
    const env = new FakeEnvironment();
    new SimulationHost(env).receive({
      type: 'game',
      command: { type: 'paint', x: 0, y: 0, value: 1 },
    });
    expect(env.messages('error').at(0)?.code).toBe('noGame');
  });
});

describe('partie', () => {
  it('envoie un instantané complet, avec ses tampons transférés', () => {
    const { env } = startedHost();
    const snapshot = env.messages('snapshot').at(0);
    expect(snapshot?.world).toEqual({ seed: 'graine', size: { width: 512, height: 256 } });
    expect(snapshot?.chunks).toHaveLength(32);
    const entry = env.sent.find((sent) => sent.message.type === 'snapshot');
    expect(entry?.transfer).toHaveLength(32);
    expect(entry?.transfer.every((buffer) => buffer instanceof ArrayBuffer)).toBe(true);
    expect(snapshot?.chunks.at(0)?.cells.byteLength).toBe(CHUNK_SIZE * CHUNK_SIZE);
  });

  it("avance d'un pas par mois, et envoie les blocs modifiés", () => {
    const { env, host } = startedHost();
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

  it('fait durer une année environ 10 s', () => {
    const { env } = startedHost();
    env.advance(10_000);
    expect(env.messages('delta').at(-1)?.time.tick).toBe(12);
  });

  it('mesure la durée des pas, coût factice compris', () => {
    const { env, host } = startedHost();
    host.receive({ type: 'debugStepCost', milliseconds: 200 });
    env.advancePerRead = 1;
    env.advance(NORMAL_MONTH_MS);
    const stats = env.messages('stats').at(0)?.stats;
    expect(stats?.stepMs).toBeGreaterThanOrEqual(200);
    expect(stats?.stepMs).toBeLessThan(210);
  });
});

describe('temps', () => {
  it('se met en pause, puis reprend', () => {
    const { env, host } = startedHost();
    host.receive({ type: 'setPaused', paused: true });
    expect(env.messages('time').at(-1)?.time).toEqual({ tick: 0, paused: true, speed: 'normal' });
    env.advance(5_000);
    expect(env.messages('delta')).toEqual([]);
    host.receive({ type: 'setPaused', paused: false });
    env.advance(NORMAL_MONTH_MS);
    expect(env.messages('delta').map((delta) => delta.time.tick)).toEqual([1]);
  });

  it('avance plus vite en vitesse rapide', () => {
    const { env, host } = startedHost();
    host.receive({ type: 'setSpeed', speed: 'fast' });
    env.advance(10_000 / 4);
    expect(env.messages('delta').at(-1)?.time).toEqual({ tick: 12, paused: false, speed: 'fast' });
  });

  it("n'avance que d'un pas à la demande, et seulement en pause", () => {
    const { env, host } = startedHost();
    host.receive({ type: 'stepOnce' });
    expect(env.messages('delta')).toEqual([]);
    host.receive({ type: 'setPaused', paused: true });
    host.receive({ type: 'stepOnce' });
    expect(env.messages('delta').map((delta) => delta.time.tick)).toEqual([1]);
  });

  it('ne rattrape pas son retard par rafales', () => {
    const { env, host } = startedHost();
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
  it("s'appliquent au début du pas suivant", () => {
    const { env, host } = startedHost();
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
    const { env, host } = startedHost();
    host.receive({ type: 'game', command: { type: 'paint', x: 3, y: 4, value: 9 } });
    env.advance(NORMAL_MONTH_MS * 2);
    host.receive({ type: 'save', requestId: 7 });
    await until(() => env.messages('saved').length > 0);
    const saved = env.messages('saved').at(0);
    expect(saved?.requestId).toBe(7);
    expect(saved?.meta).toEqual({ seed: 'graine', tick: 2 });
    const entry = env.sent.find((sent) => sent.message.type === 'saved');
    expect(entry?.transfer).toEqual([saved?.data]);

    const other = new FakeEnvironment();
    const loader = new SimulationHost(other);
    loader.receive({ type: 'load', requestId: 8, data: saved?.data ?? new ArrayBuffer(0) });
    await until(() => other.messages('loaded').length > 0);
    expect(other.messages('loaded')).toEqual([{ type: 'loaded', requestId: 8 }]);
    const snapshot = other.messages('snapshot').at(0);
    expect(snapshot?.time.tick).toBe(2);
    expect(snapshot?.chunks.at(0)?.cells[4 * CHUNK_SIZE + 3]).toBe(9);
  });

  it("refuse un fichier qui n'est pas une sauvegarde, sans toucher à la partie", async () => {
    const { env, host } = startedHost();
    host.receive({ type: 'load', requestId: 9, data: new TextEncoder().encode('bonjour').buffer });
    await until(() => env.messages('loadFailed').length > 0);
    expect(env.messages('loadFailed')).toEqual([
      { type: 'loadFailed', requestId: 9, reason: 'format' },
    ]);
    expect(env.messages('snapshot')).toHaveLength(1);
  });
});
