import { describe, expect, it } from 'vitest';
import type { Species } from '../core/data';
import type { SpawnGroupCommand } from '../core/protocol';
import type { WorldLayers } from '../core/world';
import { log } from '../core/dmath';
import { RandomStream, streamSeed } from '../core/rng';
import { pureAncestry } from './genetics';
import {
  birthCulture,
  causeOf,
  fertilityAt,
  hardshipInto,
  lifeCycle,
  monthlyProbability,
  silerHazards,
  type Hardship,
} from './lifecycle';
import {
  ANCESTRY_SLOTS,
  DEATH_CAUSES,
  FEMALE,
  GENOME_WORDS,
  MALE,
  NEVER,
  NONE,
  Population,
  type DeathCause,
  type NewPerson,
} from './population';
import { monthOf, MONTHS_PER_YEAR } from './people';
import { field, personName, recordOf } from './records';
import { membersOf } from './spawn';
import type { NamingRule } from './society';
import type { SimState } from './state';
import { fingerprint, step, type SimContent } from './step';
import { groupMembers } from './groups';
import {
  flatState,
  flooded,
  scatteredGroups,
  testData,
  testHuman as human,
  testState,
  withHuman,
} from './testing';

/** Cases de terre des biomes voulus, espacées. */
function cells(state: SimState, biomes: readonly string[], count: number) {
  const found: { x: number; y: number }[] = [];
  const { width } = state.size;
  for (let index = 0; index < state.world.biome.length && found.length < count; index += 211) {
    const biome = testData.biomes.entries.at(state.world.biome[index] ?? 0);
    if (biome !== undefined && biomes.includes(biome.id)) {
      found.push({ x: index % width, y: Math.floor(index / width) });
    }
  }
  return found;
}

function spawn(
  state: SimState,
  biomes: readonly string[],
  groups: number,
  subspecies = 'plains',
): SpawnGroupCommand[] {
  return cells(state, biomes, groups).map((cell) => ({
    type: 'spawnGroup',
    ...cell,
    species: 'human',
    subspecies,
    count: 30,
  }));
}

function run(state: SimState, months: number, content: SimContent = testData): void {
  for (let month = 0; month < months; month++) step(state, [], content);
}

/** Morts d'une cause, depuis le début de la partie. */
function deathsBy(state: SimState, cause: DeathCause): number {
  const code = DEATH_CAUSES.indexOf(cause);
  let count = 0;
  for (let row = 0; row < state.people.archive.rows; row++) {
    if (state.people.archive.columns.cause[row] === code) count++;
  }
  return count;
}

/** Mère, père et conjoint d'un individu, vivant ou mort. */
function kin(state: SimState, id: number) {
  const record = recordOf(state.people, id);
  if (record === undefined) return { mother: NONE, father: NONE, partner: NONE };
  return {
    mother: field(state.people, record, 'mother'),
    father: field(state.people, record, 'father'),
    partner: field(state.people, record, 'partner'),
  };
}

/**
 * Proches parents au sens de la tâche 2.3, recalculés ici sans closeKin : ascendant et
 * descendant sur deux générations, frères et sœurs, oncle ou tante, beau-parent.
 */
function related(state: SimState, a: number, b: number): boolean {
  const parents = (id: number) => [kin(state, id).mother, kin(state, id).father];
  const known = (ids: number[]) => ids.filter((id) => id !== NONE);
  const parentsA = known(parents(a));
  const parentsB = known(parents(b));
  const grandA = known(parentsA.flatMap(parents));
  const grandB = known(parentsB.flatMap(parents));
  const siblings = (x: number[], y: number[]) => x.some((id) => y.includes(id));
  return (
    parentsA.includes(b) ||
    parentsB.includes(a) ||
    grandA.includes(b) ||
    grandB.includes(a) ||
    siblings(parentsA, parentsB) ||
    parentsA.some((parent) => siblings(known(parents(parent)), parentsB)) ||
    parentsB.some((parent) => siblings(known(parents(parent)), parentsA)) ||
    parentsA.some((parent) => kin(state, parent).partner === b) ||
    parentsB.some((parent) => kin(state, parent).partner === a)
  );
}

/** Humains qui ne meurent pas (pour suivre une famille sans aléa de mort). */
function immortal(species: Species): Species {
  const { mortality, fertility } = species;
  return {
    ...species,
    mortality: {
      ...mortality,
      infant: { ...mortality.infant, level: 0 },
      background: 0,
      senescence: { ...mortality.senescence, level: 0 },
    },
    fertility: { ...fertility, childbirthDeath: 0 },
  };
}

const calm = withHuman(immortal);

/**
 * Une partie sur la steppe, retouchée au besoin par `shape` : pour chaque règle de nommage,
 * une langue, une culture et un groupe, à deux cases l'un de l'autre.
 */
function founded(rules: readonly NamingRule[], shape?: (world: WorldLayers) => void): SimState {
  const state = flatState(undefined, shape);
  rules.forEach((naming, index) => {
    const id = index + 1;
    state.society.languages.push({ id, seed: 7919 * id });
    state.society.cultures.push({ id, language: id, naming, founded: 0 });
    state.society.groups.set(id, {
      id,
      culture: id,
      founded: 0,
      parent: NONE,
      leader: NONE,
      x: 10 + 2 * index,
      y: 60,
      homeX: 10 + 2 * index,
      homeY: 60,
      targetX: -1,
      targetY: -1,
      food: 100,
    });
  });
  state.society.nextGroupId = rules.length + 1;
  return state;
}

