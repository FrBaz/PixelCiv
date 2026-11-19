/**
 * Ce que le fil principal voit de la population (tâches 2.9 et 2.10 ; IHM-02, CHR-01,
 * REN-04) : fiches d'un individu et d'un groupe, faits de la chronique, et l'image des
 * groupes de la carte avec un code d'apparence par membre.
 *
 * Les noms se forment ici, dans le worker, d'après la langue de chaque culture : le fil
 * principal reçoit des textes prêts, que la traduction n'a pas à toucher. La classe d'âge
 * et le grisonnement viennent des âges de l'espèce de chacun (src/core/life.ts), les mêmes
 * pour la fiche et pour le mini-sprite.
 */
import {
  CHRONICLE_PAGE,
  GROUP_STRIDE,
  NO_CARRIER,
  type ChronicleView,
  type GroupsFrame,
  type GroupSummary,
  type GroupView,
  type InspectTarget,
  type Intention,
  type LegArrays,
  type PersonSummary,
  type PersonView,
} from '../core/protocol';
import { freshArrays, type Allocator } from '../core/buffers';
import { dayIndex } from '../core/time';
import { geneRoles } from '../core/data/people';
import { ageClass, greyLevel, lifeTable, type LifeAges } from '../core/life';
import { AGE_CODE, SKIN_TONES, visualCode, type AgeClass } from '../core/visual';
import { expressed, trait } from './genetics';
import { groupMembers } from './groups';
import { centralMember, curveAt } from './movement';
import {
  CARRIED,
  DEATH_CAUSES,
  GENOME_WORDS,
  INTENTION,
  LEAVE,
  NEVER,
  NONE,
  WALK,
  type Population,
} from './population';
import { MONTHS_PER_YEAR } from './people';
import { childrenOf, field, heredity, personName, recordOf, type PersonRecord } from './records';
import { cultureOf, type ChronicleEntry } from './society';
import type { SimState } from './state';
import type { SimContent } from './step';
import { TEMPER_MAX } from './temper';

/** Âge exact, en années, d'un vivant aujourd'hui ou d'un mort à sa mort. */
function yearsOf(state: SimState, record: PersonRecord): number {
  const birth = field(state.people, record, 'birth');
  const end = record.alive
    ? state.tick
    : (state.people.archive.columns.death[record.index] ?? state.tick);
  return Math.max(0, end - birth) / MONTHS_PER_YEAR;
}

/**
 * Classe d'âge à `years` ans selon les âges de l'espèce ; adulte pour une espèce inconnue,
 * ce que l'apparition et la relecture d'une sauvegarde empêchent.
 */
function stageOf(species: LifeAges | undefined, years: number): AgeClass {
  return species === undefined ? 'adult' : ageClass(species, years);
}

function summary(state: SimState, content: SimContent, id: number): PersonSummary | undefined {
  const record = recordOf(state.people, id);
  if (record === undefined) return undefined;
  const years = yearsOf(state, record);
  const species = content.species.entries.at(field(state.people, record, 'species'));
  return {
    id,
    name: personName(state.people, state.society, id),
    sex: field(state.people, record, 'sex'),
    age: Math.floor(years),
    stage: stageOf(species, years),
    alive: record.alive,
  };
}

/** Nom d'un groupe : celui de son meneur. */
export function groupName(state: SimState, leader: number): string {
  return personName(state.people, state.society, leader).split(' ')[0] ?? '';
}

/**
 * Un groupe en quelques mots, à la case où il se tient ce jour-là : celle de son membre le
 * plus proche du barycentre de ses membres, aux positions du jour (ADR 0014), la règle du
 * lieu des groupes du pas mensuel ; sa case du pas mensuel s'il n'a personne qui marche.
 */
function groupSummary(
  state: SimState,
  id: number,
  members: readonly number[],
): GroupSummary | undefined {
  const group = state.society.groups.get(id);
  if (group === undefined) return undefined;
  const cell = centralMember(state, members);
  const { width } = state.size;
  const x = cell < 0 ? group.x : cell % width;
  const y = cell < 0 ? group.y : (cell - x) / width;
  return { id, name: groupName(state, group.leader), x, y, size: members.length };
}

