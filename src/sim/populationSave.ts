/**
 * Sauvegarde de la population et de la société (tâche 2.1 ; ADR 0007, ADR 0011).
 *
 * Les colonnes des vivants et de l'archive partent en binaire, telles quelles, avec la
 * pile des emplacements libres et l'index par identifiant : une partie rechargée
 * parcourt ses vivants dans le même ordre et se poursuit à l'identique (NF-09). La
 * chronique, qui grandit avec la partie, part en colonnes elle aussi, un fait par ligne ;
 * groupes, cultures et langues partent en JSON, dans l'en-tête.
 *
 * La relecture vérifie tout ce qu'un fichier forgé pourrait fausser. D'abord chaque
 * tableau, présent, de son type et de sa longueur, avant de rien allouer : un petit
 * fichier ne fait pas réserver beaucoup de mémoire. Puis l'index, cohérent avec les
 * emplacements et l'archive ; les identifiants, connus ; les indices du contenu et les
 * gènes, lisibles. Espèces et sous-espèces sont nommées : indices d'espèce et parts
 * d'ascendance suivent l'ordre actuel de data/species.json, et les génomes celui des
 * locus, des allèles et des traits de data/genetics.json (ADR 0006). L'écriture, elle,
 * refuse ce que la relecture refuserait.
 */
import { z } from 'zod';
import type { Catalog } from '../core/data/catalog';
import type { Genetics, Species } from '../core/data';
import { Fingerprint } from '../core/hash';
import { SaveError, type SaveData, type SavedArray } from '../core/save/format';
import {
  ANCESTRY_SLOTS,
  Archive,
  ARCHIVE_COLUMN_NAMES,
  ARCHIVE_COLUMNS,
  DEATH_CAUSES,
  GENOME_WORDS,
  LIVING_COLUMN_NAMES,
  LIVING_COLUMNS,
  NONE,
  Population,
  type ArchiveColumn,
  type Column,
  type ColumnConstructor,
  type LivingColumn,
} from './population';
import {
  CHRONICLE_KINDS,
  NAMING_RULES,
  type ChronicleEntry,
  type Culture,
  type Group,
  type Language,
  type Society,
} from './society';

/** Bornes d'une sauvegarde : bien au-delà de ce qu'une partie atteint, en deçà d'un abus. */
export const MAX_SLOTS = 1 << 21;
export const MAX_IDS = 1 << 24;
/** Groupes vivants, cultures et langues, chacun. */
export const MAX_GROUPS = 1 << 16;
/**
 * Faits de la chronique : 33 octets chacun dans la sauvegarde, davantage en mémoire, où
 * chacun est un objet. La borne protège aussi la relecture d'un fichier forgé.
 */
export const MAX_CHRONICLE = 1 << 20;

const uint32 = z.number().int().min(0).max(0xffffffff);
const int32 = z.number().int().min(-0x80000000).max(0x7fffffff);

const GroupSchema = z
  .object({
    id: z.number().int().min(1),
    culture: z.number().int().min(1),
    founded: int32,
    parent: z.number().int().min(0),
    leader: z.number().int().min(0),
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    homeX: z.number().int().min(0),
    homeY: z.number().int().min(0),
    targetX: z.number().int().min(-1),
    targetY: z.number().int().min(-1),
    food: z.number().min(0).max(1e9),
  })
  .strict() satisfies z.ZodType<Group>;

const CultureSchema = z
  .object({
    id: z.number().int().min(1),
    language: z.number().int().min(1),
    naming: z.enum(NAMING_RULES),
    founded: int32,
  })
  .strict() satisfies z.ZodType<Culture>;

const LanguageSchema = z
  .object({ id: z.number().int().min(1), seed: uint32 })
  .strict() satisfies z.ZodType<Language>;

/** Fait de la chronique d'une sauvegarde de la version 4, où elle partait en JSON. */
const ChronicleSchema = z
  .object({
    tick: z.number().int().min(0),
    kind: z.enum(CHRONICLE_KINDS),
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    group: z.number().int().min(0),
    other: z.number().int().min(0),
    leader: z.number().int().min(0),
    otherLeader: z.number().int().min(0),
    count: z.number().int().min(0),
  })
  .strict() satisfies z.ZodType<ChronicleEntry>;

