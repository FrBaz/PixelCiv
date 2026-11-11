/**
 * Cycle de vie (tâche 2.3 ; IND-04, ESP-03, SAI-03 ; C2, D2 ; ADR 0011).
 *
 * Chaque mois, pour chaque vivant, dans l'ordre des emplacements :
 * - la mort : un risque annuel de Siler, selon l'âge (enfance, risque de fond,
 *   vieillesse), auquel s'ajoutent le froid et la chaleur extrêmes, surtout pour les plus
 *   fragiles, et la faim ; l'adaptation de l'ascendance tempère le froid et la chaleur ;
 * - l'accouchement d'une grossesse arrivée à terme : l'enfant hérite des gènes et de
 *   l'ascendance de ses parents, et naît dans le groupe de sa mère. Il reçoit la culture
 *   de ses parents ; s'ils en ont deux, celle qui compte le plus de membres dans ce
 *   groupe ; à égalité, celle du parent qui transmet le nom de famille selon la règle de la
 *   culture de la mère (C2, D2). Son nom de famille suit ensuite la règle de sa culture. La
 *   mère meurt parfois en couches ; le nouveau-né court aussitôt le risque de son premier
 *   mois, puisqu'il ne sera parcouru que le mois suivant ;
 * - la conception, pour une femme en couple, en âge, nourrie, hors de l'allaitement.
 * Puis les célibataires en âge forment des couples, hors des proches parents. Un groupe
 * dont le dernier membre meurt s'éteint, et la chronique le note.
 *
 * Toutes les espèces sont décrites par data/species.json (ESP-03).
 */
import type { Species } from '../core/data';
import { exp } from '../core/dmath';
import type { RandomStream } from '../core/rng';
import { inheritGenome, mixAncestry } from './genetics';
import {
  ANCESTRY_SLOTS,
  FEMALE,
  GENOME_WORDS,
  MALE,
  NEVER,
  NONE,
  type DeathCause,
  type Population,
} from './population';
import { cellDistance, groupMembers } from './groups';
import { adaptationOf, cellTemperature, closeKin, monthOf, MONTHS_PER_YEAR } from './people';
import { inheritedFamilyName, type FamilyName } from './spawn';
import { cultureOf, type Group } from './society';
import type { SimState } from './state';
import type { SimContent } from './step';

/** Risques annuels de mort de Siler, par composante, à l'âge `years`. */
export interface Hazards {
  readonly infant: number;
  readonly background: number;
  readonly senescence: number;
}

export function silerHazards(species: Species, years: number): Hazards {
  const { infant, background, senescence } = species.mortality;
  return {
    infant: infant.level * exp(-infant.decay * years),
    background,
    senescence: senescence.level * exp(senescence.growth * years),
  };
}

/** Probabilité de mourir dans le mois, d'un risque annuel. */
export function monthlyProbability(hazard: number): number {
  return 1 - exp(-hazard / MONTHS_PER_YEAR);
}

/**
 * Fécondité relative d'une femme de `years` ans, de 0 à 1 : de `onset` au premier âge
 * fécond, elle croît jusqu'au sommet, reste entière sur la part `plateau` de la suite,
 * puis décline jusqu'à la fin de la période féconde (data/species.json).
 */
export function fertilityAt(species: Species, years: number): number {
  const { from, peak, to, onset, plateau } = species.fertility;
  if (years < from || years >= to) return 0;
  if (years < peak) return onset + ((1 - onset) * (years - from)) / (peak - from);
  const end = peak + plateau * (to - peak);
  if (years < end) return 1;
  return (to - years) / (to - end);
}

/** Morts de faim d'un groupe en un mois, au moins, pour que la chronique parle de famine. */
const FAMINE_DEATHS = 2;

/** Tables par âge en mois : composantes de Siler, et probabilité mensuelle sans rigueur. */
interface MortalityTable {
  readonly infant: Float64Array;
  readonly background: number;
  readonly senescence: Float64Array;
  readonly base: Float64Array;
}

const tables = new WeakMap<Species, MortalityTable>();

