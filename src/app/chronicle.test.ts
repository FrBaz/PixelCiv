import { describe, expect, it } from 'vitest';
import { CHRONICLE_RECENT, type ChronicleView } from '../core/protocol';
import { appendFacts, olderThan, prependPage } from './chronicle';

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

describe('faits gardés de la chronique (D-13, U-9)', () => {
  it('prolonge les faits récents, et ne garde que les derniers', () => {
    const recent = facts(0, CHRONICLE_RECENT);
    const after = appendFacts(recent, facts(CHRONICLE_RECENT, CHRONICLE_RECENT + 3), false);
    expect(after).toHaveLength(CHRONICLE_RECENT);
    expect(ranks(after).at(0)).toBe(3);
    expect(ranks(after).at(-1)).toBe(CHRONICLE_RECENT + 2);
    // Chaque fait garde son rang : la même clé désigne toujours le même fait.
    for (const fact of after) expect(fact).toEqual(facts(fact.index, fact.index + 1)[0]);
    // Un fait déjà reçu ne se compte pas deux fois.
    expect(appendFacts(after, facts(CHRONICLE_RECENT + 1, CHRONICLE_RECENT + 3), false)).toBe(
      after,
    );
  });

  it('remonte la chronique par pages, jusqu’au premier fait, et les garde', () => {
    let kept: readonly ChronicleView[] = facts(250, 550);
    for (let before = olderThan(kept); before !== undefined; before = olderThan(kept)) {
      kept = prependPage(kept, facts(Math.max(0, before - 100), before));
    }
    expect(ranks(kept)).toEqual(ranks(facts(0, 550)));
    // La chronique reste ouverte : les faits nouveaux s'ajoutent sans rien perdre.
    kept = appendFacts(kept, facts(550, 552), true);
    expect(ranks(kept)).toEqual(ranks(facts(0, 552)));
    // Refermée, elle revient aux derniers faits.
    expect(ranks(appendFacts(kept, facts(552, 553), false))).toEqual(ranks(facts(253, 553)));
    // Une page déjà reçue ne change rien.
    expect(prependPage(kept, facts(0, 100))).toBe(kept);
    expect(olderThan([])).toBeUndefined();
  });

  it('oublie une page qui ne rejoint plus les faits gardés, plutôt que de laisser un trou', () => {
    // La page des faits 200 à 299 a été demandée ; entre-temps, la chronique refermée est
    // revenue aux derniers faits, qui commencent au 301.
    const kept = facts(301, 601);
    expect(prependPage(kept, facts(200, 300))).toBe(kept);
    expect(prependPage([], facts(0, 100))).toEqual([]);
  });
});
