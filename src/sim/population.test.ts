import { describe, expect, it } from 'vitest';
import type { Genetics, Species } from '../core/data';
import { loadCatalog } from '../core/data/catalog';
import { SpeciesListSchema } from '../core/data/people';
import { encodeSave, readSave, writeSave, type SaveData } from '../core/save/format';
import { RandomStream, streamSeed } from '../core/rng';
import { GENERATOR_VERSION } from '../worldgen/generate';
import { alleles, expressed, pureAncestry, randomGenome, trait } from './genetics';
import { adaptationOf } from './people';
import {
  DEATH_CAUSES,
  FEMALE,
  GENOME_WORDS,
  MALE,
  NONE,
  Population,
  type NewPerson,
} from './population';
import { MAX_GROUPS, MAX_IDS, MAX_SLOTS } from './populationSave';
import { familyName, givenName } from '../gen/names';
import { field, heredity, personName, phonologyOf, recordOf } from './records';
import { CHRONICLE_KINDS, cultureOf, languageOf, type ChronicleEntry } from './society';
import { MIGRATIONS, restoreState, saveState } from './save';
import type { SimState } from './state';
import { fingerprint, step } from './step';
import { flatState, testData, testHuman, testState, withHuman } from './testing';
import { personView } from './views';

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

/**
 * La sauvegarde telle que la version 4 l'écrivait : sans la langue des noms de famille,
 * sans l'ordre des sous-espèces, et la chronique en JSON, dans l'en-tête.
 */
