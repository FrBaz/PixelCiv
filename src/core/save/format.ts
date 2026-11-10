/**
 * Format des sauvegardes (NF-05, ADR 0007).
 *
 * Une sauvegarde réunit des métadonnées et des données JSON (ce qui n'est pas en
 * tableaux), plus des tableaux typés stockés en binaire. Le conteneur, compressé en
 * gzip, se présente ainsi :
 *
 *   « PXCV » · version (u16) · longueur de l'en-tête (u32) · en-tête JSON (UTF-8)
 *   · tableaux, chacun aligné sur 8 octets, dans l'ordre et sans recouvrement
 *
 * Les nombres sont petit-boutistes. Une version plus ancienne est migrée à la
 * lecture, par les migrations que fournit le propriétaire des données (src/sim/save.ts) ;
 * une version plus récente est refusée. Un fichier ne dépasse jamais MAX_SAVE_BYTES,
 * décompressé ou non : la lecture s'arrête dès que la limite est franchie.
 */
import { z } from 'zod';

export const SAVE_MAGIC = 'PXCV';

/**
 * Version courante du format et de son contenu. Historique : 1, première version ;
 * 2, commandes en attente du prochain pas ; 3, le monde généré de la phase 1, à la
 * place de la grille de test ; 4, la population de la phase 2 (individus, archive des
 * morts, groupes, cultures, langues, chronique) ; 5, les corrections de la relecture de
 * la phase 2, dont la langue du nom de famille de chacun.
 */
export const SAVE_FORMAT_VERSION = 5;

/**
 * Taille maximale d'une sauvegarde, compressée ou non, en octets. Elle borne la mémoire
 * qu'un fichier forgé peut faire allouer ; la plus grande partie de la phase 0 en est
 * loin (2 Mo pour le plus grand monde). À relever quand l'état grossira.
 */
export const MAX_SAVE_BYTES = 64 * 1024 * 1024;

/**
 * Taille maximale de l'en-tête JSON, en octets. JSON.parse le lit avant toute
 * vérification de forme, et son analyse coûte bien plus de mémoire que ses octets :
 * une borne propre l'empêche d'occuper tout MAX_SAVE_BYTES. Le journal des commandes
 * d'une longue partie de la phase 0 tient largement dedans.
 */
export const MAX_HEADER_BYTES = 8 * 1024 * 1024;

export type SavedArray =
  | Uint8Array<ArrayBuffer>
  | Uint16Array<ArrayBuffer>
  | Int16Array<ArrayBuffer>
  | Uint32Array<ArrayBuffer>
  | Int32Array<ArrayBuffer>
  | Float32Array<ArrayBuffer>
  | Float64Array<ArrayBuffer>;

export interface SaveMeta {
  readonly seed: string;
  readonly tick: number;
}

export interface SaveData {
  readonly meta: SaveMeta;
  /** Données sans tableaux typés : journal, flux du générateur… */
  readonly json: unknown;
  readonly arrays: Readonly<Record<string, SavedArray>>;
}

/**
 * Raison d'un refus : pas une sauvegarde, version trop récente, version trop ancienne
 * pour être migrée, fichier abîmé, ou trop gros.
 */
export type SaveErrorCode = 'format' | 'version' | 'obsolete' | 'corrupt' | 'size';

export class SaveError extends Error {
  override readonly name = 'SaveError';
  readonly code: SaveErrorCode;