/**
 * Ajoute une personne ; par défaut, une femme de 25 ans du groupe et de la culture 1, sans
 * parents connus, et son emplacement.
 */
function person(
  state: SimState,
  changes: Partial<NewPerson> & { readonly years?: number } = {},
): number {
  const { years = 25, ...rest } = changes;
  return state.people.add({
    sex: FEMALE,
    birth: state.tick - Math.round(years * MONTHS_PER_YEAR),
    species: 0,
    ancestry: pureAncestry(1),
    genome: new Uint32Array(GENOME_WORDS),
    mother: NONE,
    father: NONE,
    group: 1,
    culture: 1,
    givenName: 11,
    familyName: 0,
    familyLanguage: rest.culture ?? 1,
    ...rest,
  });
}

const idOf = (state: SimState, slot: number) => state.people.get('id', slot);

function marry(state: SimState, woman: number, man: number): void {
  state.people.set('partner', woman, idOf(state, man));
  state.people.set('partner', man, idOf(state, woman));
}

/** La femme de l'emplacement `woman` accouche ce mois-ci d'un enfant de `father`. */
function atTerm(state: SimState, woman: number, father: number): void {
  state.people.set('conceived', woman, state.tick - human.fertility.gestation);
  state.people.set('pregnantBy', woman, idOf(state, father));
}

/** Emplacements des enfants nés au pas `tick`. */
function bornAt(state: SimState, tick: number): number[] {
  const born: number[] = [];
  state.people.forEach((slot) => {
    if (state.people.get('birth', slot) === tick) born.push(slot);
  });
  return born;
}

/** Le nom de famille dans un nom complet : ce qui suit le prénom. */
const surname = (name: string) => name.split(' ').slice(1).join(' ');