/** Intention d'un vivant, pour sa fiche. */
function intentionOf(state: SimState, slot: number): Intention {
  switch (state.people.get('move', slot) & INTENTION) {
    case LEAVE:
      return 'leave';
    case WALK:
      return 'walk';
    case CARRIED:
      return 'carried';
    default:
      return 'rest';
  }
}

/** Fiche d'un individu, vivant ou mort. */
export function personView(
  state: SimState,
  content: SimContent,
  id: number,
): PersonView | undefined {
  const { people } = state;
  const record = recordOf(people, id);
  const base = summary(state, content, id);
  if (record === undefined || base === undefined) return undefined;
  const species = content.species.entries.at(field(people, record, 'species'));
  const { genome, ancestry } = heredity(people, record);
  const { genetics } = content;
  const roles = geneRoles(genetics);
  const loci = genetics.loci.map((locus, index) => ({
    locus: locus.id,
    allele: locus.alleles.at(expressed(genetics, genome, 0, index))?.id ?? '',
  }));
  const traits = genetics.traits.map((entry, index) => ({
    trait: entry.id,
    value: trait(genome, 0, index),
  }));
  const [short, tall] = species?.height ?? [0, 0];
  const height = Math.round(short + (tall - short) * trait(genome, 0, roles.traits.height));
  const shares = ancestry
    .map((share, index) => ({
      subspecies: species?.subspecies.at(index)?.id ?? '',
      share: share / 255,
    }))
    .filter((entry) => entry.share > 0 && entry.subspecies !== '')
    .sort((a, b) => b.share - a.share);
  const mother = field(people, record, 'mother');
  const father = field(people, record, 'father');
  const siblings = new Set<number>();
  for (const parent of [mother, father]) {
    if (parent === NONE) continue;
    for (const child of childrenOf(people, parent)) if (child !== id) siblings.add(child);
  }
  const list = (ids: Iterable<number>) =>
    [...ids].flatMap((other) => {
      const found = summary(state, content, other);
      return found === undefined ? [] : [found];
    });
  const groupId = field(people, record, 'group');
  const groupList = groupMembers(people).get(groupId) ?? [];
  const death = record.alive ? undefined : people.archive.columns.death[record.index];
  const cause = record.alive
    ? undefined
    : DEATH_CAUSES[people.archive.columns.cause[record.index] ?? 0];
  return {
    ...base,
    birth: field(people, record, 'birth'),
    ...(death === undefined ? {} : { death }),
    ...(cause === undefined ? {} : { cause }),
    species: species?.id ?? '',
    culture: field(people, record, 'culture'),
    ancestry: shares,
    genome,
    loci,
    traits,
    height,
    gregariousness: field(people, record, 'gregariousness') / TEMPER_MAX,
    grey: species === undefined ? 0 : greyLevel(species, yearsOf(state, record)),
    nutrition: record.alive ? people.get('nutrition', record.index) / 255 : 0,
    pregnant: record.alive && people.get('conceived', record.index) !== NEVER,
    ...(record.alive ? { intention: intentionOf(state, record.index) } : {}),
    ...optional('mother', summary(state, content, mother)),
    ...optional('father', summary(state, content, father)),
    ...optional('partner', summary(state, content, field(people, record, 'partner'))),
    children: list(childrenOf(people, id)),
    siblings: list(siblings),
    ...optional('group', record.alive ? groupSummary(state, groupId, groupList) : undefined),
  };
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** Fiche d'un groupe vivant. */
export function groupView(state: SimState, content: SimContent, id: number): GroupView | undefined {
  const group = state.society.groups.get(id);
  if (group === undefined) return undefined;
  const all = groupMembers(state.people);
  const members = all.get(id) ?? [];
  const base = groupSummary(state, id, members);
  if (base === undefined) return undefined;
  const need = members.length > 0 ? members.length : 1;
  const parent = groupSummary(state, group.parent, all.get(group.parent) ?? []);
  return {
    ...base,
    founded: group.founded,
    ...(parent === undefined ? {} : { parent }),
    naming: cultureOf(state.society, group.culture)?.naming ?? 'father',
    reserve: group.food / need,
    homeX: group.homeX,
    homeY: group.homeY,
    members: members.flatMap((slot) => {
      const found = summary(state, content, state.people.get('id', slot));
      return found === undefined ? [] : [found];
    }),
  };
}

/** Réponse à une demande d'inspection. */
export function inspect(
  state: SimState,
  content: SimContent,
  target: InspectTarget,
): { person?: PersonView; group?: GroupView } {
  switch (target.kind) {
    case 'person': {
      const person = personView(state, content, target.id);
      return person === undefined ? {} : { person };
    }
    case 'group': {
      const group = groupView(state, content, target.id);
      return group === undefined ? {} : { group };
    }
  }
}

/**
 * Fait de la chronique, prêt à afficher, de rang `index` : les groupes y sont nommés
 * d'après leurs meneurs.
 */
export function chronicleView(
  state: SimState,
  entry: ChronicleEntry,
  index: number,
): ChronicleView {
  return {
    index,
    tick: entry.tick,
    kind: entry.kind,
    groupId: entry.group,
    x: entry.x,
    y: entry.y,
    group: entry.leader === NONE ? '' : groupName(state, entry.leader),
    other: entry.otherLeader === NONE ? '' : groupName(state, entry.otherLeader),
    count: entry.count,
  };
}

/** Faits de la chronique de rang `from` (compris) à `to` (exclu), prêts à afficher. */
export function chronicleViews(state: SimState, from: number, to: number): ChronicleView[] {
  const { chronicle } = state.society;
  const start = Math.max(0, from);
  return chronicle
    .slice(start, Math.max(start, to))
    .map((entry, offset) => chronicleView(state, entry, start + offset));
}

/**
 * Page de la chronique : les CHRONICLE_PAGE faits, au plus, qui précèdent le rang
 * `before`, du plus ancien au plus récent. Un rang qui n'est pas un entier positif n'en
 * donne aucun ; au-delà du dernier fait, la page finit avec lui.
 */
export function chroniclePage(state: SimState, before: number): ChronicleView[] {
  if (!Number.isSafeInteger(before) || before <= 0) return [];
  const end = Math.min(before, state.society.chronicle.length);
  return chronicleViews(state, end - CHRONICLE_PAGE, end);
}

/**
 * Teint et couleur des cheveux de chaque emplacement, tirés du génome, qui ne change pas :
 * on les garde d'une image à l'autre, avec l'identifiant de l'individu pour qui ils valent.
 */
interface Looks {
  ids: Uint32Array;
  skin: Uint8Array;
  hair: Uint8Array;
}

const looksOf = new WeakMap<Population, Looks>();

function looks(people: Population): Looks {
  let cache = looksOf.get(people);
  const capacity = people.columns.id.length;
  if (cache === undefined || cache.ids.length < capacity) {
    const grown: Looks = {
      ids: new Uint32Array(capacity),
      skin: new Uint8Array(capacity),
      hair: new Uint8Array(capacity),
    };
    if (cache !== undefined) {
      grown.ids.set(cache.ids);
      grown.skin.set(cache.skin);
      grown.hair.set(cache.hair);
    }
    cache = grown;
    looksOf.set(people, cache);
  }
  return cache;
}

/**
 * Stature de chaque emplacement, en 1/128 de case (ADR 0014) : la stature de référence de son
 * espèce, fois sa croissance à son âge, fois sa taille sur la taille moyenne de l'espèce, sur
 * un octet (le schéma garantit que le plus grand adulte y tient).
 */
function statureOf(state: SimState, content: SimContent, slot: number, heightTrait: number) {
  const { columns } = state.people;
  const species = content.species.entries.at(columns.species[slot] ?? 0);
  if (species === undefined) return 0;
  const [short, tall] = species.height;
  const height = short + (tall - short) * trait(columns.genome, slot * GENOME_WORDS, heightTrait);
  const years = Math.max(0, state.tick - (columns.birth[slot] ?? 0)) / MONTHS_PER_YEAR;
  const stature =
    (species.display.stature * curveAt(species.display.growth, years) * height * 2) /
    (short + tall);
  return Math.min(255, Math.max(0, Math.round(stature * 128)));
}

/**
 * Image des groupes pour la carte (ADR 0014) : chaque membre, son emplacement, son
 * identifiant, son code d'apparence, sa stature, sa position, qui le porte, et l'étape en
 * cours de chaque marcheur, repartie de l'instant de l'image. `members` évite de recompter
 * les membres que le pas vient de donner.
 */
export function groupsFrame(
  state: SimState,
  content: SimContent,
  members: ReadonlyMap<number, readonly number[]> = groupMembers(state.people),
  arrays: Allocator = freshArrays,
): GroupsFrame {
  const { people, tick } = state;
  const groups = arrays.uint32(state.society.groups.size * GROUP_STRIDE);
  let total = 0;
  for (const group of state.society.groups.values()) total += members.get(group.id)?.length ?? 0;
  const slots = arrays.uint32(total);
  const ids = arrays.uint32(total);
  const sprites = arrays.uint16(total);
  const statures = arrays.uint8(total);
  const positions = arrays.int32(2 * total);
  const carriers = arrays.uint32(total).fill(NO_CARRIER);
  const { genetics } = content;
  const roles = geneRoles(genetics);
  const hairLocus = roles.loci.hair;
  const skinTrait = roles.traits.skin;
  const heightTrait = roles.traits.height;
  const cache = looks(people);
  const { id: idColumn, sex, birth, species: kinds, genome, x, y } = people.columns;
  const movement = state.movement;
  // Classe d'âge et gris par mois d'âge, de chaque espèce (core/life.ts) ; un adulte sans
  // gris pour une espèce inconnue, comme le dit stageOf.
  const lives = content.species.entries.map((entry) => lifeTable(entry));
  const unknown = AGE_CODE.adult;
  let index = 0;
  let member = 0;
  for (const group of state.society.groups.values()) {
    const list = members.get(group.id) ?? [];
    groups.set([group.id, group.x, group.y, list.length, group.culture], index * GROUP_STRIDE);
    index++;
    for (const slot of list) {
      const id = idColumn[slot] ?? 0;
      if (cache.ids[slot] !== id) {
        const offset = slot * GENOME_WORDS;
        cache.ids[slot] = id;
        cache.skin[slot] = Math.min(
          SKIN_TONES - 1,
          Math.floor(trait(genome, offset, skinTrait) * SKIN_TONES),
        );
        cache.hair[slot] = expressed(genetics, genome, offset, hairLocus);
      }
      const life = lives.at(kinds[slot] ?? 0);
      const months = Math.max(0, tick - (birth[slot] ?? 0));
      const aging = life === undefined ? unknown : (life[Math.min(months, life.length - 1)] ?? 0);
      slots[member] = slot;
      ids[member] = id;
      sprites[member] = visualCode(
        sex[slot] ?? 0,
        aging & 3,
        cache.skin[slot] ?? 0,
        cache.hair[slot] ?? 0,
        aging >> 2,
      );
      statures[member] = statureOf(state, content, slot, heightTrait);
      positions[2 * member] = x[slot] ?? 0;
      positions[2 * member + 1] = y[slot] ?? 0;
      const carrier = movement.carrier[slot] ?? -1;
      if (carrier >= 0) carriers[member] = carrier;
      member++;
    }
  }
  return {
    groups,
    slots,
    ids,
    sprites,
    statures,
    positions,
    carriers,
    legs: currentLegs(state, arrays),
  };
}

/** Étape en cours de chaque marcheur, repartie de l'instant courant. */
export function currentLegs(state: SimState, arrays: Allocator = freshArrays): LegArrays {
  const movement = state.movement;
  const { x, y, stepX, stepY, stepDays } = state.people.columns;
  // Dans l'ordre des emplacements : l'image ne dépend pas de l'ordre des marcheurs.
  const walkers = Array.from(movement.active.subarray(0, movement.activeCount))
    .filter((slot) => movement.isActive(slot) && (stepDays[slot] ?? 0) > 0)
    .sort((a, b) => a - b);
  const count = walkers.length;
  const legs: LegArrays = {
    slots: arrays.uint32(count),
    days: arrays.uint32(count),
    start: arrays.int32(2 * count),
    step: arrays.int32(2 * count),
    count: arrays.uint16(count),
  };
  const day = dayIndex(state);
  let at = 0;
  for (const slot of walkers) {
    const days = stepDays[slot] ?? 0;
    legs.slots[at] = slot;
    legs.days[at] = day;
    legs.start[2 * at] = x[slot] ?? 0;
    legs.start[2 * at + 1] = y[slot] ?? 0;
    legs.step[2 * at] = stepX[slot] ?? 0;
    legs.step[2 * at + 1] = stepY[slot] ?? 0;
    legs.count[at] = days;
    at++;
  }
  return legs;
}