/** Ordre des locus, de leurs allèles et des traits : de quoi relire un génome. */
const GenomeLayoutSchema = z
  .object({
    loci: z
      .array(z.object({ id: z.string(), alleles: z.array(z.string()).max(16) }).strict())
      .max(8),
    traits: z.array(z.string()).max(8),
  })
  .strict();

/**
 * Colonnes de la chronique dans la sauvegarde, un fait par ligne. Le genre d'un fait y
 * est son indice dans CHRONICLE_KINDS, où un genre nouveau s'ajoute à la fin.
 */
const CHRONICLE_COLUMNS = {
  tick: Uint32Array,
  kind: Uint8Array,
  x: Uint32Array,
  y: Uint32Array,
  group: Uint32Array,
  other: Uint32Array,
  leader: Uint32Array,
  otherLeader: Uint32Array,
  count: Uint32Array,
} as const satisfies Record<keyof ChronicleEntry, ColumnConstructor>;

type ChronicleColumn = keyof typeof CHRONICLE_COLUMNS;
const CHRONICLE_COLUMN_NAMES = Object.keys(CHRONICLE_COLUMNS) as ChronicleColumn[];

export const PeopleJsonSchema = z
  .object({
    end: z.number().int().min(0).max(MAX_SLOTS),
    nextId: z.number().int().min(1).max(MAX_IDS),
    archived: z.number().int().min(0).max(MAX_IDS),
    species: z.array(z.string()).max(255),
    /**
     * Sous-espèces de chaque espèce, dans l'ordre de `species` : les parts d'ascendance
     * suivent leur ordre. Une sauvegarde de la version 4 ne les nommait pas ; elle suivait
     * l'ordre des données, qui n'a pas changé depuis.
     */
    subspecies: z.array(z.array(z.string()).max(ANCESTRY_SLOTS)).max(255).optional(),
    genome: GenomeLayoutSchema,
    groups: z.array(z.unknown()).max(MAX_GROUPS),
    cultures: z.array(z.unknown()).max(MAX_GROUPS),
    languages: z.array(z.unknown()).max(MAX_GROUPS),
    /** Nombre de faits de la chronique, rangés dans ses colonnes. */
    chronicle: z.number().int().min(0).max(MAX_CHRONICLE),
    nextGroupId: z.number().int().min(1).max(MAX_IDS),
  })
  .strict();

export type PeopleJson = z.infer<typeof PeopleJsonSchema>;

/** Contenu dont la population se sert : espèces et génétique. */
export interface PeopleContent {
  readonly species: Catalog<Species>;
  readonly genetics: Genetics;
}

/** Nom d'un tableau de la sauvegarde : « people », « archive » ou « chronicle », puis la colonne. */
const arrayName = (prefix: string, name: string) =>
  `${prefix}${name.charAt(0).toUpperCase()}${name.slice(1)}`;
const livingArray = (name: string) => arrayName('people', name);
const archiveArray = (name: string) => arrayName('archive', name);
const chronicleArray = (name: string) => arrayName('chronicle', name);

function layout(genetics: Genetics): PeopleJson['genome'] {
  return {
    loci: genetics.loci.map((locus) => ({
      id: locus.id,
      alleles: locus.alleles.map((allele) => allele.id),
    })),
    traits: genetics.traits.map((trait) => trait.id),
  };
}

/** La chronique en colonnes. */
function chronicleArrays(chronicle: readonly ChronicleEntry[]): Record<string, SavedArray> {
  const arrays: Record<string, SavedArray> = {};
  for (const name of CHRONICLE_COLUMN_NAMES) {
    const column = new CHRONICLE_COLUMNS[name](chronicle.length);
    chronicle.forEach((entry, index) => {
      column[index] = name === 'kind' ? CHRONICLE_KINDS.indexOf(entry.kind) : entry[name];
    });
    arrays[chronicleArray(name)] = column;
  }
  return arrays;
}

/**
 * Ce que la relecture refuserait ne s'écrit pas (ADR 0007) : une population au-delà des
 * bornes du format fait échouer la sauvegarde, et la précédente reste intacte.
 */
