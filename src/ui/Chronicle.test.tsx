import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChronicleView } from '../core/protocol';
import { ChroniclePanel } from './Chronicle';
import { chronicle, chronicleNewFacts, chronicleOpen, type UiActions } from './store';
import { buttons, expand, findAll, fire, textOf } from './testing';

/** Faits de rangs `from` (compris) à `to` (exclu), d'une apparition chacun. */
function facts(from: number, to: number): ChronicleView[] {
  return Array.from({ length: to - from }, (_, offset) => ({
    index: from + offset,
    tick: from + offset,
    kind: 'groupAppeared',
    groupId: from + offset + 1,
    x: 0,
    y: 0,
    group: 'Ilel',
    other: '',
    count: 30,
  }));
}

function fakeActions() {
  return {
    focus: vi.fn(),
    inspectGroup: vi.fn(),
    olderChronicle: vi.fn(),
    latestChronicle: vi.fn(),
  };
}

const panel = (actions: ReturnType<typeof fakeActions>) =>
  expand(ChroniclePanel({ actions: actions as unknown as UiActions }));

afterEach(() => {
  chronicleOpen.value = false;
  chronicle.value = [];
  chronicleNewFacts.value = 0;
});

describe('chronique (CHR-01)', () => {
  it('dit en tête de la liste figée combien de faits sont arrivés, et ramène aux derniers', () => {
    chronicleOpen.value = true;
    // La liste figée sur une page plus ancienne : les faits 100 à 399.
    chronicle.value = facts(100, 400);
    const actions = fakeActions();
    expect(textOf(panel(actions))).not.toContain('nouveau');
    chronicleNewFacts.value = 12;
    const items = findAll(panel(actions), (element) => element.type === 'li');
    // En tête, avant le plus récent des faits affichés.
    expect(textOf(items[0])).toBe('12 faits nouveaux');
    expect(textOf(items[1])).toContain('Le groupe');
    fire(buttons(items[0]).at(0), 'onClick');
    expect(actions.latestChronicle).toHaveBeenCalledOnce();
    chronicleNewFacts.value = 1;
    expect(buttons(panel(actions)).map(textOf)).toContain('1 fait nouveau');
  });
});