describe('cycle de vie (tâche 2.3)', () => {
  it("donne aux humains l'espérance de vie de chasseurs-cueilleurs", () => {
    // Table de mortalité tirée de Siler : espérance de vie à la naissance, survie à 15 ans.
    let alive = 1;
    let expectancy = 0;
    let at15 = 0;
    for (let month = 0; month < human.longevity * 12; month++) {
      const hazards = silerHazards(human, month / 12);
      alive *= 1 - monthlyProbability(hazards.infant + hazards.background + hazards.senescence);
      expectancy += alive / 12;
      if (month === 15 * 12) at15 = alive;
    }
    expect(expectancy).toBeGreaterThan(28);
    expect(expectancy).toBeLessThan(42);
    expect(at15).toBeGreaterThan(0.5);
    expect(at15).toBeLessThan(0.7);
  });

  it('borne la fécondité féminine à sa période, avec un sommet, selon les données', () => {
    const { from, peak, to } = human.fertility;
    expect(fertilityAt(human, from - 1)).toBe(0);
    expect(fertilityAt(human, to)).toBe(0);
    expect(fertilityAt(human, peak + 1)).toBe(1);
    expect(fertilityAt(human, from + 1)).toBeLessThan(fertilityAt(human, peak));
    expect(fertilityAt(human, from)).toBeCloseTo(human.fertility.onset, 9);
    // La forme vient de data/species.json : fécondité entière dès le premier âge fécond, et
    // jusqu'à la fin de la période.
    const flat = { ...human, fertility: { ...human.fertility, onset: 1, plateau: 1 } };
    expect(fertilityAt(flat, from)).toBe(1);
    expect(fertilityAt(flat, to - 0.1)).toBe(1);
  });

  it('fait naître, vivre et mourir : une population nourrie se maintient et croît', () => {
    const state = testState();
    step(state, spawn(state, ['temperate-forest', 'grassland'], 4), testData);
    // Quatre groupes de trente, dont la mort a pu emporter un membre dès le premier mois.
    const appeared = state.society.chronicle.filter((entry) => entry.kind === 'groupAppeared');
    expect(appeared.reduce((sum, entry) => sum + entry.count, 0)).toBe(120);
    const start = state.people.count;
    expect(start).toBeGreaterThan(110);
    run(state, 50 * 12);
    const { people } = state;
    expect(people.count).toBeGreaterThan(start);
    expect(people.count).toBeLessThan(start * 4);
    expect(people.archive.rows).toBeGreaterThan(50);
    // Chaque enfant né en partie a ses deux parents. Celui qui n'est pas encore adulte et
    // qui a encore un parent en vie vit dans le groupe de l'un d'eux : il a suivi celui qui
    // a changé de groupe. Aucun couple ne réunit de proches parents.
    let born = 0;
    let followed = 0;
    people.forEach((slot) => {
      if (people.get('birth', slot) <= 0) return;
      born++;
      expect(people.get('mother', slot)).not.toBe(NONE);
      expect(people.get('father', slot)).not.toBe(NONE);
      const partner = people.get('partner', slot);
      if (partner !== NONE) expect(related(state, idOf(state, slot), partner)).toBe(false);
      if (people.age(slot, state.tick) >= human.maturity * MONTHS_PER_YEAR) return;
      const groups = ['mother', 'father'].flatMap((link) => {
        const parent = people.slotOf(people.get(link as 'mother' | 'father', slot));
        return parent === undefined ? [] : [people.get('group', parent)];
      });
      if (groups.length === 0) return;
      followed++;
      expect(groups).toContain(people.get('group', slot));
    });
    expect(born).toBeGreaterThan(50);
    expect(followed).toBeGreaterThan(20);
    // Le premier mois de vie a son risque, celui de la table de Siler à 0 mois, rigueurs
    // en plus : des nouveau-nés meurent le mois de leur naissance (L-7).
    let births = 0;
    let atBirth = 0;
    const { archive } = people;
    for (let row = 0; row < archive.rows; row++) {
      if ((archive.columns.birth[row] ?? 0) <= 0) continue;
      births++;
      if (archive.columns.death[row] === archive.columns.birth[row]) atBirth++;
    }
    people.forEach((slot) => {
      if (people.get('birth', slot) > 0) births++;
    });
    const firstMonth = monthlyProbability(
      silerHazards(human, 0).infant + human.mortality.background,
    );
    expect(atBirth / births).toBeGreaterThan(firstMonth * 0.5);
    expect(atBirth / births).toBeLessThan(firstMonth * 2);
  });

  it('maintient trois siècles durant une population nourrie, qui croît sans exploser (D-8)', () => {
    // La mesure de docs/BACKLOG.md : seize groupes de trente répartis sur le monde des
    // tests (scatteredGroups), trois cents ans de nomadisme, d'hivers et de famines.
    const state = testState();
    step(state, scatteredGroups(state, 16), testData);
    const start = state.people.count;
    for (let century = 1; century <= 3; century++) {
      run(state, 100 * MONTHS_PER_YEAR - (century === 1 ? 1 : 0));
      expect(state.people.count).toBeGreaterThan(start);
    }
    // Croissance annuelle moyenne : de l'ordre de 0,5 % par an (0,1 à 1,5 %).
    const growth = log(state.people.count / start) / 300;
    expect(growth).toBeGreaterThan(0.001);
    expect(growth).toBeLessThan(0.015);
    // Les groupes se scindent, et restent des bandes d'une quinzaine de membres.
    const sizes = [...groupMembers(state.people).values()].map((list) => list.length);
    sizes.sort((a, b) => a - b);
    expect(sizes.length).toBeGreaterThan(48);
    const median = sizes[Math.floor(sizes.length / 2)] ?? 0;
    expect(median).toBeGreaterThanOrEqual(8);
    expect(median).toBeLessThanOrEqual(testData.nomads.split);
    // Descendance finale des femmes nées entre les ans 50 et 200, mortes après leur période
    // féconde : celle de chasseurs-cueilleurs, de quatre à sept enfants.
    const children = new Map<number, number>();
    const { archive } = state.people;
    const count = (mother: number) => children.set(mother, (children.get(mother) ?? 0) + 1);
    for (let row = 0; row < archive.rows; row++) count(archive.columns.mother[row] ?? NONE);
    state.people.forEach((slot) => count(state.people.get('mother', slot)));
    let women = 0;
    let born = 0;
    for (let row = 0; row < archive.rows; row++) {
      const birth = archive.columns.birth[row] ?? 0;
      const age = ((archive.columns.death[row] ?? 0) - birth) / MONTHS_PER_YEAR;
      if (archive.columns.sex[row] !== FEMALE || age < human.fertility.to) continue;
      if (birth < 50 * MONTHS_PER_YEAR || birth > 200 * MONTHS_PER_YEAR) continue;
      women++;
      born += children.get(archive.columns.id[row] ?? NONE) ?? 0;
    }
    expect(women).toBeGreaterThan(100);
    expect(born / women).toBeGreaterThan(4);
    expect(born / women).toBeLessThan(7);
    // Naissances de la partie dont les parents sont de deux cultures : 11,8 % sur cette
    // graine avec nomads.intermarriage à 0,25, 0,8 % sans mariage entre cultures
    // (docs/BACKLOG.md). La fourchette, large, voit ces mariages disparaître ; au-delà, la
    // part ne suit guère leur probabilité (de 6,5 à 18 % pour des valeurs de 0,05 à 1).
    const cultureOf = (id: number) => {
      const record = recordOf(state.people, id);
      return record === undefined ? undefined : field(state.people, record, 'culture');
    };
    let births = 0;
    let mixed = 0;
    const tally = (
      columns: Readonly<Record<'birth' | 'mother' | 'father', ArrayLike<number>>>,
      at: number,
    ) => {
      const maternal = cultureOf(columns.mother[at] ?? NONE);
      const paternal = cultureOf(columns.father[at] ?? NONE);
      if ((columns.birth[at] ?? 0) <= 0 || maternal === undefined || paternal === undefined) return;
      births++;
      if (maternal !== paternal) mixed++;
    };
    for (let row = 0; row < archive.rows; row++) tally(archive.columns, row);
    state.people.forEach((slot) => {
      tally(state.people.columns, slot);
    });
    expect(mixed / births).toBeGreaterThan(0.05);
    expect(mixed / births).toBeLessThan(0.25);
  });

  it("tue davantage de froid les fragiles d'une sous-espèce des sables que les nordiques", () => {
    // Des cases dont le mois le plus froid descend sous −10 °C.
    const state = testState();
    const cold = cells(state, ['taiga', 'cold-forest', 'tundra', 'cold-steppe'], 400).filter(
      ({ x, y }) => {
        const cell = y * state.size.width + x;
        return (state.world.temperature[cell] ?? 0) - (state.world.amplitude[cell] ?? 0) < -100;
      },
    );
    expect(cold.length).toBeGreaterThan(12);
    const command = (subspecies: string, index: number): SpawnGroupCommand => ({
      type: 'spawnGroup',
      x: cold[index]?.x ?? 0,
      y: cold[index]?.y ?? 0,
      species: 'human',
      subspecies,
      count: 30,
    });
    const nordic = testState();
    const sands = testState();
    step(
      nordic,
      cold.slice(0, 6).map((_, index) => command('nordic', index)),
      testData,
    );
    step(
      sands,
      cold.slice(0, 6).map((_, index) => command('sands', index)),
      testData,
    );
    run(nordic, 20 * 12);
    run(sands, 20 * 12);
    expect(deathsBy(sands, 'cold')).toBeGreaterThan(deathsBy(nordic, 'cold') * 1.5);
  });

  it('tient le confort des données de l’espèce (D-6)', () => {
    // Le monde plat, à 15 °C toute l'année : le confort des humains (de 0 à 30 °C), mais un
    // froid pour une espèce qui ne s'y trouve bien qu'au-delà de 20 °C. Seul le bas du
    // confort joue ici ; ses deux bornes et les extrêmes sont vérifiés dans « rigueurs du
    // mois ».
    const chilly = withHuman((human) => ({
      ...human,
      hardship: { ...human.hardship, comfort: [20, 35], extremes: [10, 45] },
    }));
    const coldDeaths = (content: SimContent) => {
      const state = flatState();
      step(
        state,
        [{ type: 'spawnGroup', x: 40, y: 60, species: 'human', subspecies: 'plains', count: 30 }],
        content,
      );
      run(state, 10 * MONTHS_PER_YEAR, content);
      return deathsBy(state, 'cold');
    };
    expect(coldDeaths(testData)).toBe(0);
    expect(coldDeaths(chilly)).toBeGreaterThan(0);
  });

  it('éteint un groupe dont le dernier membre meurt, et la chronique le note', () => {
    const state = testState();
    step(state, spawn(state, ['grassland', 'temperate-forest'], 1), testData);
    const group = [...state.society.groups.keys()][0] ?? 0;
    for (const slot of membersOf(state.people, group))
      state.people.remove(slot, state.tick, 'accident');
    step(state, [], testData);
    expect(state.society.groups.has(group)).toBe(false);
    expect(state.society.chronicle.at(-1)).toMatchObject({ kind: 'groupExtinct', group });
  });

  it('est déterministe : les mêmes commandes donnent la même histoire', () => {
    const a = testState();
    const b = testState();
    const commands = spawn(a, ['grassland', 'temperate-forest'], 2);
    step(a, commands, testData);
    step(b, commands, testData);
    run(a, 10 * 12);
    run(b, 10 * 12);
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(a.people.archive.rows).toBeGreaterThan(0);
    expect(monthOf(a.tick)).toBeCloseTo((a.tick % 12) + 0.5, 9);
    let women = 0;
    a.people.forEach((slot) => {
      if (a.people.get('sex', slot) === FEMALE) women++;
    });
    expect(women).toBeGreaterThan(0);
  });
});

