/**
 * Sauvegarde de la population et de la société (tâche 2.1 ; ADR 0007, ADR 0011).
 *
 * Les colonnes des vivants et de l'archive partent en binaire, telles quelles, avec la
 * pile des emplacements libres et l'index par identifiant : une partie rechargée
 * parcourt ses vivants dans le même ordre et se poursuit à l'identique (NF-09). Groupes,
 * cultures, langues et chronique partent en JSON.
 *
 * La relecture vérifie tout ce qu'un fichier forgé pourrait fausser : longueurs, index
 * cohérent avec les emplacements et l'archive, identifiants connus, indices du contenu.
 * Les espèces sont nommées, et les génomes réécrits si data/genetics.json a changé
 * l'ordre de ses locus, de ses allèles ou de ses traits (ADR 0006).
 */
import { z } from 'zod';
import type { Catalog } from '../core/data/catalog';
import type { Genetics, Species } from '../core/data';
import { Fingerprint } from '../core/hash';
import { SaveError, type SaveData, type SavedArray } from '../core/save/format';
import {
  Archive,
  ARCHIVE_COLUMN_NAMES,
  ARCHIVE_COLUMNS,
  DEATH_CAUSES,
  GENOME_WORDS,
  LIVING_COLUMN_NAMES,
  LIVING_COLUMNS,
  NONE,
  Population,
  type Column,
  type ColumnConstructor,
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
const MAX_GROUPS = 1 << 16;
const MAX_CHRONICLE = 1 << 20;

const uint32 = z.number().int().min(0).max(0xffffffff);
const int32 = z.number().int().min(-0x80000000).max(0x7fffffff);

const GroupSchema = z
  .object({
    id: z.number().int().min(1),
    culture: z.number().int().min(1),
    founded: int32,
    parent: z.number().int().min(0),
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

const ChronicleSchema = z
  .object({
    tick: z.number().int().min(0),
    kind: z.enum(CHRONICLE_KINDS),
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    group: z.number().int().min(0),
    other: z.number().int().min(0),
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

export const PeopleJsonSchema = z
  .object({
    end: z.number().int().min(0).max(MAX_SLOTS),
    nextId: z.number().int().min(1).max(MAX_IDS),
    archived: z.number().int().min(0).max(MAX_IDS),
    species: z.array(z.string()).max(255),
    genome: GenomeLayoutSchema,
    groups: z.array(z.unknown()).max(MAX_GROUPS),
    cultures: z.array(z.unknown()).max(MAX_GROUPS),
    languages: z.array(z.unknown()).max(MAX_GROUPS),
    chronicle: z.array(z.unknown()).max(MAX_CHRONICLE),
    nextGroupId: z.number().int().min(1).max(MAX_IDS),
  })
  .strict();

export type PeopleJson = z.infer<typeof PeopleJsonSchema>;

/** Contenu dont la population se sert : espèces et génétique. */
export interface PeopleContent {
  readonly species: Catalog<Species>;
  readonly genetics: Genetics;
}

/** Nom d'un tableau de la sauvegarde : « people » ou « archive », puis la colonne. */
const livingArray = (name: string) => `people${name.charAt(0).toUpperCase()}${name.slice(1)}`;
const archiveArray = (name: string) => `archive${name.charAt(0).toUpperCase()}${name.slice(1)}`;

function layout(genetics: Genetics): PeopleJson['genome'] {
  return {
    loci: genetics.loci.map((locus) => ({
      id: locus.id,
      alleles: locus.alleles.map((allele) => allele.id),
    })),
    traits: genetics.traits.map((trait) => trait.id),
  };
}

/** Copie de la population et de la société, prête à sauvegarder. */
export function savePeople(
  people: Population,
  society: Society,
  content: PeopleContent,
): { json: PeopleJson; arrays: Record<string, SavedArray> } {
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
  return {
    json: {
      end: people.end,
      nextId: people.nextId,
      archived: rows,
      species: content.species.entries.map((entry) => entry.id),
      genome: layout(content.genetics),
      groups: [...society.groups.values()].map((group) => ({ ...group })),
      cultures: society.cultures.map((culture) => ({ ...culture })),
      languages: society.languages.map((language) => ({ ...language })),
      chronicle: [...society.chronicle],
      nextGroupId: society.nextGroupId,
    },
    arrays,
  };
}

/** Tableau d'une sauvegarde, de son type et de sa longueur, copié ; SaveError sinon. */
function savedArray(save: SaveData, name: string, type: ColumnConstructor, length: number): Column {
  const array: unknown = save.arrays[name];
  if (!(array instanceof type) || array.length !== length) {
    throw new SaveError('corrupt', `tableau ${name} absent ou de mauvaise taille`);
  }
  return array.slice();
}

function each<T>(items: readonly unknown[], schema: z.ZodType<T>, name: string): T[] {
  return items.map((item) => {
    const parsed = schema.safeParse(item);
    if (!parsed.success) throw new SaveError('corrupt', `${name} illisible`);
    return parsed.data;
  });
}

/**
 * Table de réécriture d'un génome sauvegardé vers l'ordre actuel des locus, allèles et
 * traits ; undefined si l'ordre n'a pas changé. Un locus, un allèle ou un trait disparu
 * rend la sauvegarde trop ancienne.
 */
function genomeRemap(saved: PeopleJson['genome'], genetics: Genetics) {
  const current = layout(genetics);
  if (JSON.stringify(saved) === JSON.stringify(current)) return undefined;
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

function rewriteGenomes(
  genomes: Column,
  count: number,
  remap: NonNullable<ReturnType<typeof genomeRemap>>,
): void {
  const byte = (offset: number, index: number, base: number) =>
    ((genomes[offset + base + (index >> 2)] ?? 0) >>> ((index & 3) * 8)) & 0xff;
  const words = new Uint32Array(GENOME_WORDS);
  for (let person = 0; person < count; person++) {
    const offset = person * GENOME_WORDS;
    words.fill(0);
    const write = (index: number, base: number, value: number) => {
      const word = base + (index >> 2);
      words[word] = ((words[word] ?? 0) | ((value & 0xff) << ((index & 3) * 8))) >>> 0;
    };
    remap.loci.forEach(({ index, alleles }, saved) => {
      const value = byte(offset, saved, 0);
      const maternal = alleles.at(value & 0x0f);
      const paternal = alleles.at(value >> 4);
      if (maternal === undefined || paternal === undefined) {
        throw new SaveError('corrupt', 'génome illisible');
      }
      write(index, 0, maternal | (paternal << 4));
    });
    remap.traits.forEach((index, saved) => {
      write(index, 2, byte(offset, saved, 2));
    });
    genomes.set(words, offset);
  }
}

/**
 * Population et société d'une sauvegarde ; SaveError si elles sont incohérentes. `size`
 * borne les cases des groupes.
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
  if (archived >= nextId) throw new SaveError('corrupt', 'archive incohérente');

  // Société d'abord : les colonnes renvoient à ses identifiants.
  const languages = each(json.languages, LanguageSchema, 'langue');
  const cultures = each(json.cultures, CultureSchema, 'culture');
  const groups = each(json.groups, GroupSchema, 'groupe');
  const chronicle = each(json.chronicle, ChronicleSchema, 'chronique');
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
    groupMap.set(group.id, group);
  }
  let previous = 0;
  for (const entry of chronicle) {
    if (entry.tick < previous || entry.tick > tick) {
      throw new SaveError('corrupt', 'chronique incohérente');
    }
    previous = entry.tick;
  }

  // Colonnes.
  const people = new Population(Math.max(1, end));
  for (const name of LIVING_COLUMN_NAMES) {
    const spec = LIVING_COLUMNS[name];
    const array = savedArray(save, livingArray(name), spec.type, end * spec.width);
    people.columns[name].set(array);
  }
  people.alive.set(savedArray(save, 'peopleAlive', Uint8Array, end));
  const free = save.arrays.peopleFree;
  if (!(free instanceof Int32Array) || free.length > end) {
    throw new SaveError('corrupt', 'emplacements libres illisibles');
  }
  const where = savedArray(save, 'peopleWhere', Int32Array, nextId) as Int32Array<ArrayBuffer>;
  const archive = new Archive(Math.max(1, archived));
  for (const name of ARCHIVE_COLUMN_NAMES) {
    const spec = ARCHIVE_COLUMNS[name];
    archive.columns[name].set(
      savedArray(save, archiveArray(name), spec.type, archived * spec.width),
    );
  }
  archive.rows = archived;

  // Index : chaque vivant et chaque mort y figure une fois, à sa place.
  const seen = new Uint8Array(nextId);
  const known = (id: number) => id === NONE || (id >= 1 && id < nextId);
  const species = json.species.map((id) => {
    const index = content.species.indexOf(id);
    if (index === undefined) throw new SaveError('obsolete', `espèce inconnue : ${id}`);
    return index;
  });
  let count = 0;
  for (let slot = 0; slot < end; slot++) {
    const alive = people.alive[slot] ?? 0;
    if (alive > 1) throw new SaveError('corrupt', 'emplacement illisible');
    if (alive === 0) continue;
    count++;
    const id = people.get('id', slot);
    if (id < 1 || id >= nextId || seen[id] === 1 || where[id] !== slot) {
      throw new SaveError('corrupt', 'index des vivants incohérent');
    }
    seen[id] = 1;
    const kind = species.at(people.get('species', slot));
    if (kind === undefined) throw new SaveError('corrupt', 'espèce hors de la liste');
    people.set('species', slot, kind);
    const group = people.get('group', slot);
    if (
      (group !== NONE && !groupMap.has(group)) ||
      people.get('culture', slot) > cultures.length ||
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
    const kind = species.at(archive.columns.species[row] ?? 0);
    const cause = archive.columns.cause[row] ?? 0;
    if (kind === undefined || cause >= DEATH_CAUSES.length) {
      throw new SaveError('corrupt', 'mort incohérent');
    }
    archive.columns.species[row] = kind;
  }
  for (let id = 1; id < nextId; id++) {
    if (seen[id] !== 1 && where[id] !== -1) throw new SaveError('corrupt', 'index incohérent');
  }

  // Génomes : réécrits si l'ordre des données a changé.
  const remap = genomeRemap(json.genome, content.genetics);
  if (remap !== undefined) {
    rewriteGenomes(people.columns.genome, end, remap);
    rewriteGenomes(archive.columns.genome, archived, remap);
  }

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
    for (const value of [entry.x, entry.y, entry.group, entry.other, entry.count]) {
      fingerprint.uint32(value);
    }
  }
  fingerprint.uint32(society.nextGroupId);
}