function version4(data: SaveData, chronicle: readonly ChronicleEntry[]): SaveData {
  const json = data.json as { people: Record<string, unknown> };
  const people: Record<string, unknown> = {
    ...json.people,
    chronicle: chronicle.map((entry) => ({ ...entry })),
  };
  delete people.subspecies;
  const arrays = Object.fromEntries(
    Object.entries(data.arrays).filter(
      ([name]) => !name.endsWith('FamilyLanguage') && !name.startsWith('chronicle'),
    ),
  );
  return { meta: data.meta, json: { ...json, people }, arrays };
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
    // La version 4 n'avait pas la langue des noms de famille : chacun s'écrivait dans celle
    // de sa culture, sauf dans une culture sans nom de famille.
    const old = encodeSave(version4(save(state), society.chronicle), 4);
    const shown = (sex: number, given: number, code: number, id: number) => {
      const culture = cultureOf(society, id);
      const words = phonologyOf(languageOf(society, culture?.language ?? 0)?.seed ?? 0);
      const first = givenName(words, sex, given);
      return culture?.naming === 'none' || code === 0
        ? first
        : `${first} ${familyName(words, code)}`;
    };
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
    // La chronique passe de l'en-tête à ses colonnes ; l'ascendance suit l'ordre des données.
    expect(restored.society.chronicle).toEqual(society.chronicle);
    expect(restored.society.nextGroupId).toBe(society.nextGroupId);
    expect(Array.from(restored.people.columns.ancestry.subarray(0, 4))).toEqual(pureAncestry(1));
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

/** La sauvegarde, avec des champs de sa population remplacés. */
function withPeople(data: SaveData, patch: Record<string, unknown>): SaveData {
  const json = data.json as { people: Record<string, unknown> };
  return { ...data, json: { ...json, people: { ...json.people, ...patch } } };
}

/** La sauvegarde, avec une valeur d'un tableau remplacée. */
function withValue(data: SaveData, name: string, index: number, value: number): SaveData {
  if (!(name in data.arrays)) throw new Error(`pas de tableau ${name}`);
  const copy = data.arrays[name].slice();
  copy[index] = value;
  return withArray(data, name, copy);
}

/** La sauvegarde, sans l'un de ses tableaux. */
function without(data: SaveData, name: string): SaveData {
  return {
    ...data,
    arrays: Object.fromEntries(Object.entries(data.arrays).filter(([key]) => key !== name)),
  };
}

const corrupt = expect.objectContaining({ code: 'corrupt' }) as Error;
const obsolete = expect.objectContaining({ code: 'obsolete' }) as Error;

/**
 * La partie de populated(), plus un vivant de chaque autre sous-espèce des humains (5, 6),
 * une métisse du nord et des sables (7), et un mort du nord (8).
 */
function lineages(): SimState {
  const state = populated();
  const { people } = state;
  people.add(person({ group: 1, ancestry: pureAncestry(0) }));
  people.add(person({ group: 1, sex: MALE, ancestry: pureAncestry(2) }));
  people.add(person({ group: 1, ancestry: [128, 0, 127, 0] }));
  people.remove(people.add(person({ group: 1, sex: MALE, ancestry: pureAncestry(0) })), 0, 'cold');
  return state;
}

/** Les identifiants de lineages(), vivants et morts. */
const LINEAGES = [1, 2, 3, 4, 5, 6, 7, 8];

/** Le contenu des tests, avec les humains modifiés par `change`. */
function humans(change: (human: Species) => Species) {
  return { ...testData, species: withHuman(change).species };
}

describe('sauvegarde : sous-espèces nommées (ADR 0006)', () => {
  const ancestries = (state: SimState, content: typeof testData) =>
    LINEAGES.map((id) => personView(state, content, id)?.ancestry);
  const adaptations = (state: SimState, human: Species | undefined) =>
    [1, 5, 6, 7].map((id) =>
      human === undefined
        ? undefined
        : adaptationOf(state.people, state.people.slotOf(id) ?? -1, human),
    );

  it("garde l'ascendance de chacun quand data/species.json range autrement ses sous-espèces", () => {
    const state = lineages();
    const before = ancestries(state, testData);
    const adapted = adaptations(state, testHuman);
    const data = save(state);
    const sands = testHuman.subspecies.at(2);
    if (sands === undefined) throw new Error('pas de sous-espèce des sables');
    const variants = [
      // Une sous-espèce de plus, en tête de liste.
      humans((human) => ({
        ...human,
        subspecies: [{ ...sands, id: 'forest' }, ...human.subspecies],
      })),
      // Les mêmes, dans l'ordre inverse.
      humans((human) => ({ ...human, subspecies: [...human.subspecies].reverse() })),
    ];
    for (const content of variants) {
      const restored = restoreState(data, content);
      expect(ancestries(restored, content)).toEqual(before);
      expect(adaptations(restored, content.species.entries.at(0))).toEqual(adapted);
    }
  });

  it('refuse une sauvegarde dont une sous-espèce a disparu des données', () => {
    const data = save(lineages());
    const content = humans((human) => ({ ...human, subspecies: human.subspecies.slice(0, 2) }));
    expect(() => restoreState(data, content)).toThrow(obsolete);
  });

  it("refuse des parts d'ascendance ou un ordre des sous-espèces forgés", () => {
    const data = save(lineages());
    const cases: [string, SaveData][] = [
      // Une part d'une quatrième sous-espèce, que la sauvegarde ne connaît pas.
      ['part d’un vivant', withValue(data, 'peopleAncestry', 3, 9)],
      ['part d’un mort', withValue(data, 'archiveAncestry', 3, 9)],
      ['liste de sous-espèces sans espèce', withPeople(data, { subspecies: [] })],
      ['sous-espèce répétée', withPeople(data, { subspecies: [['nordic', 'nordic', 'sands']] })],
    ];
    for (const [label, forged] of cases) {
      expect(() => restoreState(forged, testData), label).toThrow(corrupt);
    }
  });
});

describe('sauvegarde : chronique en colonnes', () => {
  /** Un fait de famine du groupe 1. */
  const famine = (tick: number, count: number): ChronicleEntry => ({
    tick,
    kind: 'famine',
    x: 10,
    y: 20,
    group: 1,
    other: NONE,
    leader: 1,
    otherLeader: NONE,
    count,
  });

  it("garde hors de l'en-tête une chronique de plus de cent mille faits", async () => {
    const state = populated();
    for (let index = 0; index < 120_000; index++)
      state.society.chronicle.push(famine(0, 3 + (index % 7)));
    const data = save(state);
    // En JSON, ces faits auraient rempli l'en-tête (8 Mio) : la sauvegarde échouait.
    expect(JSON.stringify(data.json).length).toBeLessThan(64 * 1024);
    const restored = restoreState(await readSave(await writeSave(data), MIGRATIONS), testData);
    expect(restored.society.chronicle).toHaveLength(state.society.chronicle.length);
    expect(restored.society.chronicle.at(-1)).toEqual(state.society.chronicle.at(-1));
    expect(fingerprint(restored)).toBe(fingerprint(state));
  });

  it('refuse une chronique forgée', () => {
    const state = populated();
    state.tick = 5;
    state.society.chronicle.push(famine(3, 4));
    const data = save(state);
    const cases: [string, SaveData][] = [
      ['genre inconnu', withValue(data, 'chronicleKind', 1, CHRONICLE_KINDS.length)],
      ['fait à venir', withValue(data, 'chronicleTick', 1, 6)],
      ['faits désordonnés', withValue(data, 'chronicleTick', 0, 4)],
      ['hors du monde, en x', withValue(data, 'chronicleX', 1, 512)],
      ['hors du monde, en y', withValue(data, 'chronicleY', 1, 256)],
      ['sans groupe', withValue(data, 'chronicleGroup', 1, NONE)],
      ['groupe inconnu', withValue(data, 'chronicleGroup', 1, 2)],
      ['autre groupe inconnu', withValue(data, 'chronicleOther', 1, 2)],
      ['meneur inconnu', withValue(data, 'chronicleLeader', 1, 99)],
      ['colonne absente', without(data, 'chronicleCount')],
      ['colonne trop courte', withArray(data, 'chronicleCount', Uint32Array.of(4))],
      ['colonne de mauvais type', withArray(data, 'chronicleKind', Uint32Array.of(0, 3))],
      ['nombre de faits faux', withPeople(data, { chronicle: 3 })],
    ];
    for (const [label, forged] of cases) {
      expect(() => restoreState(forged, testData), label).toThrow(corrupt);
    }
  });

  it('refuse un prochain identifiant de groupe que la chronique ne justifie pas', () => {
    const data = save(populated());
    // Démesuré, il ferait allouer chaque mois des tableaux de cette taille (lifecycle.ts).
    expect(() => restoreState(withPeople(data, { nextGroupId: MAX_IDS }), testData)).toThrow(
      corrupt,
    );
    expect(() => restoreState(withPeople(data, { nextGroupId: 3 }), testData)).toThrow(corrupt);
    // Le premier groupe formé porte l'identifiant 1 : son fait ne peut en nommer un autre.
    const shifted = withPeople(withValue(data, 'chronicleGroup', 0, 2), { nextGroupId: 3 });
    expect(() => restoreState(shifted, testData)).toThrow(corrupt);
  });
});

describe('sauvegarde : fichiers forgés', () => {
  /** Mémoire des ArrayBuffer du processus (Node), en octets. */
  const buffers = () =>
    (
      globalThis as unknown as { process: { memoryUsage(): { arrayBuffers: number } } }
    ).process.memoryUsage().arrayBuffers;

  it("refuse des tableaux absents ou trop courts avant de rien allouer d'après l'en-tête", () => {
    const data = save(populated());
    const nextId = 2_000_000;
    const where = new Int32Array(nextId).fill(-1);
    where.set(data.arrays.peopleWhere);
    const forged = [
      // Deux millions d'emplacements annoncés, et les colonnes de quatre.
      withPeople(data, { end: MAX_SLOTS }),
      // Deux millions de morts annoncés, l'index qui va avec, et l'archive d'un seul.
      withArray(withPeople(data, { nextId, archived: nextId - 1 - 3 }), 'peopleWhere', where),
    ];
    for (const file of forged) {
      const before = buffers();
      expect(() => restoreState(file, testData)).toThrow(/absent ou de mauvaise taille/);
      // Allouées d'après l'en-tête, colonnes ou archive pèseraient plus de 100 Mio.
      expect(buffers() - before).toBeLessThan(32 * 1024 * 1024);
    }
  });

  it('refuse un identifiant que ni les vivants ni les morts ne portent', () => {
    const data = save(populated());
    const where = Int32Array.from([...(data.arrays.peopleWhere as Int32Array), -1]);
    const forged = withArray(withPeople(data, { nextId: 6 }), 'peopleWhere', where);
    expect(() => restoreState(forged, testData)).toThrow(/identifiants incohérents/);
  });

  it('refuse une archive forgée : identifiant, index, cause, espèce', () => {
    // Le mort de populated() : l'identifiant 4, à la ligne 0 de l'archive.
    const data = save(populated());
    const cases: [string, SaveData][] = [
      ['mort aussi vivant', withValue(data, 'archiveId', 0, 1)],
      ['mort hors de son index', withValue(data, 'peopleWhere', 4, -3)],
      ['cause inconnue', withValue(data, 'archiveCause', 0, DEATH_CAUSES.length)],
      ['espèce hors de la liste', withValue(data, 'archiveSpecies', 0, 1)],
    ];
    for (const [label, forged] of cases) {
      expect(() => restoreState(forged, testData), label).toThrow(corrupt);
    }
  });

  it('refuse de sauvegarder une société au-delà des bornes du format', () => {
    const state = populated();
    for (let id = 2; id <= MAX_GROUPS + 1; id++) {
      state.society.cultures.push({ id, language: 1, naming: 'father', founded: 0 });
    }
    expect(() => save(state)).toThrow(expect.objectContaining({ code: 'size' }) as Error);
  });
});

describe('sauvegarde : génomes et espèces (ADR 0006)', () => {
  /** Allèles de la mère et du père de chaque locus, et valeur de chaque trait, par identifiant. */
  const genes = (state: SimState, genetics: Genetics) =>
    LINEAGES.map((id) => {
      const record = recordOf(state.people, id);
      if (record === undefined) return undefined;
      const { genome } = heredity(state.people, record);
      return {
        loci: Object.fromEntries(
          genetics.loci.map((locus, index) => [
            locus.id,
            alleles(genome, 0, index).map((code) => locus.alleles.at(code)?.id),
          ]),
        ),
        traits: Object.fromEntries(
          genetics.traits.map((entry, index) => [entry.id, trait(genome, 0, index)]),
        ),
      };
    });

  it('réécrit les génomes quand data/genetics.json range autrement ses locus et ses traits', () => {
    const state = lineages();
    const before = genes(state, testData.genetics);
    const genetics: Genetics = {
      ...testData.genetics,
      loci: [...testData.genetics.loci].reverse(),
      traits: [...testData.genetics.traits].reverse(),
    };
    const restored = restoreState(save(state), { ...testData, genetics });
    expect(genes(restored, genetics)).toEqual(before);
    expect(before.every((entry) => entry !== undefined)).toBe(true);
  });

  it("refuse un génome illisible, que l'ordre des données ait changé ou non", () => {
    const data = save(populated());
    const first = testData.genetics.loci.at(0);
    if (first === undefined) throw new Error('pas de locus');
    // Le premier code qui ne désigne aucun allèle, pour la mère comme pour le père.
    const code = first.alleles.length;
    expect(code).toBeLessThan(16);
    const genome = (name: string) => withValue(data, name, 0, code | (code << 4));
    const reversed: Genetics = {
      ...testData.genetics,
      loci: testData.genetics.loci.map((locus) => ({
        ...locus,
        alleles: [...locus.alleles].reverse(),
      })),
    };
    for (const genetics of [testData.genetics, reversed]) {
      for (const name of ['peopleGenome', 'archiveGenome']) {
        expect(() => restoreState(genome(name), { ...testData, genetics }), name).toThrow(
          /génome illisible/,
        );
      }
    }
  });

  it('suit les espèces par leur identifiant quand data/species.json les range autrement', () => {
    const giant = { ...testHuman, id: 'giant' };
    const both = loadCatalog('espèces des tests', SpeciesListSchema, [testHuman, giant]);
    const swapped = loadCatalog('espèces des tests', SpeciesListSchema, [giant, testHuman]);
    const state = populated();
    // Des géants, un vivant et un mort, à côté des humains.
    state.people.add(person({ group: 1, species: 1 }));
    state.people.remove(state.people.add(person({ group: 1, sex: MALE, species: 1 })), 0, 'cold');
    const data = saveState(state, GENERATOR_VERSION, { ...testData, species: both });
    const restored = restoreState(data, { ...testData, species: swapped });
    const kind = (people: Population, catalog: typeof both, id: number) => {
      const record = recordOf(people, id);
      return record === undefined
        ? undefined
        : catalog.entries.at(field(people, record, 'species'))?.id;
    };
    for (let id = 1; id < state.people.nextId; id++) {
      expect(kind(restored.people, swapped, id), String(id)).toBe(kind(state.people, both, id));
    }
    expect(kind(restored.people, swapped, 6)).toBe('giant');
  });
});

describe('sauvegarde : une vraie partie', () => {
  it("se relit à l'identique après vingt ans de scissions, de réunions et de morts", async () => {
    const state = flatState('relecture');
    const spawn = (x: number, y: number, subspecies: string) =>
      ({ type: 'spawnGroup', x, y, species: 'human', subspecies, count: 30 }) as const;
    step(
      state,
      [spawn(10, 60, 'plains'), spawn(30, 64, 'nordic'), spawn(505, 70, 'sands')],
      testData,
    );
    for (let month = 1; month < 240; month++) step(state, [], testData);
    // De quoi éprouver les invariants de la relecture : identifiants, archive, groupes formés.
    const kinds = new Set(state.society.chronicle.map((entry) => entry.kind));
    expect(kinds.has('groupSplit')).toBe(true);
    expect(state.people.archive.rows).toBeGreaterThan(0);
    const restored = restoreState(
      await readSave(await writeSave(save(state)), MIGRATIONS),
      testData,
    );
    expect(fingerprint(restored)).toBe(fingerprint(state));
    for (let month = 0; month < 12; month++) {
      step(state, [], testData);
      step(restored, [], testData);
    }
    expect(fingerprint(restored)).toBe(fingerprint(state));
  });
});