function mortalityTable(species: Species): MortalityTable {
  let table = tables.get(species);
  if (table !== undefined) return table;
  const months = Math.ceil(species.longevity * MONTHS_PER_YEAR) + 1;
  const infant = new Float64Array(months);
  const senescence = new Float64Array(months);
  const base = new Float64Array(months);
  for (let age = 0; age < months; age++) {
    const hazards = silerHazards(species, age / MONTHS_PER_YEAR);
    infant[age] = hazards.infant;
    senescence[age] = hazards.senescence;
    base[age] = monthlyProbability(hazards.infant + hazards.background + hazards.senescence);
  }
  table = { infant, background: species.mortality.background, senescence, base };
  tables.set(species, table);
  return table;
}

/** Ce qui menace un individu ce mois-ci, en plus de son âge. */
export interface Hardship {
  cold: number;
  heat: number;
  famine: number;
}

/**
 * Rigueurs du mois pour l'emplacement `slot`, écrites dans `out` : le froid et la chaleur,
 * hors du confort de l'espèce (`hardship.comfort` et `hardship.extremes` ; NaN : pas de
 * climat connu), surtout pour les plus fragiles, et la faim.
 */
function hardshipInto(
  species: Species,
  people: Population,
  slot: number,
  years: number,
  temperature: number,
  out: Hardship,
): void {
  const { hardship } = species;
  const nutrition = (people.columns.nutrition[slot] ?? 0) / 255;
  out.famine = nutrition < 1 ? hardship.famine * (1 - nutrition) * (1 - nutrition) : 0;
  const [mild, warm] = hardship.comfort;
  if (Number.isNaN(temperature) || (temperature >= mild && temperature <= warm)) {
    out.cold = 0;
    out.heat = 0;
    return;
  }
  const frail = years < hardship.frail[0] || years >= hardship.frail[1] ? 1 : hardship.adults;
  const adaptation = adaptationOf(people, slot, species);
  const [coldest, hottest] = hardship.extremes;
  const cold = Math.min(1, Math.max(0, (mild - temperature) / (mild - coldest)));
  const heat = Math.min(1, Math.max(0, (temperature - warm) / (hottest - warm)));
  out.cold = frail * hardship.cold * cold * (1 - adaptation.cold);
  out.heat = frail * hardship.heat * heat * (1 - adaptation.heat);
}

/**
 * Cause d'une mort à `years` ans, tirée selon la part de chaque risque ; `orphan`
 * multiplie le risque d'enfance. La sénescence ne tue « de vieillesse » qu'à partir de
 * l'âge des vieux (`hardship.frail[1]`) : avant, ses morts comptent parmi les maladies.
 */
export function causeOf(
  species: Species,
  years: number,
  hazards: Hazards,
  hardship: Hardship,
  orphan: number,
  random: RandomStream,
): DeathCause {
  const { diseaseShare } = species.mortality;
  const old = years >= species.hardship.frail[1];
  const causes: [DeathCause, number][] = [
    [
      'disease',
      hazards.infant * orphan + hazards.background * diseaseShare + (old ? 0 : hazards.senescence),
    ],
    ['accident', hazards.background * (1 - diseaseShare)],
    ['natural', old ? hazards.senescence : 0],
    ['cold', hardship.cold],
    ['heat', hardship.heat],
    ['famine', hardship.famine],
  ];
  let target = random.nextFloat() * causes.reduce((sum, [, weight]) => sum + weight, 0);
  // Un arrondi au bout de la liste revient à la dernière cause possible.
  let last: DeathCause = old ? 'natural' : 'disease';
  for (const [cause, weight] of causes) {
    if (weight <= 0) continue;
    last = cause;
    target -= weight;
    if (target < 0) return cause;
  }
  return last;
}

/** Gènes, ascendance, culture et nom de famille d'un individu, vivant ou archivé. */
function heredityOf(people: Population, id: number) {
  const slot = people.slotOf(id);
  if (slot !== undefined) {
    return {
      genome: people.columns.genome,
      offset: slot * GENOME_WORDS,
      ancestry: people.columns.ancestry,
      ancestryOffset: slot * ANCESTRY_SLOTS,
      culture: people.get('culture', slot),
      family: {
        code: people.get('familyName', slot),
        language: people.get('familyLanguage', slot),
      } satisfies FamilyName,
    };
  }
  const row = people.archivedRow(id);
  if (row === undefined) return undefined;
  const { columns } = people.archive;
  return {
    genome: columns.genome,
    offset: row * GENOME_WORDS,
    ancestry: columns.ancestry,
    ancestryOffset: row * ANCESTRY_SLOTS,
    culture: columns.culture[row] ?? 0,
    family: {
      code: columns.familyName[row] ?? 0,
      language: columns.familyLanguage[row] ?? 0,
    } satisfies FamilyName,
  };
}

