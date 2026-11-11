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
  type ChronicleView,
  type GroupSummary,
  type GroupView,
  type InspectTarget,
  type PersonSummary,
  type PersonView,
} from '../core/protocol';
import { geneRoles } from '../core/data/people';
import { ageClass, greyLevel, lifeTable, type LifeAges } from '../core/life';
import { AGE_CODE, SKIN_TONES, visualCode, type AgeClass } from '../core/visual';
import { expressed, trait } from './genetics';
import { groupMembers } from './groups';
import { DEATH_CAUSES, GENOME_WORDS, NEVER, NONE, type Population } from './population';
import { MONTHS_PER_YEAR } from './people';
import { childrenOf, field, heredity, personName, recordOf, type PersonRecord } from './records';
import { cultureOf, type ChronicleEntry } from './society';
import type { SimState } from './state';
import type { SimContent } from './step';

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

function groupSummary(state: SimState, id: number, size: number): GroupSummary | undefined {
  const group = state.society.groups.get(id);
  if (group === undefined) return undefined;
  return { id, name: groupName(state, group.leader), x: group.x, y: group.y, size };
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
  const size = groupMembers(people).get(groupId)?.length ?? 0;
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
    grey: species === undefined ? 0 : greyLevel(species, yearsOf(state, record)),
    nutrition: record.alive ? people.get('nutrition', record.index) / 255 : 0,
    pregnant: record.alive && people.get('conceived', record.index) !== NEVER,
    ...optional('mother', summary(state, content, mother)),
    ...optional('father', summary(state, content, father)),
    ...optional('partner', summary(state, content, field(people, record, 'partner'))),
    children: list(childrenOf(people, id)),
    siblings: list(siblings),
    ...optional('group', record.alive ? groupSummary(state, groupId, size) : undefined),
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
  const base = groupSummary(state, id, members.length);
  if (base === undefined) return undefined;
  const need = members.length > 0 ? members.length : 1;
  const parent = groupSummary(state, group.parent, all.get(group.parent)?.length ?? 0);
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
 * Image des groupes pour la carte, et un code d'apparence par membre ; `members` évite de
 * recompter les membres que le pas vient de donner.
 */
export function groupsFrame(
  state: SimState,
  content: SimContent,
  members: ReadonlyMap<number, readonly number[]> = groupMembers(state.people),
): { groups: Uint32Array<ArrayBuffer>; sprites: Uint16Array<ArrayBuffer> } {
  const { people, tick } = state;
  const groups = new Uint32Array(state.society.groups.size * GROUP_STRIDE);
  let total = 0;
  for (const group of state.society.groups.values()) total += members.get(group.id)?.length ?? 0;
  const sprites = new Uint16Array(total);
  const { genetics } = content;
  const roles = geneRoles(genetics);
  const hairLocus = roles.loci.hair;
  const skinTrait = roles.traits.skin;
  const cache = looks(people);
  const { id: ids, sex, birth, species: kinds, genome } = people.columns;
  // Classe d'âge et gris par mois d'âge, de chaque espèce (core/life.ts) ; un adulte sans
  // gris pour une espèce inconnue, comme le dit stageOf.
  const lives = content.species.entries.map((entry) => lifeTable(entry));
  const unknown = AGE_CODE.adult;
  let index = 0;
  let sprite = 0;
  for (const group of state.society.groups.values()) {
    const list = members.get(group.id) ?? [];
    groups.set([group.id, group.x, group.y, list.length, group.culture], index * GROUP_STRIDE);
    index++;
    for (const slot of list) {
      const id = ids[slot] ?? 0;
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
      sprites[sprite++] = visualCode(
        sex[slot] ?? 0,
        aging & 3,
        cache.skin[slot] ?? 0,
        cache.hair[slot] ?? 0,
        aging >> 2,
      );
    }
  }
  return { groups, sprites };
}
