import { describe, expect, it } from 'vitest';
import { encodeSave, readSave, writeSave, type SaveData } from '../core/save/format';
import { RandomStream, streamSeed } from '../core/rng';
import { GENERATOR_VERSION } from '../worldgen/generate';
import { expressed, pureAncestry, randomGenome } from './genetics';
import { FEMALE, GENOME_WORDS, MALE, NONE, Population, type NewPerson } from './population';
import { familyName, givenName } from '../gen/names';
import { personName, phonologyOf } from './records';
import { cultureOf, languageOf } from './society';
import { MIGRATIONS, restoreState, saveState } from './save';
import type { SimState } from './state';
import { fingerprint } from './step';
import { testData, testState } from './testing';

const random = new RandomStream(streamSeed('population', 'tests'));
const plains = testData.species.entries.at(0)?.subspecies.at(1);

function person(overrides: Partial<NewPerson> = {}): NewPerson {
  const genome = new Uint32Array(GENOME_WORDS);
  if (plains !== undefined) randomGenome(testData.genetics, plains, random, genome);
  return {
    sex: FEMALE,
    birth: -240,
    species: 0,
    ancestry: pureAncestry(1),
    genome,
    mother: NONE,
    father: NONE,
    group: NONE,
    culture: 1,
    givenName: 1,
    familyName: 1,
    familyLanguage: 1,
    ...overrides,
  };
}

/** Une partie avec un groupe, une culture, une langue et quelques individus, dont un mort. */
function populated(): SimState {
  const state = testState();
  state.society.languages.push({ id: 1, seed: 1234 });
  state.society.cultures.push({ id: 1, language: 1, naming: 'father', founded: 0 });
  state.society.groups.set(1, {
    id: 1,
    culture: 1,
    founded: 0,
    parent: NONE,
    leader: 1,
    x: 10,
    y: 20,
    homeX: 10,
    homeY: 20,
    targetX: -1,
    targetY: -1,
    food: 3,
  });
  state.society.nextGroupId = 2;
  state.society.chronicle.push({
    tick: 0,
    kind: 'groupAppeared',
    x: 10,
    y: 20,
    group: 1,
    other: NONE,
    leader: 1,
    otherLeader: NONE,
    count: 4,
  });
  const people = state.people;
  const mother = people.add(person({ group: 1 }));
  const father = people.add(person({ sex: MALE, group: 1 }));
  people.set('partner', mother, people.get('id', father));
  people.set('partner', father, people.get('id', mother));
  people.add(person({ group: 1, mother: 1, father: 2, birth: -12 }));
  people.add(person({ sex: MALE, group: 1, mother: 1, father: 2, birth: -2 }));
  people.remove(people.slotOf(4) ?? -1, 0, 'disease');
  return state;
}

const save = (state: SimState) => saveState(state, GENERATOR_VERSION, testData);

/** La sauvegarde, avec un tableau remplacé. */
function withArray(data: SaveData, name: string, array: SaveData['arrays'][string]): SaveData {
  return { ...data, arrays: { ...data.arrays, [name]: array } };
}

