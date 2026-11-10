/**
 * Population (tâche 2.1 ; IND-01, IND-03, ADR 0011).
 *
 * Les vivants occupent des emplacements de colonnes en tableaux typés, une colonne par
 * attribut, sans objet par individu (CLAUDE.md, « Performances »). L'emplacement d'un
 * mort resert au prochain né ; l'identifiant d'un individu, lui, ne resert jamais : il le
 * désigne dans la généalogie, la chronique et l'interface. Les morts passent dans une
 * archive, en colonnes elles aussi, où ils restent consultables (IND-03).
 *
 * Un index, une valeur par identifiant, dit où trouver chacun : l'emplacement d'un
 * vivant, ou la ligne d'un mort dans l'archive.
 *
 * L'ordre des emplacements fait partie de l'état : les systèmes parcourent les vivants
 * dans cet ordre, et la sauvegarde le garde, avec la pile des emplacements libres.
 */

/** Mots du génome de chaque individu (ADR 0011). */
export const GENOME_WORDS = 4;
/** Parts d'ascendance de chaque individu : une par sous-espèce de son espèce, au plus. */
export const ANCESTRY_SLOTS = 4;
/** Total des parts d'ascendance d'un individu. */
export const ANCESTRY_TOTAL = 255;

/** Sexe : 0 féminin, 1 masculin. */
export const FEMALE = 0;
export const MALE = 1;

/** Aucun individu, groupe ou conception : 0 n'est jamais un identifiant. */
export const NONE = 0;
/** Pas de conception en cours, ou pas encore d'accouchement. */
export const NEVER = -0x80000000;

/**
 * Causes de mort (IND-04, SAI-03), dans l'ordre de leur code dans l'archive : une cause
 * nouvelle s'ajoute à la fin.
 */
export const DEATH_CAUSES = [
  'natural',
  'disease',
  'famine',
  'accident',
  'cold',
  'childbirth',
  'heat',
] as const;
export type DeathCause = (typeof DEATH_CAUSES)[number];

export type ColumnConstructor =
  Uint8ArrayConstructor | Uint16ArrayConstructor | Int32ArrayConstructor | Uint32ArrayConstructor;
export type Column =
  | Uint8Array<ArrayBuffer>
  | Uint16Array<ArrayBuffer>
  | Int32Array<ArrayBuffer>
  | Uint32Array<ArrayBuffer>;

interface ColumnSpec {
  readonly type: ColumnConstructor;
  /** Valeurs par individu. */
  readonly width: number;
}

/**
 * Colonnes des vivants. Les dates se comptent en pas (mois) depuis le début de la
 * partie : un individu apparu adulte est né avant le pas 0.
 */
export const LIVING_COLUMNS = {
  /** Identifiant, stable pour toute la partie. */
  id: { type: Uint32Array, width: 1 },
  sex: { type: Uint8Array, width: 1 },
  /** Pas de la naissance. */
  birth: { type: Int32Array, width: 1 },
  /** Espèce : indice dans data/species.json. */
  species: { type: Uint8Array, width: 1 },
  /** Parts de chaque sous-espèce de l'espèce, sur ANCESTRY_TOTAL (métissage, ESP-04). */
  ancestry: { type: Uint8Array, width: ANCESTRY_SLOTS },
  genome: { type: Uint32Array, width: GENOME_WORDS },
  /** Parents et conjoint : identifiants, NONE s'il n'y en a pas. */
  mother: { type: Uint32Array, width: 1 },
  father: { type: Uint32Array, width: 1 },
  partner: { type: Uint32Array, width: 1 },
  /** Groupe nomade : identifiant, NONE hors d'un groupe. */
  group: { type: Uint32Array, width: 1 },
  /** Culture : identifiant (D2 de C2 : celle du foyer, à la naissance). */
  culture: { type: Uint16Array, width: 1 },
  /** Codes du prénom et du nom de famille, que la langue de la culture rend en texte. */
  givenName: { type: Uint32Array, width: 1 },
  familyName: { type: Uint32Array, width: 1 },
  /** État nutritionnel : 255 rassasié, 0 affamé. */
  nutrition: { type: Uint8Array, width: 1 },
  /** Grossesse : pas de la conception (NEVER sans grossesse), et père de l'enfant. */
  conceived: { type: Int32Array, width: 1 },
  pregnantBy: { type: Uint32Array, width: 1 },
  /** Pas du dernier accouchement, NEVER s'il n'y en a pas eu. */
  lastBirth: { type: Int32Array, width: 1 },
} as const satisfies Record<string, ColumnSpec>;

