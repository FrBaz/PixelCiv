import { describe, expect, it } from 'vitest';
import { CHRONICLE_PAGE, CHRONICLE_RECENT, type ChronicleView } from '../core/protocol';
import {
  freezeFacts,
  snapshotFacts,
  latestFacts,
  newFacts,
  olderThan,
  receiveFacts,
  receivePage,
  type KeptFacts,
} from './chronicle';

/** Faits de rangs `from` (compris) à `to` (exclu). */
function facts(from: number, to: number): ChronicleView[] {
  return Array.from({ length: Math.max(0, to - from) }, (_, offset) => ({
    index: from + offset,
    tick: from + offset,
    kind: 'famine',
    groupId: 1,
    x: 0,
    y: 0,
    group: 'Ilel',
    other: '',
    count: from + offset,
  }));
}

const ranks = (list: readonly ChronicleView[]) => list.map((fact) => fact.index);

/** La page que le worker envoie pour une demande : les CHRONICLE_PAGE faits avant `before`. */
function page(before: number): ChronicleView[] {
  return facts(Math.max(0, before - CHRONICLE_PAGE), before);
}

/** Un appui sur « Faits plus anciens », et la page qui y répond. */
function older(kept: KeptFacts): KeptFacts {
  const before = olderThan(kept);
  if (before === undefined) throw new Error('aucun fait plus ancien');
  return receivePage(freezeFacts(kept), page(before));
}

describe('faits gardés de la chronique (D-13, U-9)', () => {
  it('prolonge les faits récents, et ne garde que les derniers', () => {
    const start = snapshotFacts(facts(0, CHRONICLE_RECENT));
    const after = receiveFacts(start, facts(CHRONICLE_RECENT, CHRONICLE_RECENT + 3));
    expect(after.shown).toHaveLength(CHRONICLE_RECENT);
    expect(after.shown).toBe(after.recent);
    expect(ranks(after.shown).at(0)).toBe(3);
    expect(ranks(after.shown).at(-1)).toBe(CHRONICLE_RECENT + 2);
    expect(newFacts(after)).toBe(0);
    // Chaque fait garde son rang : la même clé désigne toujours le même fait.
    for (const fact of after.shown) expect(fact).toEqual(facts(fact.index, fact.index + 1)[0]);
    // Un fait déjà reçu ne se compte pas deux fois.
    expect(receiveFacts(after, facts(CHRONICLE_RECENT + 1, CHRONICLE_RECENT + 3))).toBe(after);
    // Un instantané trop long n'apporte que les derniers.
    expect(ranks(snapshotFacts(facts(0, 400)).shown)).toEqual(ranks(facts(100, 400)));
  });

  it('remonte la chronique par pages, jusqu’au premier fait', () => {
    let kept = snapshotFacts(facts(250, 550));
    while (olderThan(kept) !== undefined) kept = older(kept);
    expect(ranks(kept.shown)).toEqual(ranks(facts(0, 550)));
    expect(kept.recent).toHaveLength(CHRONICLE_RECENT);
    // Une page déjà reçue ne change rien.
    expect(receivePage(kept, facts(0, 100))).toBe(kept);
    expect(olderThan(snapshotFacts([]))).toBeUndefined();
  });

  it('fige la liste affichée pendant la lecture des pages, et la borne', () => {
    // L'instantané d'une chronique de 1 000 faits, puis une page plus ancienne.
    let kept = older(snapshotFacts(facts(1000 - CHRONICLE_RECENT, 1000)));
    const shown = kept.shown;
    expect(shown).toHaveLength(CHRONICLE_RECENT + CHRONICLE_PAGE);
    // 10 000 deltas d'un fait, chronique ouverte : la liste affichée ne change pas, seuls
    // les faits récents avancent, et les faits nouveaux se comptent.
    for (let index = 1000; index < 11_000; index++) {
      kept = receiveFacts(kept, facts(index, index + 1));
    }
    expect(kept.shown).toBe(shown);
    expect(ranks(kept.shown)).toEqual(ranks(facts(1000 - CHRONICLE_RECENT - CHRONICLE_PAGE, 1000)));
    expect(kept.recent).toHaveLength(CHRONICLE_RECENT);
    expect(newFacts(kept)).toBe(10_000);
    // « 10 000 faits nouveaux » : retour aux derniers, sans trou ni doublon.
    const latest = latestFacts(kept);
    expect(ranks(latest.shown)).toEqual(ranks(facts(11_000 - CHRONICLE_RECENT, 11_000)));
    expect(newFacts(latest)).toBe(0);
    // Les faits suivants s'affichent de nouveau.
    const next = receiveFacts(latest, facts(11_000, 11_002));
    expect(ranks(next.shown).at(-1)).toBe(11_001);
    expect(next.shown).toHaveLength(CHRONICLE_RECENT);
  });

  it('borne la liste par les pages demandées : 100 de plus par appui', () => {
    let kept = snapshotFacts(facts(2000, 2000 + CHRONICLE_RECENT));
    for (let pages = 1; pages <= 3; pages++) {
      kept = older(kept);
      for (let index = 0; index < 500; index++) {
        const next = (kept.recent.at(-1)?.index ?? 0) + 1;
        kept = receiveFacts(kept, facts(next, next + 1));
      }
      expect(kept.shown).toHaveLength(CHRONICLE_RECENT + pages * CHRONICLE_PAGE);
    }
    expect(newFacts(kept)).toBe(1500);
  });

  it('oublie une page qui ne rejoint plus les faits affichés, plutôt que de laisser un trou', () => {
    // La page des faits 200 à 299 a été demandée ; entre-temps, la chronique refermée est
    // revenue aux derniers faits, qui commencent au 301.
    const frozen = freezeFacts(snapshotFacts(facts(300, 600)));
    const back = freezeFacts(latestFacts(receiveFacts(frozen, facts(600, 601))));
    expect(ranks(back.shown).at(0)).toBe(301);
    expect(receivePage(back, facts(200, 300))).toBe(back);
    // Revenue aux derniers faits, la liste n'accepte plus la page demandée avant.
    const latest = latestFacts(frozen);
    expect(receivePage(latest, facts(200, 300))).toBe(latest);
    const empty = freezeFacts(snapshotFacts([]));
    expect(receivePage(empty, facts(0, 100))).toBe(empty);
  });
});
