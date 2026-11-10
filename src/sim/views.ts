/**
 * Ce que le fil principal voit de la population (tâches 2.9 et 2.10 ; IHM-02, CHR-01,
 * REN-04) : fiches d'un individu et d'un groupe, faits de la chronique, et l'image des
 * groupes de la carte avec un code d'apparence par membre.
 *
 * Les noms se forment ici, dans le worker, d'après la langue de chaque culture : le fil
 * principal reçoit des textes prêts, que la traduction n'a pas à toucher.
 */
import {
  GROUP_STRIDE,
  type ChronicleView,
  type GroupSummary,
  type GroupView,
  type InspectTarget,
  type PersonSummary,
  type PersonView,
} from '../core/protocol';
import { encodeVisual, SKIN_TONES } from '../core/visual';
import { expressed, trait } from './genetics';
import { cellDistance, groupMembers } from './groups';
import { DEATH_CAUSES, GENOME_WORDS, NEVER, NONE } from './population';
import { MONTHS_PER_YEAR } from './people';
import { childrenOf, field, heredity, personName, recordOf, type PersonRecord } from './records';
import { cultureOf, type ChronicleEntry } from './society';
import type { SimState } from './state';
import type { SimContent } from './step';

/** Âge, en années révolues, d'un vivant aujourd'hui ou d'un mort à sa mort. */
function ageOf(state: SimState, record: PersonRecord): number {
  const birth = field(state.people, record, 'birth');
  const end = record.alive
    ? state.tick
    : (state.people.archive.columns.death[record.index] ?? state.tick);
  return Math.max(0, Math.floor((end - birth) / MONTHS_PER_YEAR));
}

function summary(state: SimState, id: number): PersonSummary | undefined {
  const record = recordOf(state.people, id);
  if (record === undefined) return undefined;
  return {
    id,
    name: personName(state.people, state.society, id),
    sex: field(state.people, record, 'sex'),
    age: ageOf(state, record),
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
  const base = summary(state, id);
  if (record === undefined || base === undefined) return undefined;
  const species = content.species.entries.at(field(people, record, 'species'));
  const { genome, ancestry } = heredity(people, record);
  const { genetics } = content;
  const loci = genetics.loci.map((locus, index) => ({
    locus: locus.id,
    allele: locus.alleles.at(expressed(genetics, genome, 0, index))?.id ?? '',
  }));
  const traits = genetics.traits.map((entry, index) => ({
    trait: entry.id,
    value: trait(genome, 0, index),
  }));
  const heightIndex = genetics.traits.findIndex((entry) => entry.id === 'height');
  const [short, tall] = species?.height ?? [0, 0];
  const height = Math.round(short + (tall - short) * trait(genome, 0, Math.max(0, heightIndex)));
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
      const found = summary(state, other);
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
    nutrition: record.alive ? people.get('nutrition', record.index) / 255 : 0,
    pregnant: record.alive && people.get('conceived', record.index) !== NEVER,
    ...optional('mother', summary(state, mother)),
    ...optional('father', summary(state, father)),
    ...optional('partner', summary(state, field(people, record, 'partner'))),
    children: list(childrenOf(people, id)),
    siblings: list(siblings),
    ...optional('group', record.alive ? groupSummary(state, groupId, size) : undefined),
  };
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** Fiche d'un groupe vivant. */
export function groupView(state: SimState, id: number): GroupView | undefined {
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
      const found = summary(state, state.people.get('id', slot));
      return found === undefined ? [] : [found];
    }),
  };
}

/** Rayon, en cases, où l'on cherche le groupe le plus proche d'un lieu touché. */
const PICK_RADIUS = 4;

/** Le groupe le plus proche d'une case, à quelques cases au plus. */
export function groupNear(state: SimState, x: number, y: number): number | undefined {
  let best: number | undefined;
  let bestDistance = PICK_RADIUS;
  for (const group of state.society.groups.values()) {
    const distance = cellDistance(state.size.width, x, y, group.x, group.y);
    if (distance <= bestDistance) {
      best = group.id;
      bestDistance = distance;
    }
  }
  return best;
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
      const group = groupView(state, target.id);
      return group === undefined ? {} : { group };
    }
    case 'place': {
      const near = groupNear(state, target.x, target.y);
      const group = near === undefined ? undefined : groupView(state, near);
      return group === undefined ? {} : { group };
    }
  }
}

/** Fait de la chronique, prêt à afficher : les groupes y sont nommés d'après leurs meneurs. */
export function chronicleView(state: SimState, entry: ChronicleEntry): ChronicleView {
  return {
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

/** Image des groupes pour la carte, et un code d'apparence par membre. */
export function groupsFrame(
  state: SimState,
  content: SimContent,
): { groups: Uint32Array<ArrayBuffer>; sprites: Uint16Array<ArrayBuffer> } {
  const { people, tick } = state;
  const members = groupMembers(people);
  const groups = new Uint32Array(state.society.groups.size * GROUP_STRIDE);
  let total = 0;
  for (const group of state.society.groups.values()) total += members.get(group.id)?.length ?? 0;
  const sprites = new Uint16Array(total);
  const { genetics } = content;
  const hair = genetics.loci.findIndex((locus) => locus.id === 'hair');
  const skin = genetics.traits.findIndex((entry) => entry.id === 'skin');
  let index = 0;
  let sprite = 0;
  for (const group of state.society.groups.values()) {
    const list = members.get(group.id) ?? [];
    groups.set([group.id, group.x, group.y, list.length, group.culture], index * GROUP_STRIDE);
    index++;
    for (const slot of list) {
      const species = content.species.entries.at(people.get('species', slot));
      const years = people.age(slot, tick) / MONTHS_PER_YEAR;
      const maturity = species?.maturity ?? 15;
      const age = years < 3 ? 0 : years < maturity ? 1 : years < 55 ? 2 : 3;
      const offset = slot * GENOME_WORDS;
      sprites[sprite++] = encodeVisual({
        sex: people.get('sex', slot),
        age,
        skin: Math.min(
          SKIN_TONES - 1,
          Math.floor(trait(people.columns.genome, offset, Math.max(0, skin)) * SKIN_TONES),
        ),
        hair: hair < 0 ? 0 : expressed(genetics, people.columns.genome, offset, hair),
        grey: years >= 50,
      });
    }
  }
  return { groups, sprites };
}