function checkBounds(people: Population, society: Society): void {
  if (
    people.end > MAX_SLOTS ||
    people.nextId > MAX_IDS ||
    society.nextGroupId > MAX_IDS ||
    society.groups.size > MAX_GROUPS ||
    society.cultures.length > MAX_GROUPS ||
    society.languages.length > MAX_GROUPS ||
    society.chronicle.length > MAX_CHRONICLE
  ) {
    throw new SaveError('size', 'population trop grande pour la sauvegarde');
  }
}

/** Copie de la population et de la société, prête à sauvegarder ; SaveError hors des bornes. */
export function savePeople(
  people: Population,
  society: Society,
  content: PeopleContent,
): { json: PeopleJson; arrays: Record<string, SavedArray> } {
  checkBounds(people, society);
  const arrays: Record<string, SavedArray> = {};
  for (const name of LIVING_COLUMN_NAMES) {
    arrays[livingArray(name)] = people.columns[name].slice(
      0,
      people.end * LIVING_COLUMNS[name].width,
    );
  }
  arrays.peopleAlive = people.alive.slice(0, people.end);
  arrays.peopleFree = Int32Array.from(people.free);
  arrays.peopleWhere = people.where.slice(0, people.nextId);
  const rows = people.archive.rows;
  for (const name of ARCHIVE_COLUMN_NAMES) {
    arrays[archiveArray(name)] = people.archive.columns[name].slice(
      0,
      rows * ARCHIVE_COLUMNS[name].width,
    );
  }
  Object.assign(arrays, chronicleArrays(society.chronicle));
  return {
    json: {
      end: people.end,
      nextId: people.nextId,
      archived: rows,
      species: content.species.entries.map((entry) => entry.id),
      subspecies: content.species.entries.map((entry) => entry.subspecies.map(({ id }) => id)),
      genome: layout(content.genetics),
      groups: [...society.groups.values()].map((group) => ({ ...group })),
      cultures: society.cultures.map((culture) => ({ ...culture })),
      languages: society.languages.map((language) => ({ ...language })),
      chronicle: society.chronicle.length,
      nextGroupId: society.nextGroupId,
    },
    arrays,
  };
}

/**
 * Version 5 : la chronique quitte l'en-tête JSON, que ses faits finissaient par remplir,
 * pour des colonnes. Les faits d'une partie de la version 4 se lisent un à un : au
 * premier qui ne convient pas, la chronique reste telle quelle, et la relecture la
 * refusera. Une chronique déjà en colonnes (la population vide qu'une partie de la
 * version 3 reçoit) ne change pas.
 */
export function migrateChronicle(save: SaveData): SaveData {
  const json: unknown = save.json;
  if (typeof json !== 'object' || json === null) return save;
  const people: unknown = (json as { people?: unknown }).people;
  if (typeof people !== 'object' || people === null) return save;
  const list: unknown = (people as { chronicle?: unknown }).chronicle;
  if (!Array.isArray(list)) return save;
  const entries: ChronicleEntry[] = [];
  for (const item of list as unknown[]) {
    const parsed = ChronicleSchema.safeParse(item);
    if (!parsed.success) return save;
    entries.push(parsed.data);
  }
  return {
    meta: save.meta,
    json: { ...json, people: { ...people, chronicle: entries.length } },
    arrays: { ...save.arrays, ...chronicleArrays(entries) },
  };
}

/**
 * Tableau d'une sauvegarde, vérifié dans son type et sa longueur, sans copie ; SaveError
 * sinon. Qui le garde le copie : l'état ne partage rien avec la sauvegarde.
 */
function savedArray(save: SaveData, name: string, type: ColumnConstructor, length: number): Column {
  // Un nom absent donne undefined, que instanceof écarte.
  const array: SavedArray | undefined = save.arrays[name];
  if (!(array instanceof type) || array.length !== length) {
    throw new SaveError('corrupt', `tableau ${name} absent ou de mauvaise taille`);
  }
  return array;
}

function each<T>(items: readonly unknown[], schema: z.ZodType<T>, name: string): T[] {
  return items.map((item) => {
    const parsed = schema.safeParse(item);
    if (!parsed.success) throw new SaveError('corrupt', `${name} illisible`);
    return parsed.data;
  });
}

/**
 * Réécriture d'un génome sauvegardé vers l'ordre actuel : pour chaque locus sauvegardé,
 * son indice actuel et celui de chacun de ses allèles ; pour chaque trait, son indice.
 */
interface GenomeRemap {
  readonly loci: readonly { readonly index: number; readonly alleles: readonly number[] }[];
  readonly traits: readonly number[];
}