  constructor(code: SaveErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const ARRAY_TYPES = {
  u8: Uint8Array,
  u16: Uint16Array,
  i16: Int16Array,
  u32: Uint32Array,
  i32: Int32Array,
  f32: Float32Array,
  f64: Float64Array,
} as const;

type ArrayType = keyof typeof ARRAY_TYPES;

function arrayType(array: SavedArray): ArrayType {
  if (array instanceof Uint8Array) return 'u8';
  if (array instanceof Uint16Array) return 'u16';
  if (array instanceof Int16Array) return 'i16';
  if (array instanceof Uint32Array) return 'u32';
  if (array instanceof Int32Array) return 'i32';
  if (array instanceof Float32Array) return 'f32';
  return 'f64';
}

/**
 * Nombre maximal de tableaux d'une sauvegarde. La borne protège aussi la mémoire : Zod
 * vérifie la longueur d'une liste avant ses éléments, au lieu de relever chaque champ
 * invalide de millions d'éléments forgés.
 */
export const MAX_SAVED_ARRAYS = 256;

const HeaderSchema = z
  .object({
    meta: z.object({ seed: z.string(), tick: z.number().int().nonnegative() }).strict(),
    json: z.unknown(),
    arrays: z
      .array(
        z
          .object({
            // Un identifiant simple : ni « __proto__ », ni rien qui ne soit un nom de tableau.
            name: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/),
            type: z.enum(['u8', 'u16', 'i16', 'u32', 'i32', 'f32', 'f64']),
            offset: z.number().int().nonnegative(),
            length: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(MAX_SAVED_ARRAYS),
  })
  .strict();

type Header = z.infer<typeof HeaderSchema>;

/** Migration d'une version à la suivante, sur l'en-tête et les tableaux déjà lus. */
export type Migration = (save: SaveData) => SaveData;

/** Migrations du format : celle de la clé v mène de la version v à v + 1. */
export type Migrations = Readonly<Partial<Record<number, Migration>>>;

const PREFIX_BYTES = 10;
const align = (offset: number) => Math.ceil(offset / 8) * 8;

/** Conteneur binaire d'une sauvegarde, avant compression. */
export function encodeSave(save: SaveData, version = SAVE_FORMAT_VERSION): Uint8Array<ArrayBuffer> {
  const entries = Object.entries(save.arrays);
  let offset = 0;
  const layout = entries.map(([name, array]) => {
    const entry = { name, type: arrayType(array), offset, length: array.length };
    offset = align(offset + array.byteLength);
    return entry;
  });
  const header: Header = { meta: save.meta, json: save.json, arrays: layout };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  // Ce que la lecture refuserait ne s'écrit pas : la sauvegarde échoue tout de suite.
  if (headerBytes.length > MAX_HEADER_BYTES) throw new SaveError('size', 'en-tête trop grand');
  const dataStart = align(PREFIX_BYTES + headerBytes.length);
  const bytes = new Uint8Array(dataStart + offset);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode(SAVE_MAGIC), 0);
  view.setUint16(4, version, true);
  view.setUint32(6, headerBytes.length, true);
  bytes.set(headerBytes, PREFIX_BYTES);
  entries.forEach(([, array], index) => {
    const start = dataStart + (layout[index]?.offset ?? 0);
    bytes.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), start);
  });
  return bytes;
}

const MAGIC_BYTES = new TextEncoder().encode(SAVE_MAGIC);

/** Les octets commencent-ils par « PXCV » ? */
function hasMagic(bytes: Uint8Array): boolean {
  return MAGIC_BYTES.every((byte, index) => bytes[index] === byte);
}

/** Lit un conteneur binaire et le migre jusqu'à la version courante. */
export function decodeSave(bytes: Uint8Array, migrations: Migrations): SaveData {
  if (bytes.length < PREFIX_BYTES || !hasMagic(bytes)) {
    throw new SaveError('format', "ce n'est pas une sauvegarde");
  }
  if (bytes.length > MAX_SAVE_BYTES) throw new SaveError('size', 'sauvegarde trop grande');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  if (version > SAVE_FORMAT_VERSION) {
    throw new SaveError('version', `version ${version}, plus récente que ${SAVE_FORMAT_VERSION}`);
  }
  // Les versions commencent à 1 : 0 ne vient d'aucun jeu.
  if (version === 0) throw new SaveError('corrupt', 'version 0');
  const headerLength = view.getUint32(6, true);
  if (PREFIX_BYTES + headerLength > bytes.length) throw new SaveError('corrupt', 'en-tête tronqué');
  if (headerLength > MAX_HEADER_BYTES) throw new SaveError('size', 'en-tête trop grand');
  let header: Header;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(PREFIX_BYTES, PREFIX_BYTES + headerLength),
    );
    header = HeaderSchema.parse(JSON.parse(text));
  } catch {
    throw new SaveError('corrupt', 'en-tête illisible');
  }
  const dataStart = align(PREFIX_BYTES + headerLength);
  const arrays = new Map<string, SavedArray>();
  // Fin du tableau précédent : chaque tableau commence après, aligné sur 8 octets.
  let end = 0;
  for (const { name, type, offset, length } of header.arrays) {
    const constructor = ARRAY_TYPES[type];
    const byteLength = length * constructor.BYTES_PER_ELEMENT;
    if (arrays.has(name) || offset % 8 !== 0 || offset < end) {
      throw new SaveError('corrupt', `tableau ${name} mal placé`);
    }
    const start = dataStart + offset;
    if (start + byteLength > bytes.length) {
      throw new SaveError('corrupt', `tableau ${name} tronqué`);
    }
    // Copie dans un tampon neuf et aligné, indépendant du fichier.
    const copy = bytes.slice(start, start + byteLength);
    arrays.set(name, new constructor(copy.buffer, 0, length));
    end = offset + byteLength;
  }
  let save: SaveData = { meta: header.meta, json: header.json, arrays: Object.fromEntries(arrays) };
  for (let from = version; from < SAVE_FORMAT_VERSION; from++) {
    const migrate = migrations[from];
    if (migrate === undefined) {
      throw new SaveError('obsolete', `aucune migration depuis la version ${from}`);
    }
    save = migrate(save);
  }
  return save;
}

/** Fichier de sauvegarde : le conteneur, compressé en gzip. */
export async function writeSave(save: SaveData): Promise<Uint8Array<ArrayBuffer>> {
  const output = new Blob([encodeSave(save)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(output).arrayBuffer());
}

/**
 * Décompresse un fichier, en s'arrêtant dès qu'il dépasse MAX_SAVE_BYTES ou que son
 * début n'est pas celui d'une sauvegarde : un fichier forgé ne peut pas épuiser la
 * mémoire.
 */
async function inflate(file: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const reader = new Blob([file]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let checked = false;
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch {
        throw new SaveError('corrupt', 'compression illisible');
      }
      if (chunk.done) break;
      chunks.push(chunk.value);
      total += chunk.value.byteLength;
      if (total > MAX_SAVE_BYTES) throw new SaveError('size', 'sauvegarde trop grande');
      if (!checked && total >= MAGIC_BYTES.length) {
        if (!hasMagic(concat(chunks, MAGIC_BYTES.length))) {
          throw new SaveError('format', "ce n'est pas une sauvegarde");
        }
        checked = true;
      }
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  }
  return concat(chunks, total);
}

/** Les `length` premiers octets des morceaux, mis bout à bout. */
function concat(chunks: readonly Uint8Array[], length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= length) break;
    const part = chunk.subarray(0, length - offset);
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

/** Lit un fichier de sauvegarde, compressé ou non, et le migre à la version courante. */
export async function readSave(
  file: Uint8Array<ArrayBuffer>,
  migrations: Migrations,
): Promise<SaveData> {
  if (file.length > MAX_SAVE_BYTES) throw new SaveError('size', 'fichier trop grand');
  const gzip = file[0] === 0x1f && file[1] === 0x8b;
  return decodeSave(gzip ? await inflate(file) : file, migrations);
}