describe('causes de mort (IND-04)', () => {
  it("ne fait mourir « de vieillesse » qu'à l'âge des vieux, hardship.frail[1] (L-5)", () => {
    const random = new RandomStream(streamSeed('causes', 'tests'));
    const none = { cold: 0, heat: 0, famine: 0 };
    const tally = (years: number) => {
      const counts = new Map<DeathCause, number>();
      for (let draw = 0; draw < 4000; draw++) {
        const cause = causeOf(human, years, silerHazards(human, years), none, 1, random);
        counts.set(cause, (counts.get(cause) ?? 0) + 1);
      }
      return counts;
    };
    const old = human.hardship.frail[1];
    for (const years of [0, 5, 16, 30, old - 1]) {
      const counts = tally(years);
      expect(counts.get('natural') ?? 0).toBe(0);
      expect(counts.get('disease') ?? 0).toBeGreaterThan(0);
    }
    // À 75 ans, la sénescence domine : la plupart meurent de vieillesse.
    expect(tally(75).get('natural') ?? 0).toBeGreaterThan(2000);
    // Seule la rigueur du mois menace : elle seule tue.
    expect(
      causeOf(
        human,
        0.1,
        { infant: 0, background: 0, senescence: 0 },
        { ...none, cold: 1 },
        1,
        random,
      ),
    ).toBe('cold');
  });
});