/**
 * Table de réécriture des génomes sauvegardés vers l'ordre actuel des locus, des allèles
 * et des traits. Un locus, un allèle ou un trait disparu rend la sauvegarde trop ancienne.
 */
function genomeRemap(saved: PeopleJson['genome'], genetics: Genetics): GenomeRemap {
  const current = layout(genetics);
  const loci = saved.loci.map((locus) => {
    const index = current.loci.findIndex((entry) => entry.id === locus.id);
    const target = index < 0 ? undefined : current.loci[index];
    if (target === undefined) throw new SaveError('obsolete', `locus inconnu : ${locus.id}`);
    const alleles = locus.alleles.map((id) => {
      const allele = target.alleles.indexOf(id);
      if (allele < 0) throw new SaveError('obsolete', `allèle inconnu : ${locus.id}.${id}`);
      return allele;
    });
    return { index, alleles };
  });
  const traits = saved.traits.map((id) => {
    const index = current.traits.indexOf(id);
    if (index < 0) throw new SaveError('obsolete', `trait inconnu : ${id}`);
    return index;
  });
  return { loci, traits };
}

/** Octet du premier trait dans un génome : les traits suivent les huit locus (genetics.ts). */
const FIRST_TRAIT = 8;

/**
 * Réécrit les `count` premiers génomes d'une colonne dans l'ordre actuel des données, que
 * cet ordre ait changé ou non : un code d'allèle hors de la liste sauvegardée ne désigne
 * aucun allèle, et rend la sauvegarde illisible.
 */
function rewriteGenomes(genomes: Column, count: number, remap: GenomeRemap): void {
  const words = new Uint32Array(GENOME_WORDS);
  // Octet `place` du génome commençant à `offset` ; place = locus, ou FIRST_TRAIT + trait.
  const byte = (offset: number, place: number) =>
    ((genomes[offset + (place >> 2)] ?? 0) >>> ((place & 3) * 8)) & 0xff;
  const write = (place: number, value: number) => {
    const word = place >> 2;
    words[word] = ((words[word] ?? 0) | (value << ((place & 3) * 8))) >>> 0;
  };
  for (let person = 0; person < count; person++) {
    const offset = person * GENOME_WORDS;
    words.fill(0);
    remap.loci.forEach(({ index, alleles }, saved) => {
      const value = byte(offset, saved);
      const maternal = alleles.at(value & 0x0f);
      const paternal = alleles.at(value >> 4);
      if (maternal === undefined || paternal === undefined) {
        throw new SaveError('corrupt', 'génome illisible');
      }
      write(index, maternal | (paternal << 4));
    });
    remap.traits.forEach((index, saved) => {
      write(FIRST_TRAIT + index, byte(offset, FIRST_TRAIT + saved));
    });
    genomes.set(words, offset);
  }
}

/**
 * Pour chaque espèce de la sauvegarde, l'indice actuel de chacune de ses sous-espèces,
 * dans l'ordre où la sauvegarde les range. Une sous-espèce disparue rend la sauvegarde
 * trop ancienne ; sans liste (version 4), les sous-espèces suivent l'ordre des données.
 */
function lineageRemap(
  saved: PeopleJson['subspecies'],
  species: readonly number[],
  catalog: Catalog<Species>,
): number[][] {
  if (saved !== undefined && saved.length !== species.length) {
    throw new SaveError('corrupt', 'sous-espèces mal rangées');
  }
  return species.map((current, index) => {
    const ids = catalog.entries.at(current)?.subspecies.map((entry) => entry.id) ?? [];
    const lineage = (saved?.at(index) ?? ids).map((id) => {
      const target = ids.indexOf(id);
      if (target < 0) throw new SaveError('obsolete', `sous-espèce inconnue : ${id}`);
      return target;
    });
    if (new Set(lineage).size !== lineage.length) {
      throw new SaveError('corrupt', 'sous-espèces mal rangées');
    }
    return lineage;
  });
}

/**
 * Ramène les parts d'ascendance d'un individu de l'ordre des sous-espèces de la
 * sauvegarde (`lineage`) à celui des données. Une part au-delà des sous-espèces
 * sauvegardées ne désigne personne : la sauvegarde est illisible.
 */
