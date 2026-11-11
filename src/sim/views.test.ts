import { describe, expect, it } from 'vitest';
import { CHRONICLE_PAGE, GROUP_STRIDE } from '../core/protocol';
import { AGE_CLASSES, decodeVisual } from '../core/visual';
import { groupMembers } from './groups';
import { FEMALE, GENOME_WORDS, NONE } from './population';
import { spawnGroup } from './spawn';
import type { SimState } from './state';
import { step } from './step';
import { firstCellOf, scatteredGroups, testData, testState } from './testing';
import {
  chroniclePage,
  chronicleView,
  chronicleViews,
  groupName,
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

  it("répond à une demande de fiche, et ne donne rien pour une cible qui n'existe pas", () => {
    const state = testState();
    const group = spawned(state);
    expect(inspect(state, testData, { kind: 'group', id: group.id }).group?.id).toBe(group.id);
    expect(inspect(state, testData, { kind: 'person', id: group.leader }).person?.id).toBe(
      group.leader,
    );
    for (const id of [999_999, 0, -1, 1.5, Number.NaN]) {
      expect(inspect(state, testData, { kind: 'person', id })).toEqual({});
      expect(inspect(state, testData, { kind: 'group', id })).toEqual({});
    }
  });

  it('nomme les groupes des faits de la chronique d’après leurs meneurs', () => {
    const state = testState();
    const group = spawned(state);
    const entry = state.society.chronicle.at(-1);
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const view = chronicleView(state, entry, 0);
    expect(view).toMatchObject({
      index: 0,
      kind: 'groupAppeared',
      groupId: group.id,
      group: groupName(state, group.leader),
      other: '',
      x: group.x,
      y: group.y,
    });
  });
});

describe('chronique (tâche 2.10 ; CHR-01, D-13, U-9)', () => {
  /** Un état dont la chronique compte `count` faits, tous différents par leur effectif. */
  function chronicled(count: number): SimState {
    const state = testState();
    spawned(state);
    const first = state.society.chronicle.at(0);
    if (first === undefined) throw new Error('aucun fait');
    for (let index = 1; index < count; index++) {
      state.society.chronicle.push({ ...first, kind: 'famine', count: index });
    }
    return state;
  }

  it('numérote chaque fait de son rang, qui ne change pas', () => {
    const state = chronicled(10);
    expect(chronicleViews(state, 7, 10).map((view) => view.index)).toEqual([7, 8, 9]);
    expect(chronicleViews(state, -5, 2).map((view) => view.index)).toEqual([0, 1]);
    expect(chronicleViews(state, 8, 20).map((view) => view.count)).toEqual([8, 9]);
    expect(chronicleViews(state, 6, 4)).toEqual([]);
  });

  it('donne les faits plus anciens par pages, sans trou ni doublon jusqu’au premier', () => {
    const total = CHRONICLE_PAGE * 2 + 37;
    const state = chronicled(total);
    const seen: number[] = [];
    let before = total;
    for (let pages = 0; before > 0; pages++) {
      expect(pages).toBeLessThan(10);
      const page = chroniclePage(state, before);
      expect(page.length).toBeLessThanOrEqual(CHRONICLE_PAGE);
      expect(page.at(-1)?.index).toBe(before - 1);
      seen.unshift(...page.map((view) => view.index));
      before = page[0]?.index ?? 0;
    }
    expect(seen).toEqual(Array.from({ length: total }, (_, index) => index));
    // Avant le premier fait, ou pour un rang qui n'en est pas un : rien.
    for (const rank of [0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(chroniclePage(state, rank)).toEqual([]);
    }
    // Au-delà du dernier fait, la page finit avec lui.
    expect(chroniclePage(state, total + 50).at(-1)?.index).toBe(total - 1);
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

  it('est la même avec les membres que renvoie le pas, mois après mois (W-10)', () => {
    const state = testState();
    for (const command of scatteredGroups(state, 6, 30)) spawnGroup(state, command, testData);
    for (let month = 0; month < 120; month++) {
      const members = step(state, [], testData);
      const fromStep = groupsFrame(state, testData, members);
      const counted = groupsFrame(state, testData);
      expect([...fromStep.groups]).toEqual([...counted.groups]);
      expect([...fromStep.sprites]).toEqual([...counted.sprites]);
    }
    expect(state.society.groups.size).toBeGreaterThan(0);
  });

  it("recalcule l'apparence d'un emplacement qui resert à un autre individu (W-10)", () => {
    const state = testState();
    const group = spawned(state, 20);
    const members = groupMembers(state.people).get(group.id) ?? [];
    // Le cache retient le teint et les cheveux de chaque emplacement.
    const before = groupsFrame(state, testData);
    const slot = members.find((member) => state.people.get('mother', member) === NONE) ?? -1;
    const old = decodeVisual(before.sprites[members.indexOf(slot)] ?? 0);
    const dead = state.people.get('id', slot);
    state.people.remove(slot, state.tick, 'accident');
    // Une nouvelle venue, d'un autre génome, prend l'emplacement libéré.
    const genome = new Uint32Array(GENOME_WORDS).fill(0xffffffff);
    const reused = state.people.add({
      sex: FEMALE,
      birth: state.tick - 30 * 12,
      species: 0,
      ancestry: [255],
      genome,
      mother: NONE,
      father: NONE,
      group: group.id,
      culture: group.culture,
      givenName: 1,
      familyName: 0,
      familyLanguage: 1,
    });
    expect(reused).toBe(slot);
    expect(state.people.get('id', reused)).not.toBe(dead);
    const frame = groupsFrame(state, testData);
    // Son code d'apparence est celui que donnerait un cache tout neuf, et il diffère bien
    // de celui de la morte : un cache périmé se verrait.
    const order = groupMembers(state.people).get(group.id) ?? [];
    const position = order.indexOf(reused);
    const fresh = groupsFrame(withFreshLooks(state), testData);
    expect(frame.sprites[position]).toBe(fresh.sprites[position]);
    const now = decodeVisual(frame.sprites[position] ?? 0);
    expect([now.skin, now.hair]).not.toEqual([old.skin, old.hair]);
  });
});

/**
 * Le même état, vu par un autre objet de population, aux mêmes colonnes : le cache
 * d'apparence, rangé par objet de population, y repart de rien.
 */
function withFreshLooks(state: SimState): SimState {
  const people = Object.assign(
    Object.create(Object.getPrototypeOf(state.people) as object) as SimState['people'],
    state.people,
  );
  return { ...state, people };
}
