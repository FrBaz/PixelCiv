/**
 * Cycle de vie (tâche 2.3 ; IND-04, ESP-03, SAI-03 ; ADR 0011).
 *
 * Chaque mois, pour chaque vivant, dans l'ordre des emplacements :
 * - la mort : un risque annuel de Siler, selon l'âge (enfance, risque de fond,
 *   vieillesse), auquel s'ajoutent le froid et la chaleur extrêmes, surtout pour les plus
 *   fragiles, et la faim ; l'adaptation de l'ascendance tempère le froid et la chaleur ;
 * - l'accouchement d'une grossesse arrivée à terme : l'enfant hérite des gènes et de
 *   l'ascendance de ses parents, du nom de famille selon la règle de sa culture, de la
 *   culture et du groupe de sa mère ; la mère meurt parfois en couches ;
 * - la conception, pour une femme en couple, en âge, nourrie, hors de l'allaitement.
 * Puis les célibataires en âge forment des couples dans leur groupe, hors des proches
 * parents. Un groupe dont le dernier membre meurt s'éteint, et la chronique le note.
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
import { inheritedFamilyName } from './spawn';
import { cultureOf } from './society';
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
 * Fécondité relative d'une femme de `years` ans, de 0 à 1 : elle croît jusqu'au sommet,
 * reste haute, puis décline jusqu'à la fin de la période féconde.
 */
export function fertilityAt(species: Species, years: number): number {
  const { from, peak, to } = species.fertility;
  if (years < from || years >= to) return 0;
  if (years < peak) return 0.4 + (0.6 * (years - from)) / (peak - from);
  const plateau = peak + 0.4 * (to - peak);
  if (years < plateau) return 1;
  return (to - years) / (to - plateau);
}

/** Part de la mortalité de fond due aux maladies ; le reste, aux accidents. */
const DISEASE_SHARE = 0.6;
/** Le risque d'un nourrisson orphelin de mère, multiplié. */
const ORPHAN_FACTOR = 2.5;
/** Âge en deçà duquel un enfant dépend de sa mère, en mois. */
const NURSLING = 24;
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
interface Hardship {
  cold: number;
  heat: number;
  famine: number;
}

/**
 * Rigueurs du mois pour l'emplacement `slot`, écrites dans `out` : le froid et la chaleur
 * extrêmes (NaN : pas de climat connu), surtout pour les plus fragiles, et la faim.
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
  if (Number.isNaN(temperature) || (temperature >= 0 && temperature <= 30)) {
    out.cold = 0;
    out.heat = 0;
    return;
  }
  const frail = years < hardship.frail[0] || years >= hardship.frail[1] ? 1 : hardship.adults;
  const adaptation = adaptationOf(people, slot, species);
  const cold = Math.min(1, Math.max(0, -temperature / 20));
  const heat = Math.min(1, Math.max(0, (temperature - 30) / 10));
  out.cold = frail * hardship.cold * cold * (1 - adaptation.cold);
  out.heat = frail * hardship.heat * heat * (1 - adaptation.heat);
}

/** Cause d'une mort, tirée selon la part de chaque risque. */
function causeOf(
  hazards: Hazards,
  hardship: Hardship,
  orphan: number,
  random: RandomStream,
): DeathCause {
  const causes: [DeathCause, number][] = [
    ['disease', hazards.infant * orphan + hazards.background * DISEASE_SHARE],
    ['accident', hazards.background * (1 - DISEASE_SHARE)],
    ['natural', hazards.senescence],
    ['cold', hardship.cold],
    ['heat', hardship.heat],
    ['famine', hardship.famine],
  ];
  let target = random.nextFloat() * causes.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [cause, weight] of causes) {
    target -= weight;
    if (target < 0) return cause;
  }
  return 'natural';
}