describe('rigueurs du mois (ADR 0011 ; L-12)', () => {
  /** Une femme de `years` ans, hors de tout groupe, d'ascendance pure de la sous-espèce `kind`. */
  const someone = (people: Population, years: number, kind: string) =>
    people.add({
      sex: FEMALE,
      birth: -years * MONTHS_PER_YEAR,
      species: 0,
      ancestry: pureAncestry(human.subspecies.findIndex((entry) => entry.id === kind)),
      genome: new Uint32Array(GENOME_WORDS),
      mother: NONE,
      father: NONE,
      group: NONE,
      culture: 1,
      givenName: 1,
      familyName: 0,
      familyLanguage: 1,
    });

  it('rendent le froid plus dur aux fragiles et aux moins adaptés, la faim égale pour tous', () => {
    const people = new Population();
    // Un nourrisson, une adulte et une vieille, nordiques ou des sables.
    const ages = [0, 30, 70] as const;
    const everyone = ['nordic', 'sands'].flatMap((kind) =>
      ages.map((years) => ({ years, kind, slot: someone(people, years, kind) })),
    );
    const hardship = (slot: number, years: number, temperature: number) => {
      const out: Hardship = { cold: 0, heat: 0, famine: 0 };
      hardshipInto(human, people, slot, years, temperature, out);
      return out;
    };
    const comfortable = (human.hardship.comfort[0] + human.hardship.comfort[1]) / 2;
    const [coldest] = human.hardship.extremes;
    // La faim ne suit que la nutrition : ni l'âge ni l'ascendance n'y entrent.
    for (const nutrition of [0, 128, 255]) {
      const missing = 1 - nutrition / 255;
      const expected = human.hardship.famine * missing * missing;
      for (const { years, slot } of everyone) {
        people.set('nutrition', slot, nutrition);
        for (const temperature of [comfortable, coldest]) {
          expect(hardship(slot, years, temperature).famine).toBeCloseTo(expected, 12);
        }
      }
    }
    // Le froid épargne le confort, frappe surtout les plus jeunes et les plus vieux, et
    // moins ceux qu'adapte leur sous-espèce.
    const cold = (years: number, kind: string) => {
      const found = everyone.find((entry) => entry.years === years && entry.kind === kind);
      return hardship(found?.slot ?? -1, years, coldest).cold;
    };
    for (const { years, slot } of everyone) expect(hardship(slot, years, comfortable).cold).toBe(0);
    for (const kind of ['nordic', 'sands']) {
      expect(cold(0, kind)).toBeGreaterThan(cold(30, kind));
      expect(cold(70, kind)).toBeGreaterThan(cold(30, kind));
    }
    for (const years of ages) expect(cold(years, 'nordic')).toBeLessThan(cold(years, 'sands'));
  });

  it('suivent le confort et les extrêmes de chaque espèce, pas ceux des humains (D-6)', () => {
    // Une espèce d'un autre climat que les humains : à son aise de 10 à 20 °C, au plein du
    // froid dès 0 °C et de la chaleur dès 30 °C. Ses rigueurs se comparent à leur plein, à −10
    // et à 40 °C : des bornes écrites en dur, celles des humains, s'y verraient.
    const temperate =
      withHuman((species) => ({
        ...species,
        hardship: { ...species.hardship, comfort: [10, 20], extremes: [0, 30] },
      })).species.entries.at(0) ?? missing();
    const people = new Population();
    const adult = someone(people, 30, 'plains');
    people.set('nutrition', adult, 255);
    const at = (temperature: number) => {
      const out: Hardship = { cold: 0, heat: 0, famine: 0 };
      hardshipInto(temperate, people, adult, 30, temperature, out);
      return out;
    };
    for (const temperature of [10, 15, 20]) {
      expect(at(temperature)).toMatchObject({ cold: 0, heat: 0 });
    }
    // Le froid : plein à 0 °C comme à −10 °C, à moitié à 5 °C ; aucune chaleur de ce côté.
    const cold = at(-10).cold;
    expect(cold).toBeGreaterThan(0);
    expect(at(0).cold).toBeCloseTo(cold, 12);
    expect(at(5).cold).toBeCloseTo(cold / 2, 12);
    for (const temperature of [5, 0, -10]) expect(at(temperature).heat).toBe(0);
    // La chaleur : pleine à 30 °C comme à 40 °C, à moitié à 25 °C ; aucun froid de ce côté.
    const heat = at(40).heat;
    expect(heat).toBeGreaterThan(0);
    expect(at(30).heat).toBeCloseTo(heat, 12);
    expect(at(25).heat).toBeCloseTo(heat / 2, 12);
    for (const temperature of [25, 30, 40]) expect(at(temperature).cold).toBe(0);
  });
});