describe('population (tâche 2.1)', () => {
  it('range les vivants en colonnes, et retrouve chacun par son identifiant', () => {
    const people = new Population(4);
    const a = people.add(person());
    const b = people.add(person({ sex: MALE }));
    expect(people.count).toBe(2);
    expect(people.get('id', a)).toBe(1);
    expect(people.get('id', b)).toBe(2);
    expect(people.slotOf(2)).toBe(b);
    expect(people.slotOf(NONE)).toBeUndefined();
    expect(people.slotOf(99)).toBeUndefined();
  });

  it('archive les morts, veuve leur conjoint, et ne redonne jamais un identifiant', () => {
    const people = new Population(4);
    const a = people.add(person());
    const b = people.add(person({ sex: MALE }));
    people.set('partner', a, 2);
    people.set('partner', b, 1);
    people.remove(b, 30, 'accident');
    expect(people.count).toBe(1);
    expect(people.slotOf(2)).toBeUndefined();
    const row = people.archivedRow(2);
    expect(row).toBe(0);
    expect(people.archive.columns.death[0]).toBe(30);
    expect(people.archive.columns.partner[0]).toBe(1);
    expect(people.get('partner', a)).toBe(NONE);
    // L'emplacement libéré resert ; l'identifiant, jamais.
    const c = people.add(person());
    expect(c).toBe(b);
    expect(people.get('id', c)).toBe(3);
    expect(people.archivedRow(2)).toBe(0);
  });

  it('grandit sans rien perdre, bien au-delà de sa capacité de départ', () => {
    const people = new Population(2);
    for (let index = 0; index < 1000; index++) people.add(person({ birth: index }));
    for (let id = 1; id <= 1000; id++) {
      expect(people.get('birth', people.slotOf(id) ?? -1)).toBe(id - 1);
    }
    let visited = 0;
    people.forEach(() => visited++);
    expect(visited).toBe(1000);
  });

  it('se sauvegarde et se relit à l’identique, emplacements libres compris', async () => {
    const state = populated();
    const restored = restoreState(
      await readSave(await writeSave(save(state)), MIGRATIONS),
      testData,
    );
    expect(fingerprint(restored)).toBe(fingerprint(state));
    expect(restored.people.archivedRow(4)).toBe(0);
    expect(restored.society.groups.get(1)?.food).toBe(3);
    // Le prochain né prend le même emplacement et le même identifiant des deux côtés.
    const original = state.people.add(person());
    const reloaded = restored.people.add(person());
    expect(reloaded).toBe(original);
    expect(restored.people.get('id', reloaded)).toBe(state.people.get('id', original));
  });

  it('relit une sauvegarde de la phase 1 avec une population vide', async () => {
    const state = testState();
    const data = save(state);
    // Une sauvegarde de la version 3 n'avait ni population ni société.
    const json = { ...(data.json as Record<string, unknown>) };
    delete json.people;
    const arrays = Object.fromEntries(
      Object.entries(data.arrays).filter(([name]) => !/^(people|archive)/.test(name)),
    );
    const old = encodeSave({ meta: data.meta, json, arrays }, 3);
    const restored = restoreState(await readSave(old, MIGRATIONS), testData);
    expect(restored.people.count).toBe(0);
    expect(restored.society.groups.size).toBe(0);
    expect(fingerprint(restored)).toBe(fingerprint(state));
  });

  it('relit une sauvegarde de la version 4 sans changer les noms affichés', async () => {
    const state = populated();
    const { people, society } = state;
    // Une deuxième langue, et une culture sans nom de famille.
    society.languages.push({ id: 2, seed: 4321 });
    society.cultures.push({ id: 2, language: 2, naming: 'none', founded: 0 });
    // Un enfant de la culture 1 dont le nom de famille est né dans la langue 2, et un
    // fondateur de la culture 2 au code de nom de famille que rien ne montrait.
    const child = people.add(person({ group: 1, familyName: 9, familyLanguage: 2, birth: -5 }));
    const founder = people.add(person({ group: 1, culture: 2, familyName: 8, familyLanguage: 2 }));
    people.remove(people.slotOf(2) ?? -1, 0, 'accident');
    const data = save(state);
    // La version 4 n'avait pas la langue des noms de famille : chacun s'écrivait dans celle
    // de sa culture, sauf dans une culture sans nom de famille.
    const arrays = Object.fromEntries(
      Object.entries(data.arrays).filter(([name]) => !name.endsWith('FamilyLanguage')),
    );
    const shown = (sex: number, given: number, code: number, id: number) => {
      const culture = cultureOf(society, id);
      const words = phonologyOf(languageOf(society, culture?.language ?? 0)?.seed ?? 0);
      const first = givenName(words, sex, given);
      return culture?.naming === 'none' || code === 0
        ? first
        : `${first} ${familyName(words, code)}`;
    };
    const old = encodeSave({ meta: data.meta, json: data.json, arrays }, 4);
    const restored = restoreState(await readSave(old, MIGRATIONS), testData);
    const name = (id: number) => personName(restored.people, restored.society, id);
    expect(name(people.get('id', child))).toBe(shown(FEMALE, 1, 9, 1));
    expect(name(people.get('id', founder))).toBe(shown(FEMALE, 1, 8, 2));
    expect(name(2)).toBe(shown(MALE, 1, 1, 1));
    expect(name(1)).toBe(shown(FEMALE, 1, 1, 1));
    // Chacun reçoit la langue de sa culture ; le code caché s'efface.
    const living = restored.people.slotOf(people.get('id', child)) ?? -1;
    expect(restored.people.get('familyLanguage', living)).toBe(1);
    const hidden = restored.people.slotOf(people.get('id', founder)) ?? -1;
    expect(restored.people.get('familyName', hidden)).toBe(0);
    expect(restored.people.archive.columns.familyLanguage[0]).toBe(1);
    // Et la partie relue se sauvegarde et se relit à l'identique.
    const again = restoreState(
      await readSave(await writeSave(save(restored)), MIGRATIONS),
      testData,
    );
    expect(fingerprint(again)).toBe(fingerprint(restored));
  });

  it('refuse une population forgée : index, emplacements, groupes, espèces', () => {
    const data = save(populated());
    const corrupt = (forged: SaveData) => () => restoreState(forged, testData);
    const where = (data.arrays.peopleWhere as Int32Array).slice();
    where[2] = 0;
    expect(corrupt(withArray(data, 'peopleWhere', where))).toThrow(/index/);
    expect(corrupt(withArray(data, 'peopleFree', Int32Array.from([0])))).toThrow(/libres/);
    const groups = (data.arrays.peopleGroup as Uint32Array).slice();
    groups[0] = 77;
    expect(corrupt(withArray(data, 'peopleGroup', groups))).toThrow(/incohérent/);
    const json = data.json as { people: Record<string, unknown> };
    const unknownSpecies = {
      ...data,
      json: { ...json, people: { ...json.people, species: ['elf'] } },
    };
    expect(corrupt(unknownSpecies)).toThrow(/espèce inconnue/);
    expect(corrupt(withArray(data, 'peopleSex', new Uint8Array(1)))).toThrow(/mauvaise taille/);
    // Un nom de famille dans une langue qui n'existe pas.
    const languages = (data.arrays.peopleFamilyLanguage as Uint16Array).slice();
    languages[0] = 7;
    expect(corrupt(withArray(data, 'peopleFamilyLanguage', languages))).toThrow(/incohérent/);
    const archived = (data.arrays.archiveFamilyLanguage as Uint16Array).slice();
    archived[0] = 7;
    expect(corrupt(withArray(data, 'archiveFamilyLanguage', archived))).toThrow(/incohérent/);
  });

  it('réécrit les génomes quand data/genetics.json change l’ordre de ses allèles', () => {
    const state = populated();
    const eyes = testData.genetics.loci.findIndex((locus) => locus.id === 'eyes');
    const slot = state.people.slotOf(1) ?? 0;
    const before =
      testData.genetics.loci[eyes]?.alleles[
        expressed(testData.genetics, state.people.columns.genome, slot * GENOME_WORDS, eyes)
      ]?.id;
    const data = save(state);
    // Le même contenu, dont les allèles des yeux sont rangés à l'envers.
    const genetics = {
      ...testData.genetics,
      loci: testData.genetics.loci.map((locus, index) =>
        index === eyes ? { ...locus, alleles: [...locus.alleles].reverse() } : locus,
      ),
    };
    const restored = restoreState(data, { ...testData, genetics });
    const after =
      genetics.loci[eyes]?.alleles[
        expressed(genetics, restored.people.columns.genome, slot * GENOME_WORDS, eyes)
      ]?.id;
    expect(after).toBe(before);
  });
});