export type LivingColumn = keyof typeof LIVING_COLUMNS;
export const LIVING_COLUMN_NAMES = Object.keys(LIVING_COLUMNS) as LivingColumn[];

/** Colonnes de l'archive des morts : de quoi les nommer, les situer et les dessiner. */
export const ARCHIVE_COLUMNS = {
  id: { type: Uint32Array, width: 1 },
  sex: { type: Uint8Array, width: 1 },
  birth: { type: Int32Array, width: 1 },
  /** Pas de la mort, et sa cause : indice dans DEATH_CAUSES. */
  death: { type: Int32Array, width: 1 },
  cause: { type: Uint8Array, width: 1 },
  species: { type: Uint8Array, width: 1 },
  ancestry: { type: Uint8Array, width: ANCESTRY_SLOTS },
  genome: { type: Uint32Array, width: GENOME_WORDS },
  mother: { type: Uint32Array, width: 1 },
  father: { type: Uint32Array, width: 1 },
  /** Conjoint au moment de la mort. */
  partner: { type: Uint32Array, width: 1 },
  /** Groupe au moment de la mort. */
  group: { type: Uint32Array, width: 1 },
  culture: { type: Uint16Array, width: 1 },
  givenName: { type: Uint32Array, width: 1 },
  familyName: { type: Uint32Array, width: 1 },
} as const satisfies Record<string, ColumnSpec>;

export type ArchiveColumn = keyof typeof ARCHIVE_COLUMNS;
export const ARCHIVE_COLUMN_NAMES = Object.keys(ARCHIVE_COLUMNS) as ArchiveColumn[];

/** Colonnes communes aux vivants et à l'archive : elles passent de l'une à l'autre. */
const SHARED_COLUMNS = ARCHIVE_COLUMN_NAMES.filter(
  (name): name is ArchiveColumn & LivingColumn => name in LIVING_COLUMNS,
);

/** Ce qu'il faut savoir d'un individu pour le faire naître ou apparaître. */
export interface NewPerson {
  readonly sex: number;
  readonly birth: number;
  readonly species: number;
  readonly ancestry: ArrayLike<number>;
  readonly genome: ArrayLike<number>;
  readonly mother: number;
  readonly father: number;
  readonly group: number;
  readonly culture: number;
  readonly givenName: number;
  readonly familyName: number;
}

/** Emplacements alloués au départ, puis doublés au besoin. */
const INITIAL_CAPACITY = 256;

function allocate<Name extends string>(
  specs: Readonly<Record<Name, ColumnSpec>>,
  names: readonly Name[],
  capacity: number,
): Record<Name, Column> {
  const columns = {} as Record<Name, Column>;
  for (const name of names) columns[name] = new specs[name].type(capacity * specs[name].width);
  return columns;
}

/** Tableau de même type, plus long, qui commence par les valeurs de `array`. */
function grown<T extends Column>(array: T, length: number): T {
  const next = new (array.constructor as new (length: number) => T)(length);
  next.set(array);
  return next;
}

/** Archive des morts : des lignes en colonnes, ajoutées dans l'ordre des morts. */
export class Archive {
  rows = 0;
  private capacity: number;
  columns: Record<ArchiveColumn, Column>;

  constructor(capacity = INITIAL_CAPACITY) {
    this.capacity = Math.max(1, capacity);
    this.columns = allocate(ARCHIVE_COLUMNS, ARCHIVE_COLUMN_NAMES, this.capacity);
  }

  /** Ligne neuve, à remplir ; la capacité double au besoin. */
  append(): number {
    if (this.rows === this.capacity) {
      this.capacity *= 2;
      for (const name of ARCHIVE_COLUMN_NAMES) {
        this.columns[name] = grown(this.columns[name], this.capacity * ARCHIVE_COLUMNS[name].width);
      }
    }
    return this.rows++;
  }
}

export class Population {
  /** Emplacements alloués. */
  private capacity: number;
  /** Fin de la zone des emplacements déjà servis : les parcours s'arrêtent là. */
  end = 0;
  /** Nombre de vivants. */
  count = 0;
  /** 1 pour un emplacement occupé, 0 pour un emplacement libre. */
  alive: Uint8Array<ArrayBuffer>;
  columns: Record<LivingColumn, Column>;
  /** Emplacements libres : le dernier libéré resert le premier. */
  free: number[] = [];
  /** Prochain identifiant. */
  nextId = 1;
  /**
   * Index par identifiant : un emplacement de vivant (≥ 0), une ligne d'archive r codée
   * −(r + 2) (≤ −2), ou −1 pour un identifiant inconnu.
   */
  where: Int32Array<ArrayBuffer>;
  /** Archive des morts ; une sauvegarde relue la remplace. */
  archive: Archive;

