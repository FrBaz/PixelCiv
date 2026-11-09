import { describe, expect, it } from 'vitest';
import { loadGameData } from '../core/data';
import type { WorkerMessage } from '../core/protocol';
import { defaultWorldParams, type WorldParams } from '../core/worldParams';
import { PreviewScheduler } from './preview';

const { worldgen } = loadGameData();
const params = (seed: string): WorldParams =>
  defaultWorldParams(worldgen.parameters, seed, 'small');

type PreviewReady = Extract<WorkerMessage, { type: 'previewReady' }>;

function setup() {
  const sent: { requestId: number; seed: string }[] = [];
  const shown: { requestId: number; seed: string }[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const scheduler = new PreviewScheduler(
    (requestId, value) => sent.push({ requestId, seed: value.seed }),
    (preview, value) => shown.push({ requestId: preview.requestId, seed: value.seed }),
    {
      setTimer: (callback) => {
        timers.set(nextTimer, callback);
        return nextTimer++;
      },
      clearTimer: (handle) => {
        timers.delete(handle);
      },
    },
  );
  const reply = (requestId: number): PreviewReady => ({
    type: 'previewReady',
    requestId,
    size: { width: 2, height: 1 },
    biome: new Uint8Array(2),
    elevation: new Int16Array(2),
  });
  return { scheduler, sent, shown, timers, reply };
}

describe("demandes d'aperçu", () => {
  it("n'envoie qu'une demande à la fois, puis la dernière restée en attente", () => {
    const { scheduler, sent, shown, reply } = setup();
    scheduler.request(params('a'));
    scheduler.request(params('b'));
    scheduler.request(params('c'));
    expect(sent).toEqual([{ requestId: 1, seed: 'a' }]);
    scheduler.ready(reply(1));
    expect(shown).toEqual([{ requestId: 1, seed: 'a' }]);
    // « b » a été dépassée par « c » pendant le calcul de « a ».
    expect(sent).toEqual([
      { requestId: 1, seed: 'a' },
      { requestId: 2, seed: 'c' },
    ]);
    scheduler.ready(reply(2));
    expect(shown.map((preview) => preview.seed)).toEqual(['a', 'c']);
    scheduler.request(params('d'));
    expect(sent.at(-1)).toEqual({ requestId: 3, seed: 'd' });
  });

  it('ignore les réponses périmées ou inattendues', () => {
    const { scheduler, shown, reply } = setup();
    scheduler.ready(reply(1));
    scheduler.request(params('a'));
    scheduler.ready(reply(7));
    expect(shown).toEqual([]);
    scheduler.ready(reply(1));
    scheduler.ready(reply(1));
    expect(shown).toEqual([{ requestId: 1, seed: 'a' }]);
  });

  it('passe à la demande suivante après une erreur ou un délai sans réponse', () => {
    const { scheduler, sent, timers } = setup();
    scheduler.request(params('a'));
    scheduler.request(params('b'));
    scheduler.failed();
    expect(sent.map((request) => request.seed)).toEqual(['a', 'b']);
    // Le délai de la demande « b » expire : la suivante part aussitôt.
    scheduler.request(params('c'));
    expect(timers.size).toBe(1);
    for (const callback of [...timers.values()]) callback();
    expect(sent.map((request) => request.seed)).toEqual(['a', 'b', 'c']);
  });

  it("oublie la demande en attente quand l'écran se ferme", () => {
    const { scheduler, sent, reply } = setup();
    scheduler.request(params('a'));
    scheduler.request(params('b'));
    scheduler.cancel();
    scheduler.ready(reply(1));
    expect(sent.map((request) => request.seed)).toEqual(['a']);
  });
});