function rewriteAncestry(
  column: Column,
  offset: number,
  lineage: readonly number[],
  shares: Uint8Array,
): void {
  shares.fill(0);
  for (let part = 0; part < ANCESTRY_SLOTS; part++) {
    const share = column[offset + part] ?? 0;
    if (share === 0) continue;
    const target = lineage.at(part);
    if (target === undefined) throw new SaveError('corrupt', 'ascendance illisible');
    shares[target] = share;
  }
  column.set(shares, offset);
}

/**
 * Chronique d'une sauvegarde, lue de ses colonnes ; SaveError si elle est incohérente.
 * Ses faits se suivent dans le temps jusqu'au pas courant, ont lieu dans le monde, et
 * nomment des groupes et des meneurs connus. Chaque groupe formé y a le sien, apparition
 * ou scission, dans l'ordre des identifiants : le prochain identifiant de groupe doit
 * suivre le dernier. Un nombre forgé ferait allouer chaque mois des tableaux démesurés,
 * indexés par groupe (lifecycle.ts).
 */
function restoreChronicle(
  save: SaveData,
  json: PeopleJson,
  size: { readonly width: number; readonly height: number },
  tick: number,
): ChronicleEntry[] {
  const length = json.chronicle;
  const columns = {} as Record<ChronicleColumn, Column>;
  for (const name of CHRONICLE_COLUMN_NAMES) {
    columns[name] = savedArray(save, chronicleArray(name), CHRONICLE_COLUMNS[name], length);
  }
  const chronicle: ChronicleEntry[] = [];
  let previous = 0;
  // Groupes formés : chacun a son fait, et le n-ième formé porte l'identifiant n.
  let formed = 0;
  for (let index = 0; index < length; index++) {
    const value = (name: ChronicleColumn) => columns[name][index] ?? 0;
    const kind = CHRONICLE_KINDS.at(value('kind'));
    if (kind === undefined) throw new SaveError('corrupt', 'chronique illisible');
    const entry: ChronicleEntry = {
      tick: value('tick'),
      kind,
      x: value('x'),
      y: value('y'),
      group: value('group'),
      other: value('other'),
      leader: value('leader'),
      otherLeader: value('otherLeader'),
      count: value('count'),
    };
    const created =
      kind === 'groupAppeared' ? entry.group : kind === 'groupSplit' ? entry.other : undefined;
    if (
      entry.tick < previous ||
      entry.tick > tick ||
      entry.x >= size.width ||
      entry.y >= size.height ||
      entry.group === NONE ||
      entry.group >= json.nextGroupId ||
      entry.other >= json.nextGroupId ||
      entry.leader >= json.nextId ||
      entry.otherLeader >= json.nextId ||
      (created !== undefined && created !== ++formed)
    ) {
      throw new SaveError('corrupt', 'chronique incohérente');
    }
    previous = entry.tick;
    chronicle.push(entry);
  }
  if (formed + 1 !== json.nextGroupId) {
    throw new SaveError('corrupt', 'identifiants de groupe incohérents');
  }
  return chronicle;
}

/**
 * Population et société d'une sauvegarde ; SaveError si elles sont incohérentes. `size`
 * borne les cases des groupes et de la chronique.
 */