  constructor(capacity = INITIAL_CAPACITY) {
    this.capacity = Math.max(1, capacity);
    this.alive = new Uint8Array(this.capacity);
    this.columns = allocate(LIVING_COLUMNS, LIVING_COLUMN_NAMES, this.capacity);
    this.where = new Int32Array(INITIAL_CAPACITY).fill(-1);
    this.archive = new Archive();
  }

  /** Emplacement d'un vivant, ou undefined. */
  slotOf(id: number): number | undefined {
    const at = this.where[id] ?? -1;
    return id !== NONE && at >= 0 ? at : undefined;
  }

  /** Ligne d'un mort dans l'archive, ou undefined. */
  archivedRow(id: number): number | undefined {
    const at = this.where[id] ?? -1;
    return id !== NONE && at <= -2 ? -at - 2 : undefined;
  }

  /** Valeur d'une colonne à une seule valeur pour l'emplacement `slot`. */
  get(name: LivingColumn, slot: number): number {
    return this.columns[name][slot] ?? 0;
  }

  set(name: LivingColumn, slot: number, value: number): void {
    this.columns[name][slot] = value;
  }

  /** Âge en pas (mois) au pas `tick`. */
  age(slot: number, tick: number): number {
    return tick - this.get('birth', slot);
  }

  /** Fait naître ou apparaître un individu ; renvoie son emplacement. */
  add(person: NewPerson): number {
    const slot = this.free.pop() ?? this.end++;
    if (slot >= this.capacity) this.grow();
    const id = this.nextId++;
    if (id >= this.where.length) {
      const where = new Int32Array(this.where.length * 2).fill(-1);
      where.set(this.where);
      this.where = where;
    }
    this.where[id] = slot;
    this.alive[slot] = 1;
    this.count++;
    const columns = this.columns;
    columns.id[slot] = id;
    columns.sex[slot] = person.sex;
    columns.birth[slot] = person.birth;
    columns.species[slot] = person.species;
    for (let index = 0; index < ANCESTRY_SLOTS; index++) {
      columns.ancestry[slot * ANCESTRY_SLOTS + index] = person.ancestry[index] ?? 0;
    }
    for (let word = 0; word < GENOME_WORDS; word++) {
      columns.genome[slot * GENOME_WORDS + word] = person.genome[word] ?? 0;
    }
    columns.mother[slot] = person.mother;
    columns.father[slot] = person.father;
    columns.partner[slot] = NONE;
    columns.group[slot] = person.group;
    columns.culture[slot] = person.culture;
    columns.givenName[slot] = person.givenName;
    columns.familyName[slot] = person.familyName;
    columns.nutrition[slot] = 255;
    columns.conceived[slot] = NEVER;
    columns.pregnantBy[slot] = NONE;
    columns.lastBirth[slot] = NEVER;
    return slot;
  }

  /**
   * Mort de l'individu de l'emplacement `slot` au pas `tick` : il passe dans l'archive,
   * son conjoint devient veuf, et l'emplacement se libère.
   */
  remove(slot: number, tick: number, cause: DeathCause): void {
    if (this.alive[slot] !== 1) return;
    const id = this.get('id', slot);
    const row = this.archive.append();
    const archived = this.archive.columns;
    for (const name of SHARED_COLUMNS) {
      const width = LIVING_COLUMNS[name].width;
      const from = this.columns[name];
      const to = archived[name];
      for (let index = 0; index < width; index++) {
        to[row * width + index] = from[slot * width + index] ?? 0;
      }
    }
    archived.death[row] = tick;
    archived.cause[row] = DEATH_CAUSES.indexOf(cause);
    const partner = this.slotOf(this.get('partner', slot));
    if (partner !== undefined && this.get('partner', partner) === id) {
      this.set('partner', partner, NONE);
    }
    this.where[id] = -row - 2;
    this.alive[slot] = 0;
    this.free.push(slot);
    this.count--;
  }

  /** Parcourt les vivants, dans l'ordre des emplacements. */
  forEach(visit: (slot: number) => void): void {
    for (let slot = 0; slot < this.end; slot++) if (this.alive[slot] === 1) visit(slot);
  }

  private grow(): void {
    this.capacity *= 2;
    const alive = new Uint8Array(this.capacity);
    alive.set(this.alive);
    this.alive = alive;
    for (const name of LIVING_COLUMN_NAMES) {
      this.columns[name] = grown(this.columns[name], this.capacity * LIVING_COLUMNS[name].width);
    }
  }
}