/**
 * Culture d'un enfant (C2, D2) : celle de ses parents s'ils la partagent ; sinon, des
 * deux, celle qui compte le plus de membres dans son groupe de naissance, celui de sa mère
 * (emplacement `mother`), parmi les vivants nés avant ce mois ; à égalité, celle du parent
 * qui transmet le nom de famille selon la règle de la culture de la mère, et celle de la
 * mère si cette règle n'en transmet aucun. `membersOf` donne au moins tous les membres d'un
 * groupe ; on ne le consulte que pour des parents de deux cultures.
 */
export function birthCulture(
  state: SimState,
  mother: number,
  maternal: number,
  paternal: number,
  membersOf: (group: number) => readonly number[],
): number {
  if (maternal === paternal) return maternal;
  const { people, tick } = state;
  const group = people.get('group', mother);
  const { alive } = people;
  const { group: groups, culture: cultures, birth } = people.columns;
  // Membres de la culture de la mère, moins ceux de la culture du père.
  let balance = 0;
  for (const slot of membersOf(group)) {
    if (alive[slot] !== 1 || groups[slot] !== group || (birth[slot] ?? tick) >= tick) continue;
    const culture = cultures[slot];
    if (culture === maternal) balance++;
    else if (culture === paternal) balance--;
  }
  if (balance !== 0) return balance > 0 ? maternal : paternal;
  const rule = cultureOf(state.society, maternal)?.naming;
  return rule === 'father' || rule === 'both' ? paternal : maternal;
}

/**
 * Accouchement de la mère de l'emplacement `mother` : l'emplacement de l'enfant, et vrai
 * si elle y survit.
 */
function giveBirth(
  state: SimState,
  content: SimContent,
  mother: number,
  random: RandomStream,
  membersOf: (group: number) => readonly number[],
): { readonly child: number | undefined; readonly survived: boolean } {
  const { people, tick } = state;
  const maternal = heredityOf(people, people.get('id', mother));
  const paternal = heredityOf(people, people.get('pregnantBy', mother)) ?? maternal;
  if (maternal === undefined || paternal === undefined) return { child: undefined, survived: true };
  const genome = new Uint32Array(GENOME_WORDS);
  inheritGenome(
    content.genetics,
    maternal.genome,
    maternal.offset,
    paternal.genome,
    paternal.offset,
    random,
    genome,
  );
  const ancestry = new Uint8Array(ANCESTRY_SLOTS);
  mixAncestry(
    maternal.ancestry,
    maternal.ancestryOffset,
    paternal.ancestry,
    paternal.ancestryOffset,
    ancestry,
  );
  const culture = birthCulture(state, mother, maternal.culture, paternal.culture, membersOf);
  const own = cultureOf(state.society, culture);
  const sex = random.nextInt(2) === 0 ? FEMALE : MALE;
  const givenName = random.nextUint32();
  const family = inheritedFamilyName(
    own?.naming ?? 'father',
    maternal.family,
    paternal.family,
    own?.language ?? 0,
    random,
  );
  const child = people.add({
    sex,
    birth: tick,
    species: people.get('species', mother),
    ancestry,
    genome,
    mother: people.get('id', mother),
    father: people.get('pregnantBy', mother),
    group: people.get('group', mother),
    culture,
    givenName,
    familyName: family.code,
    familyLanguage: family.language,
  });
  people.set('lastBirth', mother, tick);
  people.set('conceived', mother, NEVER);
  people.set('pregnantBy', mother, NONE);
  const species = content.species.entries.at(people.get('species', mother));
  const survived = species === undefined || random.nextFloat() >= species.fertility.childbirthDeath;
  return { child, survived };
}

/** Emplacements des vivants du début du mois, dans un tampon réutilisé. */
let livingScratch = new Int32Array(1024);

function livingSlots(people: Population): Int32Array {
  if (livingScratch.length < people.count) livingScratch = new Int32Array(people.count * 2);
  const { alive, end } = people;
  let count = 0;
  for (let slot = 0; slot < end; slot++) if (alive[slot] === 1) livingScratch[count++] = slot;
  return livingScratch.subarray(0, count);
}

/**
 * Fait vivre la population un mois. `members` donne les membres de chaque groupe au début
 * du mois, tels que les donne groupMembers ; on les dresse au besoin.
 */