export function restorePeople(
  save: SaveData,
  rawJson: unknown,
  content: PeopleContent,
  size: { readonly width: number; readonly height: number },
  tick: number,
): { people: Population; society: Society } {
  const parsed = PeopleJsonSchema.safeParse(rawJson);
  if (!parsed.success) throw new SaveError('corrupt', 'population illisible');
  const json = parsed.data;
  const { end, nextId, archived } = json;

  // Tableaux d'abord, présents, de leur type et de leur longueur : ce qui s'alloue ensuite
  // est borné par la taille du fichier, et non par les seuls nombres de l'en-tête.
  const living = {} as Record<LivingColumn, Column>;
  for (const name of LIVING_COLUMN_NAMES) {
    const spec = LIVING_COLUMNS[name];
    living[name] = savedArray(save, livingArray(name), spec.type, end * spec.width);
  }
  const alive = savedArray(save, 'peopleAlive', Uint8Array, end);
  const free = save.arrays.peopleFree;
  if (!(free instanceof Int32Array) || free.length > end) {
    throw new SaveError('corrupt', 'emplacements libres illisibles');
  }
  const where = savedArray(save, 'peopleWhere', Int32Array, nextId);
  const dead = {} as Record<ArchiveColumn, Column>;
  for (const name of ARCHIVE_COLUMN_NAMES) {
    const spec = ARCHIVE_COLUMNS[name];
    dead[name] = savedArray(save, archiveArray(name), spec.type, archived * spec.width);
  }
  // Un identifiant ne resert jamais : chacun de ceux déjà donnés désigne un vivant ou un mort.
  let count = 0;
  for (let slot = 0; slot < end; slot++) {
    const flag = alive[slot] ?? 0;
    if (flag > 1) throw new SaveError('corrupt', 'emplacement illisible');
    count += flag;
  }
  if (count + archived !== nextId - 1) throw new SaveError('corrupt', 'identifiants incohérents');

  // Société : les colonnes renvoient à ses identifiants.
  const languages = each(json.languages, LanguageSchema, 'langue');
  const cultures = each(json.cultures, CultureSchema, 'culture');
  const groups = each(json.groups, GroupSchema, 'groupe');
  languages.forEach((language, index) => {
    if (language.id !== index + 1) throw new SaveError('corrupt', 'langues mal rangées');
  });
  cultures.forEach((culture, index) => {
    if (culture.id !== index + 1 || culture.language > languages.length || culture.founded > tick) {
      throw new SaveError('corrupt', 'cultures incohérentes');
    }
  });
  const groupMap = new Map<number, Group>();
  for (const group of groups) {
    const inside = (x: number, y: number) => x < size.width && y < size.height;
    if (
      group.id >= json.nextGroupId ||
      groupMap.has(group.id) ||
      group.culture > cultures.length ||
      !inside(group.x, group.y) ||
      !inside(group.homeX, group.homeY) ||
      (group.targetX >= 0 && !inside(group.targetX, Math.max(0, group.targetY)))
    ) {
      throw new SaveError('corrupt', 'groupes incohérents');
    }
    if (group.leader >= json.nextId) throw new SaveError('corrupt', 'meneur inconnu');
    groupMap.set(group.id, group);
  }
  const chronicle = restoreChronicle(save, json, size, tick);

  // Colonnes, copiées : l'état ne partage rien avec la sauvegarde.
  const people = new Population(Math.max(1, end));
  for (const name of LIVING_COLUMN_NAMES) people.columns[name].set(living[name]);
  people.alive.set(alive);
  const archive = new Archive(Math.max(1, archived));
  for (const name of ARCHIVE_COLUMN_NAMES) archive.columns[name].set(dead[name]);
  archive.rows = archived;

  // Espèces et sous-espèces ramenées à l'ordre des données.
  const species = json.species.map((id) => {
    const index = content.species.indexOf(id);
    if (index === undefined) throw new SaveError('obsolete', `espèce inconnue : ${id}`);
    return index;
  });
  const lineages = lineageRemap(json.subspecies, species, content.species);
  const shares = new Uint8Array(ANCESTRY_SLOTS);

  // Index : chaque vivant et chaque mort y figure une fois, à sa place.
  const seen = new Uint8Array(nextId);
  const known = (id: number) => id === NONE || (id >= 1 && id < nextId);
  for (let slot = 0; slot < end; slot++) {
    if (people.alive[slot] === 0) continue;
    const id = people.get('id', slot);
    if (id < 1 || id >= nextId || seen[id] === 1 || where[id] !== slot) {
      throw new SaveError('corrupt', 'index des vivants incohérent');
    }
    seen[id] = 1;
    const saved = people.get('species', slot);
    const kind = species.at(saved);
    const lineage = lineages.at(saved);
    if (kind === undefined || lineage === undefined) {
      throw new SaveError('corrupt', 'espèce hors de la liste');
    }
    people.set('species', slot, kind);
    rewriteAncestry(people.columns.ancestry, slot * ANCESTRY_SLOTS, lineage, shares);
    const group = people.get('group', slot);
    if (
      (group !== NONE && !groupMap.has(group)) ||
      people.get('culture', slot) > cultures.length ||
      people.get('familyLanguage', slot) > languages.length ||
      !known(people.get('mother', slot)) ||
      !known(people.get('father', slot)) ||
      !known(people.get('partner', slot)) ||
      !known(people.get('pregnantBy', slot)) ||
      people.get('sex', slot) > 1 ||
      people.get('birth', slot) > tick
    ) {
      throw new SaveError('corrupt', 'individu incohérent');
    }
  }
  const freeSet = new Set<number>();
  for (const slot of free) {
    if (slot < 0 || slot >= end || people.alive[slot] !== 0 || freeSet.has(slot)) {
      throw new SaveError('corrupt', 'emplacements libres incohérents');
    }
    freeSet.add(slot);
  }
  if (freeSet.size + count !== end) throw new SaveError('corrupt', 'emplacements perdus');
  for (let row = 0; row < archived; row++) {
    const id = archive.columns.id[row] ?? 0;
    if (id < 1 || id >= nextId || seen[id] === 1 || where[id] !== -row - 2) {
      throw new SaveError('corrupt', "index de l'archive incohérent");
    }
    seen[id] = 1;
    const saved = archive.columns.species[row] ?? 0;
    const kind = species.at(saved);
    const lineage = lineages.at(saved);
    const cause = archive.columns.cause[row] ?? 0;
    if (
      kind === undefined ||
      lineage === undefined ||
      cause >= DEATH_CAUSES.length ||
      (archive.columns.familyLanguage[row] ?? 0) > languages.length
    ) {
      throw new SaveError('corrupt', 'mort incohérent');
    }
    archive.columns.species[row] = kind;
    rewriteAncestry(archive.columns.ancestry, row * ANCESTRY_SLOTS, lineage, shares);
  }
  // Les nextId - 1 identifiants vus, chacun une fois, à sa place : l'index est complet.

  // Génomes : vérifiés, et réécrits dans l'ordre actuel des données.
  const remap = genomeRemap(json.genome, content.genetics);
  rewriteGenomes(people.columns.genome, end, remap);
  rewriteGenomes(archive.columns.genome, archived, remap);

  people.end = end;
  people.count = count;
  people.free = [...free];
  people.nextId = nextId;
  people.where = new Int32Array(Math.max(nextId, 256)).fill(-1);
  people.where.set(where);
  people.archive = archive;
  return {
    people,
    society: {
      groups: groupMap,
      cultures,
      languages,
      chronicle,
      nextGroupId: json.nextGroupId,
    },
  };
}