/** Gènes, ascendance et nom de famille d'un individu, vivant ou archivé. */
function heredityOf(people: Population, id: number) {
  const slot = people.slotOf(id);
  if (slot !== undefined) {
    return {
      genome: people.columns.genome,
      offset: slot * GENOME_WORDS,
      ancestry: people.columns.ancestry,
      ancestryOffset: slot * ANCESTRY_SLOTS,
      familyName: people.get('familyName', slot),
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
    familyName: columns.familyName[row] ?? 0,
  };
}

/** Accouchement de la mère de l'emplacement `mother` ; vrai si elle y survit. */
function giveBirth(
  state: SimState,
  content: SimContent,
  mother: number,
  random: RandomStream,
): boolean {
  const { people, tick } = state;
  const maternal = heredityOf(people, people.get('id', mother));
  const paternal = heredityOf(people, people.get('pregnantBy', mother)) ?? maternal;
  if (maternal === undefined || paternal === undefined) return true;
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
  const culture = people.get('culture', mother);
  const naming = cultureOf(state.society, culture)?.naming ?? 'father';
  people.add({
    sex: random.nextInt(2) === 0 ? FEMALE : MALE,
    birth: tick,
    species: people.get('species', mother),
    ancestry,
    genome,
    mother: people.get('id', mother),
    father: people.get('pregnantBy', mother),
    group: people.get('group', mother),
    culture,
    givenName: random.nextUint32(),
    familyName: inheritedFamilyName(naming, maternal.familyName, paternal.familyName),
  });
  people.set('lastBirth', mother, tick);
  people.set('conceived', mother, NEVER);
  people.set('pregnantBy', mother, NONE);
  const species = content.species.entries.at(people.get('species', mother));
  return species === undefined || random.nextFloat() >= species.fertility.childbirthDeath;
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

/** Fait vivre la population un mois. */
export function lifeCycle(state: SimState, content: SimContent): void {
  const { people, society, tick } = state;
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

  // Les vivants du début du mois : les nouveau-nés attendront le mois prochain. Une
  // naissance peut agrandir les colonnes : on les relit après chacune.
  const living = livingSlots(people);
  let columns = people.columns;
  for (const slot of living) {
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
    const orphan =
      age < NURSLING && people.slotOf(columns.mother[slot] ?? NONE) === undefined
        ? ORPHAN_FACTOR
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
      const cause = causeOf(hazards, hardship, orphan, deaths);
      if (cause === 'famine') famine[group] = (famine[group] ?? 0) + 1;
      people.remove(slot, tick, cause);
      continue;
    }

    if (columns.sex[slot] !== FEMALE) continue;
    // Accouchement d'une grossesse arrivée à terme.
    const conceived = columns.conceived[slot] ?? NEVER;
    if (conceived !== NEVER && tick - conceived >= entry.fertility.gestation) {
      const survived = giveBirth(state, content, slot, births);
      columns = people.columns;
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
  const members = new Int32Array(groupCount);
  const { alive, end } = people;
  const groups = people.columns.group;
  for (let slot = 0; slot < end; slot++) {
    if (alive[slot] !== 1) continue;
    const group = groups[slot] ?? NONE;
    members[group] = (members[group] ?? 0) + 1;
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
    if ((members[group.id] ?? 0) === 0) {
      society.chronicle.push({ ...entry, kind: 'groupExtinct', count: 0 });
      society.groups.delete(group.id);
    }
  }
}

/**
 * Couples : chaque célibataire en âge trouve, avec une probabilité mensuelle, un conjoint
 * célibataire de l'autre sexe, d'un âge proche, qui n'est pas un proche parent : dans son
 * groupe d'abord, sinon dans un groupe voisin de sa culture, que l'un des deux rejoint
 * avec ses enfants (les bandes échangent leurs conjoints). Le conjoint du plus petit des
 * deux groupes rejoint le plus grand ; à taille égale, la femme rejoint l'homme.
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
  const distance = content.nomads.marriage;
  // Membres de chaque groupe, de quoi retrouver les enfants de qui change de groupe sans
  // parcourir toute la population ; on le dresse au premier changement.
  let inGroup: Map<number, number[]> | undefined;
  for (const woman of unmatched) {
    const home = society.groups.get(people.get('group', woman));
    if (home === undefined) continue;
    const candidates: number[] = [];
    for (const group of byCulture.get(home.culture) ?? []) {
      const other = society.groups.get(group);
      if (other === undefined || other.id === home.id) continue;
      if (cellDistance(state.size.width, home.x, home.y, other.x, other.y) > distance) continue;
      candidates.push(...(men.get(group) ?? []));
    }
    const man = random.pickOrUndefined(compatibleMen(woman, candidates));
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