export function lifeCycle(
  state: SimState,
  content: SimContent,
  members?: ReadonlyMap<number, readonly number[]>,
): void {
  const { people, society, tick } = state;
  let lists = members;
  const membersOf = (group: number): readonly number[] => {
    lists ??= groupMembers(people);
    return lists.get(group) ?? [];
  };
  const month = monthOf(tick);
  const deaths = state.rng.stream('sim.deaths');
  const births = state.rng.stream('sim.births');
  // Température du mois sur la case de chaque groupe, par identifiant ; NaN hors groupe.
  const groupCount = society.nextGroupId;
  const climate = new Float64Array(groupCount).fill(Number.NaN);
  for (const group of society.groups.values()) {
    climate[group.id] = cellTemperature(state.world, state.size, group.x, group.y, month);
  }
  const famine = new Int32Array(groupCount);
  const species = content.species.entries;
  const mortality = species.map((entry) => mortalityTable(entry));
  const hardship: Hardship = { cold: 0, heat: 0, famine: 0 };

  // Les vivants du début du mois, puis les nouveau-nés du mois, qui n'y courent que le
  // risque de leur premier mois : on ne les parcourra que le mois prochain. Une naissance
  // peut agrandir les colonnes : on les relit après chacune.
  const living = livingSlots(people);
  const newborns: number[] = [];
  let columns = people.columns;
  for (let index = 0; index < living.length + newborns.length; index++) {
    const slot =
      index < living.length ? (living[index] ?? 0) : (newborns[index - living.length] ?? 0);
    if (people.alive[slot] !== 1) continue;
    const kind = columns.species[slot] ?? 0;
    const entry = species.at(kind);
    const table = mortality.at(kind);
    if (entry === undefined || table === undefined) continue;
    const age = tick - (columns.birth[slot] ?? 0);
    const years = age / MONTHS_PER_YEAR;
    const group = columns.group[slot] ?? NONE;

    // Mort.
    if (age >= table.base.length - 1) {
      people.remove(slot, tick, 'natural');
      continue;
    }
    hardshipInto(entry, people, slot, years, climate[group] ?? Number.NaN, hardship);
    const { orphan: dependence } = entry.mortality;
    const orphan =
      age < dependence.months && people.slotOf(columns.mother[slot] ?? NONE) === undefined
        ? dependence.factor
        : 1;
    const extra = hardship.cold + hardship.heat + hardship.famine;
    const ageIndex = Math.max(0, age);
    const infant = table.infant[ageIndex] ?? 0;
    const senescence = table.senescence[ageIndex] ?? 0;
    const probability =
      extra === 0 && orphan === 1
        ? (table.base[ageIndex] ?? 0)
        : monthlyProbability(infant * orphan + table.background + senescence + extra);
    if (deaths.nextFloat() < probability) {
      const hazards = { infant, background: table.background, senescence };
      const cause = causeOf(entry, years, hazards, hardship, orphan, deaths);
      if (cause === 'famine') famine[group] = (famine[group] ?? 0) + 1;
      people.remove(slot, tick, cause);
      continue;
    }
    if (index >= living.length) continue;

    if (columns.sex[slot] !== FEMALE) continue;
    // Accouchement d'une grossesse arrivée à terme ; l'enfant d'une mère morte en couches
    // court son premier mois en orphelin.
    const conceived = columns.conceived[slot] ?? NEVER;
    if (conceived !== NEVER && tick - conceived >= entry.fertility.gestation) {
      const { child, survived } = giveBirth(state, content, slot, births, membersOf);
      columns = people.columns;
      if (child !== undefined) newborns.push(child);
      if (!survived) {
        people.remove(slot, tick, 'childbirth');
        continue;
      }
    }
    // Conception.
    const partner = people.slotOf(columns.partner[slot] ?? NONE);
    if (partner === undefined || columns.conceived[slot] !== NEVER) continue;
    const lastBirth = columns.lastBirth[slot] ?? NEVER;
    if (lastBirth !== NEVER && tick - lastBirth < entry.fertility.postpartum) continue;
    if ((tick - (columns.birth[partner] ?? 0)) / MONTHS_PER_YEAR >= entry.fertility.maleTo) {
      continue;
    }
    const nutrition = (columns.nutrition[slot] ?? 0) / 255;
    const chance = entry.fertility.monthly * fertilityAt(entry, years) * nutrition * nutrition;
    if (chance > 0 && births.nextFloat() < chance) {
      columns.conceived[slot] = tick;
      columns.pregnantBy[slot] = columns.id[partner] ?? NONE;
    }
  }

  formCouples(state, content);

  // Groupes éteints, et famines de la chronique.
  const sizes = new Int32Array(groupCount);
  const { alive, end } = people;
  const groups = people.columns.group;
  for (let slot = 0; slot < end; slot++) {
    if (alive[slot] !== 1) continue;
    const group = groups[slot] ?? NONE;
    sizes[group] = (sizes[group] ?? 0) + 1;
  }
  for (const group of [...society.groups.values()]) {
    const lost = famine[group.id] ?? 0;
    const entry = {
      tick,
      x: group.x,
      y: group.y,
      group: group.id,
      other: NONE,
      leader: group.leader,
      otherLeader: NONE,
    };
    if (lost >= FAMINE_DEATHS) society.chronicle.push({ ...entry, kind: 'famine', count: lost });
    if ((sizes[group.id] ?? 0) === 0) {
      society.chronicle.push({ ...entry, kind: 'groupExtinct', count: 0 });
      society.groups.delete(group.id);
    }
  }
}

