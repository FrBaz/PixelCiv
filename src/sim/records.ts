/**
 * Lecture d'un individu, vivant ou mort (tâche 2.10 ; IND-03) : les vivants dans leurs
 * colonnes, les morts dans l'archive, sous un même accès. Et son nom, que la langue de sa
 * culture rend à partir de ses codes (src/gen/names.ts).
 */
import { familyName, givenName, phonology, type Phonology } from '../gen/names';
import { ANCESTRY_SLOTS, GENOME_WORDS, NONE, type Population } from './population';
import { cultureOf, languageOf, type Society } from './society';

/** Champs communs aux vivants et aux morts. */
type Field =
  | 'id'
  | 'sex'
  | 'birth'
  | 'species'
  | 'mother'
  | 'father'
  | 'partner'
  | 'group'
  | 'culture'
  | 'givenName'
  | 'familyName';

/** Un individu, vivant (emplacement) ou mort (ligne de l'archive). */
export interface PersonRecord {
  readonly id: number;
  readonly alive: boolean;
  readonly index: number;
}

export function recordOf(people: Population, id: number): PersonRecord | undefined {
  const slot = people.slotOf(id);
  if (slot !== undefined) return { id, alive: true, index: slot };
  const row = people.archivedRow(id);
  return row === undefined ? undefined : { id, alive: false, index: row };
}

export function field(people: Population, record: PersonRecord, name: Field): number {
  const columns = record.alive ? people.columns : people.archive.columns;
  return columns[name][record.index] ?? 0;
}

/** Génome et ascendance d'un individu, copiés. */
export function heredity(
  people: Population,
  record: PersonRecord,
): { genome: number[]; ancestry: number[] } {
  const columns = record.alive ? people.columns : people.archive.columns;
  const genome = Array.from(
    columns.genome.subarray(record.index * GENOME_WORDS, (record.index + 1) * GENOME_WORDS),
  );
  const ancestry = Array.from(
    columns.ancestry.subarray(record.index * ANCESTRY_SLOTS, (record.index + 1) * ANCESTRY_SLOTS),
  );
  return { genome, ancestry };
}

const phonologies = new Map<number, Phonology>();

/** Phonologie d'une langue, gardée d'un appel à l'autre : elle ne dépend que de la graine. */
export function phonologyOf(seed: number): Phonology {
  let found = phonologies.get(seed);
  if (found === undefined) {
    found = phonology(seed);
    phonologies.set(seed, found);
  }
  return found;
}

/**
 * Nom complet d'un individu : son prénom, puis son nom de famille selon la règle de sa
 * culture (IND-08) ; « les deux » joint ceux de son père et de sa mère. Chaîne vide pour
 * un identifiant inconnu.
 */
export function personName(people: Population, society: Society, id: number): string {
  const record = recordOf(people, id);
  if (record === undefined) return '';
  const culture = cultureOf(society, field(people, record, 'culture'));
  const language = languageOf(society, culture?.language ?? 0);
  if (language === undefined) return '';
  const words = phonologyOf(language.seed);
  const given = givenName(words, field(people, record, 'sex'), field(people, record, 'givenName'));
  const code = field(people, record, 'familyName');
  if (culture?.naming === 'none' || code === 0) return given;
  const family = familyName(words, code);
  if (culture?.naming !== 'both') return `${given} ${family}`;
  // « Les deux » : le nom du père, puis celui de la mère, s'il diffère.
  const mother = recordOf(people, field(people, record, 'mother'));
  const maternal = mother === undefined ? 0 : field(people, mother, 'familyName');
  return maternal === 0 || maternal === code
    ? `${given} ${family}`
    : `${given} ${family} ${familyName(words, maternal)}`;
}

/** Enfants d'un individu, vivants ou morts, dans l'ordre de leurs identifiants. */
export function childrenOf(people: Population, id: number): number[] {
  const children: number[] = [];
  people.forEach((slot) => {
    if (people.get('mother', slot) === id || people.get('father', slot) === id) {
      children.push(people.get('id', slot));
    }
  });
  const archived = people.archive.columns;
  for (let row = 0; row < people.archive.rows; row++) {
    if (archived.mother[row] === id || archived.father[row] === id) {
      children.push(archived.id[row] ?? NONE);
    }
  }
  return children.sort((a, b) => a - b);
}
