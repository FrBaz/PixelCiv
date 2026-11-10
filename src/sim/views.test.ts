import { describe, expect, it } from 'vitest';
import { GROUP_STRIDE } from '../core/protocol';
import { AGE_CLASSES, decodeVisual } from '../core/visual';
import { groupMembers } from './groups';
import { NONE } from './population';
import { spawnGroup } from './spawn';
import type { SimState } from './state';
import { firstCellOf, testData, testState } from './testing';
import {
  chronicleView,
  groupName,
  groupNear,
  groupsFrame,
  groupView,
  inspect,
  personView,
} from './views';

/** Fait apparaître un groupe sur une case tempérée, sans faire passer de mois. */
function spawned(state: SimState, count = 20) {
  const cell = firstCellOf(state, (family) => family === 'temperate');
  spawnGroup(
    state,
    { type: 'spawnGroup', ...cell, species: 'human', subspecies: 'plains', count },
    testData,
  );
  const group = [...state.society.groups.values()].at(-1);
  if (group === undefined) throw new Error('aucun groupe');
  return group;
}

/** Un membre du groupe qui a des parents connus dans le groupe. */
function childOf(state: SimState, group: number): number {
  const members = groupMembers(state.people).get(group) ?? [];
  const slot = members.find((member) => state.people.get('mother', member) !== NONE);
  if (slot === undefined) throw new Error('aucun enfant');
  return slot;
}

describe('fiches (tâche 2.10 ; IHM-02)', () => {
  it("donne la fiche d'un vivant : nom, parents, fratrie, groupe, hérédité", () => {
    const state = testState();
    const group = spawned(state);
    const slot = childOf(state, group.id);
    const id = state.people.get('id', slot);
    const view = personView(state, testData, id);
    expect(view).toBeDefined();
    if (view === undefined) return;
    expect(view).toMatchObject({ id, alive: true, species: 'human', culture: group.culture });
    expect(view.name.split(' ').length).toBeGreaterThanOrEqual(2);
    expect(view.mother?.id).toBe(state.people.get('mother', slot));
    expect(view.group).toMatchObject({ id: group.id, size: 20 });
    expect(view.mother?.alive).toBe(true);
    // Sa mère le compte parmi ses enfants, et ses frères et sœurs le comptent dans la fratrie.
    const mother = personView(state, testData, view.mother?.id ?? NONE);
    expect(mother?.children.map((child) => child.id)).toContain(id);
    for (const sibling of view.siblings) {
      const other = personView(state, testData, sibling.id);
      expect(other?.siblings.map((entry) => entry.id)).toContain(id);
    }
    // Un allèle exprimé par locus, une valeur par trait, entre 0 et 1.
    expect(view.loci).toHaveLength(testData.genetics.loci.length);
    for (const locus of view.loci) expect(locus.allele).not.toBe('');
    for (const entry of view.traits) {
      expect(entry.value).toBeGreaterThanOrEqual(0);
      expect(entry.value).toBeLessThanOrEqual(1);
    }
    expect(view.ancestry).toEqual([{ subspecies: 'plains', share: 1 }]);
    const [short, tall] = testData.species.entries[0]?.height ?? [0, 0];
    expect(view.height).toBeGreaterThanOrEqual(short);
    expect(view.height).toBeLessThanOrEqual(tall);
  });

  it("donne la fiche d'un mort, sans groupe, avec la date et la cause de sa mort", () => {
    const state = testState();
    const group = spawned(state);
    const slot = childOf(state, group.id);
    const id = state.people.get('id', slot);
    const name = personView(state, testData, id)?.name;
    state.tick = 24;
    state.people.remove(slot, state.tick, 'accident');
    const view = personView(state, testData, id);
    expect(view).toMatchObject({ id, alive: false, death: 24, cause: 'accident', name });
    expect(view?.group).toBeUndefined();
    expect(view?.pregnant).toBe(false);
    // Un inconnu n'a pas de fiche.
    expect(personView(state, testData, 999_999)).toBeUndefined();
  });

  it("donne la fiche d'un groupe : membres, réserves, culture, et son nom d'après son meneur", () => {
    const state = testState();
    const group = spawned(state, 12);
    const view = groupView(state, group.id);
    expect(view).toMatchObject({ id: group.id, x: group.x, y: group.y, size: 12 });
    expect(view?.members).toHaveLength(12);
    expect(view?.members.map((member) => member.id)).toContain(group.leader);
    expect(view?.name).toBe(groupName(state, group.leader));
    expect(view?.name).not.toBe('');
    expect(view?.parent).toBeUndefined();
    expect(view?.reserve).toBeGreaterThanOrEqual(0);
    expect(groupView(state, 999)).toBeUndefined();
  });

  it('trouve le groupe le plus proche du lieu touché, à travers la couture est-ouest', () => {
    const state = testState();
    const group = spawned(state);
    expect(groupNear(state, group.x, group.y)).toBe(group.id);
    expect(groupNear(state, group.x, (group.y + 20) % state.size.height)).toBeUndefined();
    // Un groupe sur la première colonne se trouve depuis la dernière.
    group.x = 0;
    expect(groupNear(state, state.size.width - 1, group.y)).toBe(group.id);
    expect(inspect(state, testData, { kind: 'place', x: 1, y: group.y }).group?.id).toBe(group.id);
    expect(inspect(state, testData, { kind: 'group', id: group.id }).group?.id).toBe(group.id);
    expect(inspect(state, testData, { kind: 'person', id: group.leader }).person?.id).toBe(
      group.leader,
    );
    expect(inspect(state, testData, { kind: 'person', id: 999_999 })).toEqual({});
  });

  it('nomme les groupes des faits de la chronique d’après leurs meneurs', () => {
    const state = testState();
    const group = spawned(state);
    const entry = state.society.chronicle.at(-1);
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const view = chronicleView(state, entry);
    expect(view).toMatchObject({
      kind: 'groupAppeared',
      groupId: group.id,
      group: groupName(state, group.leader),
      other: '',
      x: group.x,
      y: group.y,
    });
  });
});

describe('image des groupes pour la carte (tâche 2.9 ; REN-04)', () => {
  it('donne chaque groupe et un code d’apparence par membre, sans en oublier', () => {
    const state = testState();
    const first = spawned(state, 20);
    const second = spawned(state, 9);
    const frame = groupsFrame(state, testData);
    expect(frame.groups).toHaveLength(2 * GROUP_STRIDE);
    expect([...frame.groups.subarray(0, GROUP_STRIDE)]).toEqual([
      first.id,
      first.x,
      first.y,
      20,
      first.culture,
    ]);
    expect(frame.groups[GROUP_STRIDE + 3]).toBe(9);
    expect(frame.sprites).toHaveLength(29);
    // Les codes suivent l'ordre des membres : sexe et classe d'âge de chacun.
    const members = groupMembers(state.people).get(first.id) ?? [];
    members.forEach((slot, index) => {
      const visual = decodeVisual(frame.sprites[index] ?? 0);
      expect(visual.sex).toBe(state.people.get('sex', slot));
      const years = state.people.age(slot, state.tick) / 12;
      const expected = years < 3 ? 'baby' : years < 15 ? 'child' : years < 55 ? 'adult' : 'elder';
      expect(AGE_CLASSES[visual.age]).toBe(expected);
    });
    // Même état, même image.
    const again = groupsFrame(state, testData);
    expect([...again.sprites]).toEqual([...frame.sprites]);
    expect(second.culture).toBe(2);
  });
});