/**
 * Couples : chaque célibataire en âge trouve, avec une probabilité mensuelle, un conjoint
 * célibataire de l'autre sexe, d'un âge proche, qui n'est pas un proche parent : dans son
 * groupe d'abord, sinon dans un groupe voisin de sa culture, et à défaut, avec une
 * probabilité moindre (nomads.intermarriage), dans un groupe voisin d'une autre culture :
 * c'est le métissage (ESP-04). L'un des deux rejoint alors l'autre avec ses enfants (les
 * bandes échangent leurs conjoints) : le conjoint du plus petit des deux groupes rejoint
 * le plus grand ; à taille égale, la femme rejoint l'homme.
 */
function formCouples(state: SimState, content: SimContent): void {
  const { people, tick, society } = state;
  const random = state.rng.stream('sim.couples');
  const women = new Map<number, number[]>();
  const men = new Map<number, number[]>();
  // Nombre de membres de chaque groupe.
  const sizes = new Int32Array(society.nextGroupId);
  const { alive, end } = people;
  const columns = people.columns;
  const entries = content.species.entries;
  for (let slot = 0; slot < end; slot++) {
    if (alive[slot] !== 1) continue;
    const group = columns.group[slot] ?? NONE;
    sizes[group] = (sizes[group] ?? 0) + 1;
    if (group === NONE || columns.partner[slot] !== NONE) continue;
    const species = entries.at(columns.species[slot] ?? 0);
    const years = (tick - (columns.birth[slot] ?? 0)) / MONTHS_PER_YEAR;
    if (species === undefined || years < species.couple.minAge) continue;
    const lists = columns.sex[slot] === FEMALE ? women : men;
    const list = lists.get(group);
    if (list === undefined) lists.set(group, [slot]);
    else list.push(slot);
  }
  const compatibleMen = (woman: number, candidates: readonly number[]) => {
    const species = entries.at(columns.species[woman] ?? 0);
    const gap = (species?.couple.maxGap ?? 0) * MONTHS_PER_YEAR;
    const age = people.age(woman, tick);
    return candidates.filter(
      (man) =>
        people.get('partner', man) === NONE &&
        people.get('species', man) === people.get('species', woman) &&
        Math.abs(people.age(man, tick) - age) <= gap &&
        !closeKin(people, woman, man),
    );
  };
  const marry = (woman: number, man: number) => {
    people.set('partner', woman, people.get('id', man));
    people.set('partner', man, people.get('id', woman));
  };
  const unmatched: number[] = [];
  for (const [group, list] of women) {
    const candidates = men.get(group) ?? [];
    for (const woman of list) {
      const species = entries.at(columns.species[woman] ?? 0);
      if (species === undefined || random.nextFloat() >= species.pairing) continue;
      const man = random.pickOrUndefined(compatibleMen(woman, candidates));
      if (man === undefined) unmatched.push(woman);
      else marry(woman, man);
    }
  }
  if (unmatched.length === 0) return;
  // Dans un groupe voisin de la même culture : les groupes de chaque culture, dans
  // l'ordre où leurs célibataires ont été comptés.
  const byCulture = new Map<number, number[]>();
  for (const group of men.keys()) {
    const other = society.groups.get(group);
    if (other === undefined) continue;
    const list = byCulture.get(other.culture);
    if (list === undefined) byCulture.set(other.culture, [group]);
    else list.push(group);
  }
  const { marriage: distance, intermarriage } = content.nomads;
  const { width, height } = state.size;
  const near = (home: Group, other: Group | undefined): other is Group =>
    other !== undefined &&
    other.id !== home.id &&
    cellDistance(width, home.x, home.y, other.x, other.y) <= distance;
  // Les groupes où des hommes sont à marier, rangés en carrés d'au moins `distance` cases
  // de côté, dressés au premier besoin : un groupe voisin d'un autre est dans son carré ou
  // dans l'un des huit autour, la dernière colonne touchant la première (couture).
  const across = Math.max(1, Math.floor(width / Math.max(1, distance)));
  const down = Math.max(1, Math.floor(height / Math.max(1, distance)));
  let squares: Map<number, number[]> | undefined;
  const foreignMen = (home: Group): number[] => {
    const square = (group: Group) =>
      Math.floor((group.y * down) / height) * across + Math.floor((group.x * across) / width);
    if (squares === undefined) {
      squares = new Map();
      for (const id of men.keys()) {
        const other = society.groups.get(id);
        if (other === undefined) continue;
        const list = squares.get(square(other));
        if (list === undefined) squares.set(square(other), [id]);
        else list.push(id);
      }
    }
    const found: number[] = [];
    const row = Math.floor((home.y * down) / height);
    const column = Math.floor((home.x * across) / width);
    const around = [...new Set([column - 1, column, column + 1].map((c) => (c + across) % across))];
    for (let r = Math.max(0, row - 1); r <= Math.min(down - 1, row + 1); r++) {
      for (const c of around) {
        for (const id of squares.get(r * across + c) ?? []) {
          const other = society.groups.get(id);
          if (near(home, other) && other.culture !== home.culture)
            found.push(...(men.get(id) ?? []));
        }
      }
    }
    return found;
  };
  // Membres de chaque groupe, de quoi retrouver les enfants de qui change de groupe sans
  // parcourir toute la population ; on le dresse au premier changement.
  let inGroup: Map<number, number[]> | undefined;
  for (const woman of unmatched) {
    const home = society.groups.get(people.get('group', woman));
    if (home === undefined) continue;
    const candidates: number[] = [];
    for (const group of byCulture.get(home.culture) ?? []) {
      if (near(home, society.groups.get(group))) candidates.push(...(men.get(group) ?? []));
    }
    let man = random.pickOrUndefined(compatibleMen(woman, candidates));
    if (man === undefined && random.nextFloat() < intermarriage) {
      // Faute de conjoint de sa culture alentour, un groupe voisin d'une autre culture.
      man = random.pickOrUndefined(compatibleMen(woman, foreignMen(home)));
    }
    if (man === undefined) continue;
    marry(woman, man);
    const womanGroup = people.get('group', woman);
    const manGroup = people.get('group', man);
    inGroup ??= groupMembers(people);
    if ((sizes[womanGroup] ?? 0) > (sizes[manGroup] ?? 0)) {
      joinGroup(people, man, womanGroup, tick, content, inGroup);
    } else {
      joinGroup(people, woman, manGroup, tick, content, inGroup);
    }
  }
}

/**
 * Fait passer un individu dans le groupe `group`, avec ses enfants qui vivaient avec lui.
 * `inGroup` donne, pour chaque groupe, au moins tous ses membres : il se tient à jour.
 */
function joinGroup(
  people: Population,
  slot: number,
  group: number,
  tick: number,
  content: SimContent,
  inGroup: Map<number, number[]>,
): void {
  const id = people.get('id', slot);
  const from = people.get('group', slot);
  const moved: number[] = [];
  for (const other of inGroup.get(from) ?? []) {
    if (people.alive[other] !== 1 || people.get('group', other) !== from) continue;
    if (people.get('mother', other) !== id && people.get('father', other) !== id) continue;
    const species = content.species.entries.at(people.get('species', other));
    if (species === undefined || people.age(other, tick) >= species.maturity * MONTHS_PER_YEAR) {
      continue;
    }
    moved.push(other);
  }
  moved.push(slot);
  for (const other of moved) people.set('group', other, group);
  const list = inGroup.get(group);
  if (list === undefined) inGroup.set(group, moved);
  else list.push(...moved);
}