/** Empreinte de la population et de la société (tests de déterminisme, ADR 0003). */
export function fingerprintPeople(
  fingerprint: Fingerprint,
  people: Population,
  society: Society,
): void {
  fingerprint.uint32(people.end).uint32(people.count).uint32(people.nextId);
  for (const name of LIVING_COLUMN_NAMES) {
    fingerprint
      .string(name)
      .typedArray(people.columns[name].subarray(0, people.end * LIVING_COLUMNS[name].width));
  }
  fingerprint.typedArray(people.alive.subarray(0, people.end));
  for (const slot of people.free) fingerprint.uint32(slot);
  fingerprint.typedArray(people.where.subarray(0, people.nextId));
  const rows = people.archive.rows;
  for (const name of ARCHIVE_COLUMN_NAMES) {
    fingerprint
      .string(name)
      .typedArray(people.archive.columns[name].subarray(0, rows * ARCHIVE_COLUMNS[name].width));
  }
  // Champ par champ, dans un ordre fixe : l'ordre des clés d'un objet relu peut différer.
  for (const group of society.groups.values()) {
    for (const value of [
      group.id,
      group.culture,
      group.founded,
      group.parent,
      group.leader,
      group.x,
      group.y,
      group.homeX,
      group.homeY,
      group.targetX,
      group.targetY,
    ]) {
      fingerprint.float64(value);
    }
    fingerprint.float64(group.food);
  }
  for (const culture of society.cultures) {
    fingerprint.uint32(culture.id).uint32(culture.language).string(culture.naming);
    fingerprint.float64(culture.founded);
  }
  for (const language of society.languages) fingerprint.uint32(language.id).uint32(language.seed);
  for (const entry of society.chronicle) {
    fingerprint.uint32(entry.tick).string(entry.kind);
    for (const value of [
      entry.x,
      entry.y,
      entry.group,
      entry.other,
      entry.leader,
      entry.otherLeader,
      entry.count,
    ]) {
      fingerprint.uint32(value);
    }
  }
  fingerprint.uint32(society.nextGroupId);
}