describe('naissances et familles (L-11)', () => {
  it("espace les naissances d'une mère d'au moins une grossesse et un allaitement", () => {
    const state = founded(['father']);
    const woman = person(state, { years: 17 });
    const man = person(state, { sex: MALE, years: 19 });
    marry(state, woman, man);
    const { gestation, postpartum } = human.fertility;
    const births: number[] = [];
    for (let month = 0; month < 30 * MONTHS_PER_YEAR; month++) {
      // Le mois de la conception de la grossesse en cours, s'il y en a une.
      const conceived = state.people.get('conceived', woman);
      lifeCycle(state, calm);
      for (const child of bornAt(state, state.tick)) {
        expect(state.people.get('mother', child)).toBe(idOf(state, woman));
        // Chaque grossesse dure exactement fertility.gestation mois.
        expect(state.tick - conceived).toBe(gestation);
        births.push(state.tick);
      }
      state.tick++;
    }
    expect(births.length).toBeGreaterThanOrEqual(4);
    for (let index = 1; index < births.length; index++) {
      expect((births[index] ?? 0) - (births[index - 1] ?? 0)).toBeGreaterThanOrEqual(
        gestation + postpartum,
      );
    }
  });

  it('fait accoucher au bout de fertility.gestation mois, pas un mois plus tôt', () => {
    const state = founded(['father']);
    const woman = person(state);
    const man = person(state, { sex: MALE, years: 27 });
    marry(state, woman, man);
    // Une grossesse conçue il y a gestation − 1 mois : pas d'enfant ce mois-ci.
    state.people.set('conceived', woman, state.tick - (human.fertility.gestation - 1));
    state.people.set('pregnantBy', woman, idOf(state, man));
    lifeCycle(state, calm);
    expect(bornAt(state, state.tick)).toEqual([]);
    // Le mois suivant, elle est à terme : l'enfant naît.
    state.tick++;
    lifeCycle(state, calm);
    const born = bornAt(state, state.tick);
    expect(born).toHaveLength(1);
    expect(state.people.get('mother', born[0] ?? -1)).toBe(idOf(state, woman));
  });

  it("ne donne plus d'enfant à un homme au-delà de fertility.maleTo", () => {
    // Des femmes au sommet de leur fécondité, qui conçoivent dès qu'elles le peuvent.
    const eager = withHuman((species) => {
      const still = immortal(species);
      return { ...still, fertility: { ...still.fertility, monthly: 1 } };
    });
    const state = founded(['father']);
    const young = person(state, { years: 26 });
    const old = person(state, { years: 26 });
    marry(state, young, person(state, { sex: MALE, years: human.fertility.maleTo - 1 }));
    marry(state, old, person(state, { sex: MALE, years: human.fertility.maleTo + 1 }));
    for (let month = 0; month < 24; month++) {
      lifeCycle(state, eager);
      state.tick++;
    }
    expect(state.people.get('lastBirth', young)).not.toBe(NEVER);
    expect(state.people.get('lastBirth', old)).toBe(NEVER);
    expect(state.people.get('conceived', old)).toBe(NEVER);
  });

  it("laisse orphelin l'enfant d'une mère morte en couches, et plus exposé que les autres", () => {
    // Deux mille femmes accouchent le même mois ; dans la variante, toutes en meurent.
    const deliver = (content: SimContent) => {
      const state = founded(['father']);
      const father = person(state, { sex: MALE, years: 30 });
      for (let index = 0; index < 2000; index++) atTerm(state, person(state), father);
      lifeCycle(state, content);
      let orphans = 0;
      let deadAtBirth = 0;
      for (let row = 0; row < state.people.archive.rows; row++) {
        if (state.people.archive.columns.birth[row] === state.tick) deadAtBirth++;
      }
      state.people.forEach((slot) => {
        if (state.people.get('birth', slot) !== state.tick) return;
        if (state.people.slotOf(state.people.get('mother', slot)) === undefined) orphans++;
      });
      return { state, orphans, deadAtBirth };
    };
    const fatal = deliver(
      withHuman((species) => ({
        ...species,
        fertility: { ...species.fertility, childbirthDeath: 1 },
      })),
    );
    const safe = deliver(
      withHuman((species) => ({
        ...species,
        fertility: { ...species.fertility, childbirthDeath: 0 },
      })),
    );
    // Quelques femmes meurent d'autre chose avant d'accoucher.
    expect(deathsBy(fatal.state, 'childbirth')).toBeGreaterThan(1990);
    expect(deathsBy(safe.state, 'childbirth')).toBe(0);
    expect(fatal.orphans).toBeGreaterThan(1500);
    // Le risque du premier mois d'un orphelin est multiplié par mortality.orphan.factor.
    expect(fatal.deadAtBirth).toBeGreaterThan(safe.deadAtBirth * 1.6);
    expect(safe.deadAtBirth).toBeGreaterThan(30);
  });

  it("fait durer le surcroît de risque d'un orphelin selon mortality.orphan (L-8)", () => {
    // Des orphelins de 40 mois : la variante les fait dépendre de leur mère jusqu'à 60 mois.
    const deaths = (content: SimContent) => {
      const state = founded(['father']);
      for (let index = 0; index < 2000; index++) person(state, { years: 40 / 12 });
      for (let month = 0; month < 12; month++) {
        lifeCycle(state, content);
        state.tick++;
      }
      return state.people.archive.rows;
    };
    const dependent = withHuman((species) => ({
      ...species,
      mortality: { ...species.mortality, orphan: { factor: 10, months: 60 } },
    }));
    expect(deaths(dependent)).toBeGreaterThan(deaths(testData) * 2.5);
  });

  it('emmène les jeunes enfants de qui rejoint le groupe de son conjoint, pas les adultes', () => {
    // Le groupe 1 : un veuf, ses deux jeunes enfants et sa fille adulte. Le groupe 2, plus
    // grand : une femme seule qui ne trouve pas de conjoint chez elle.
    const state = founded(['father', 'father']);
    state.society.groups.set(2, { ...(state.society.groups.get(2) ?? missing()), culture: 1 });
    const widower = person(state, { sex: MALE, years: 35 });
    const late = person(state, { years: 34 });
    const mother = idOf(state, late);
    marry(state, late, widower);
    state.people.remove(late, state.tick, 'disease');
    const children = (years: number, sex = FEMALE) =>
      person(state, { sex, years, mother, father: idOf(state, widower) });
    const young = [children(5, MALE), children(9)];
    const adult = children(20);
    const single = person(state, { group: 2, years: 33 });
    for (let index = 0; index < 3; index++) {
      marry(
        state,
        person(state, { group: 2, years: 40 }),
        person(state, { group: 2, sex: MALE, years: 40 }),
      );
    }
    const eager = withHuman((species) => ({ ...immortal(species), pairing: 1 }));
    lifeCycle(state, eager);
    expect(state.people.get('partner', single)).toBe(idOf(state, widower));
    expect(state.people.get('group', widower)).toBe(2);
    for (const child of young) expect(state.people.get('group', child)).toBe(2);
    expect(state.people.get('group', adult)).toBe(1);
  });

  it('fait vivre une sous-espèce ajoutée aux données, sans toucher au code (ESP-03)', () => {
    const content = withHuman((species) => ({
      ...species,
      subspecies: [
        ...species.subspecies,
        {
          ...(species.subspecies[1] ?? missing()),
          id: 'highland',
          adaptation: { cold: 0.6, heat: 0.3, endurance: 0.9 },
        },
      ],
    }));
    const state = flatState();
    step(
      state,
      [{ type: 'spawnGroup', x: 40, y: 60, species: 'human', subspecies: 'highland', count: 30 }],
      content,
    );
    run(state, 10 * MONTHS_PER_YEAR, content);
    const born = countBirths(state);
    state.people.forEach((slot) => {
      const shares = state.people.columns.ancestry.subarray(
        slot * ANCESTRY_SLOTS,
        (slot + 1) * ANCESTRY_SLOTS,
      );
      expect(Array.from(shares)).toEqual([0, 0, 0, 255]);
    });
    expect(born).toBeGreaterThanOrEqual(5);
  });
});

describe('culture et nom à la naissance (C2, D2 ; IND-08)', () => {
  /**
   * Un couple mixte dans le groupe 1 : la mère, de la culture 1, avec `mothers` membres
   * de sa culture en tout, le père de la culture 2 avec `fathers` ; l'enfant naît ce mois.
   */
  function mixed(rules: readonly NamingRule[], mothers: number, fathers: number) {
    const state = founded(rules);
    const mother = person(state, { familyName: 101, familyLanguage: 1 });
    const father = person(state, { sex: MALE, culture: 2, familyName: 202, familyLanguage: 2 });
    marry(state, mother, father);
    for (let index = 1; index < mothers; index++) person(state, { years: 50 });
    for (let index = 1; index < fathers; index++) person(state, { culture: 2, years: 50 });
    atTerm(state, mother, father);
    lifeCycle(state, calm);
    const child = bornAt(state, state.tick).at(0);
    if (child === undefined) throw new Error('aucune naissance');
    const name = (slot: number) => personName(state.people, state.society, idOf(state, slot));
    return { state, mother, father, child, name };
  }

  it('donne à l’enfant de parents de deux cultures celle qui domine dans son groupe', () => {
    // La culture du père domine : l'enfant la reçoit, et le nom de son père tel quel.
    const paternal = mixed(['father', 'father'], 2, 5);
    expect(paternal.state.people.get('culture', paternal.child)).toBe(2);
    expect(surname(paternal.name(paternal.child))).toBe(surname(paternal.name(paternal.father)));
    // Celle de la mère domine : l'enfant la reçoit, mais le nom de son père garde sa
    // langue ; seul son prénom est dans celle de la culture de sa mère.
    const maternal = mixed(['father', 'father'], 5, 2);
    const { state, child, father, name } = maternal;
    expect(state.people.get('culture', child)).toBe(1);
    expect(state.people.get('familyName', child)).toBe(202);
    expect(state.people.get('familyLanguage', child)).toBe(2);
    expect(surname(name(child))).toBe(surname(name(father)));
  });

  it('départage les cultures par le parent qui transmet le nom selon la règle de la mère', () => {
    // À égalité, la règle de la culture de la mère désigne qui transmet le nom.
    const byFather = mixed(['father', 'mother'], 3, 3);
    expect(byFather.state.people.get('culture', byFather.child)).toBe(2);
    // L'enfant suit alors la règle de sa culture, celle du père : le nom de sa mère.
    expect(byFather.state.people.get('familyName', byFather.child)).toBe(101);
    expect(byFather.state.people.get('familyLanguage', byFather.child)).toBe(1);
    const byMother = mixed(['mother', 'father'], 3, 3);
    expect(byMother.state.people.get('culture', byMother.child)).toBe(1);
    // Une règle qui ne transmet pas de nom laisse la culture de la mère.
    const none = mixed(['none', 'father'], 3, 3);
    expect(none.state.people.get('culture', none.child)).toBe(1);
    expect(none.state.people.get('familyName', none.child)).toBe(0);
    // Des parents d'une même culture la donnent, sans regarder le groupe.
    const state = founded(['father', 'father']);
    const mother = person(state);
    for (let index = 0; index < 5; index++) person(state, { culture: 2 });
    expect(birthCulture(state, mother, 1, 1, () => [])).toBe(1);
  });

  it('applique la règle « les deux » et le nom obtenu de la culture de l’enfant', () => {
    // « Les deux » : le nom du père, puis celui de la mère, chacun dans sa langue (D-11).
    const both = mixed(['father', 'both'], 1, 4);
    const { state, child, mother, father, name } = both;
    expect(state.people.get('culture', child)).toBe(2);
    expect(surname(name(child))).toBe(`${surname(name(father))} ${surname(name(mother))}`);
    // Un nom obtenu est propre à l'enfant, dans la langue de sa culture (A-12).
    const earned = mixed(['father', 'earned'], 1, 4);
    const code = earned.state.people.get('familyName', earned.child);
    expect(code).not.toBe(0);
    expect(code).not.toBe(101);
    expect(code).not.toBe(202);
    expect(earned.state.people.get('familyLanguage', earned.child)).toBe(2);
    expect(surname(earned.name(earned.child))).not.toBe('');
  });
});

describe('métissage (ESP-04)', () => {
  it('marie, plus rarement, des groupes voisins de cultures différentes', () => {
    // Une nordique et un homme des sables, chacun seul dans son groupe, de part et d'autre
    // de la couture est-ouest : ils finissent par se marier, et leurs enfants sont métis.
    const state = founded(['father', 'mother']);
    const width = state.size.width;
    Object.assign(state.society.groups.get(1) ?? missing(), { x: 1, homeX: 1 });
    Object.assign(state.society.groups.get(2) ?? missing(), { x: width - 2, homeX: width - 2 });
    const woman = person(state, { years: 18, ancestry: pureAncestry(0) });
    const man = person(state, {
      sex: MALE,
      years: 20,
      group: 2,
      culture: 2,
      ancestry: pureAncestry(2),
    });
    const eager = withHuman((species) => ({ ...immortal(species), pairing: 1 }));
    let married = -1;
    for (let month = 0; month < 10 * MONTHS_PER_YEAR; month++) {
      lifeCycle(state, eager);
      if (married < 0 && state.people.get('partner', woman) === idOf(state, man)) {
        married = month;
      }
      state.tick++;
    }
    // La probabilité de data/nomads.json : des mois d'attente, pas des années.
    expect(married).toBeGreaterThanOrEqual(0);
    expect(married).toBeLessThan(5 / testData.nomads.intermarriage);
    // À taille égale, la femme rejoint le groupe de l'homme.
    expect(state.people.get('group', woman)).toBe(2);
    expect(countChildren(state, idOf(state, woman))).toBeGreaterThan(0);
    state.people.forEach((slot) => {
      if (state.people.get('mother', slot) !== idOf(state, woman)) return;
      const shares = state.people.columns.ancestry;
      expect(shares[slot * ANCESTRY_SLOTS]).toBe(128);
      expect(shares[slot * ANCESTRY_SLOTS + 2]).toBe(127);
    });
  });

  it('ne marie pas deux groupes que sépare un détroit, de même culture ou non (3-nomades/P0)', () => {
    // Deux bandes d'eau, du pôle nord au pôle sud, font deux terres sans lien, pas même par
    // la couture. Une femme seule d'un côté, un homme seul de l'autre, à dix cases à vol
    // d'oiseau : de même culture ou non, ils ne se marient pas ; sans l'eau, si.
    const eager = withHuman((species) => ({ ...immortal(species), pairing: 1 }));
    const strait = flooded((x) => (x >= 108 && x <= 112) || (x >= 300 && x <= 305));
    for (const water of [true, false]) {
      for (const culture of [1, 2]) {
        const state = founded(['father', 'mother'], water ? strait : undefined);
        const first = state.society.groups.get(1) ?? missing();
        const second = state.society.groups.get(2) ?? missing();
        Object.assign(first, { x: 105, homeX: 105 });
        Object.assign(second, { x: 115, homeX: 115, culture });
        const woman = person(state, { years: 18 });
        const man = person(state, { sex: MALE, years: 20, group: 2, culture });
        let married = false;
        for (let month = 0; month < 5 * MONTHS_PER_YEAR && !married; month++) {
          lifeCycle(state, eager);
          married = state.people.get('partner', woman) === idOf(state, man);
          state.tick++;
        }
        expect({ water, culture, married }).toEqual({ water, culture, married: !water });
      }
    }
  });

  it('fait naître des métis de deux groupes voisins de sous-espèces différentes', () => {
    // Deux petits groupes à quelques cases : sans mariage entre cultures, ils n'auraient
    // de métis qu'en se réunissant, ce qui n'arrive pas ici.
    const state = flatState();
    step(
      state,
      [
        { type: 'spawnGroup', x: 40, y: 60, species: 'human', subspecies: 'nordic', count: 10 },
        { type: 'spawnGroup', x: 44, y: 62, species: 'human', subspecies: 'sands', count: 10 },
      ],
      testData,
    );
    run(state, 30 * MONTHS_PER_YEAR);
    expect(state.society.chronicle.filter((entry) => entry.kind === 'groupMerged')).toEqual([]);
    let metis = 0;
    const { people } = state;
    const archived = people.archive.columns.ancestry;
    const mixedAt = (shares: ArrayLike<number>, at: number) =>
      (shares[at] ?? 0) > 0 && (shares[at] ?? 0) < 255 ? 1 : 0;
    people.forEach((slot) => {
      metis += mixedAt(people.columns.ancestry, slot * ANCESTRY_SLOTS);
    });
    for (let row = 0; row < people.archive.rows; row++) {
      metis += mixedAt(archived, row * ANCESTRY_SLOTS);
    }
    expect(metis).toBeGreaterThan(0);
  });
});

/** Naissances de la partie, vivants et morts. */
function countBirths(state: SimState): number {
  let count = 0;
  state.people.forEach((slot) => {
    if (state.people.get('birth', slot) > 0) count++;
  });
  for (let row = 0; row < state.people.archive.rows; row++) {
    if ((state.people.archive.columns.birth[row] ?? 0) > 0) count++;
  }
  return count;
}

/** Enfants d'une mère, vivants ou morts. */
function countChildren(state: SimState, mother: number): number {
  let count = 0;
  state.people.forEach((slot) => {
    if (state.people.get('mother', slot) === mother) count++;
  });
  for (let row = 0; row < state.people.archive.rows; row++) {
    if (state.people.archive.columns.mother[row] === mother) count++;
  }
  return count;
}

function missing(): never {
  throw new Error('donnée de test absente');
}
