/**
 * Format des sauvegardes (NF-05, ADR 0007).
 *
 * Une sauvegarde réunit des métadonnées et des données JSON (ce qui n'est pas en
 * tableaux), plus des tableaux typés stockés en binaire. Le conteneur, compressé en
 * gzip, se présente ainsi :
 *
 *   « PXCV » · version (u16) · longueur de l'en-tête (u32) · en-tête JSON (UTF-8)
 *   · tableaux, chacun aligné sur 8 octets
 *
 * Les nombres sont petit-boutistes. Une version plus ancienne est migrée à la
 * lecture ; une version plus récente est refusée.
 */
import { z } from 'zod';

export const SAVE_MAGIC = 'PXCV';

/** Version courante du format. */
export const SAVE_FORMAT_VERSION = 1;

export type SavedArray =
  | Uint8Array<ArrayBuffer>
  | Uint16Array<ArrayBuffer>
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

/** Raison d'un refus : pas une sauvegarde, version trop récente, ou fichier abîmé. */
export type SaveErrorCode = 'format' | 'version' | 'corrupt';

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
  u32: Uint32Array,
  i32: Int32Array,
  f32: Float32Array,
  f64: Float64Array,
} as const;

type ArrayType = keyof typeof ARRAY_TYPES;

function arrayType(array: SavedArray): ArrayType {
  if (array instanceof Uint8Array) return 'u8';
  if (array instanceof Uint16Array) return 'u16';
  if (array instanceof Uint32Array) return 'u32';
  if (array instanceof Int32Array) return 'i32';
  if (array instanceof Float32Array) return 'f32';
  return 'f64';
}

const HeaderSchema = z.object({
  meta: z.object({ seed: z.string(), tick: z.number().int().nonnegative() }),
  json: z.unknown(),
  arrays: z.array(
    z.object({
      name: z.string(),
      type: z.enum(['u8', 'u16', 'u32', 'i32', 'f32', 'f64']),
      offset: z.number().int().nonnegative(),
      length: z.number().int().nonnegative(),
    }),
  ),
});

type Header = z.infer<typeof HeaderSchema>;

/** Migration d'une version à la suivante, sur l'en-tête et les tableaux déjà lus. */
export type Migration = (save: SaveData) => SaveData;

/** Migrations du format : celle de la clé v mène de la version v à v + 1. */
export const MIGRATIONS: Readonly<Partial<Record<number, Migration>>> = {};

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

/** Lit un conteneur binaire et le migre jusqu'à la version courante. */
export function decodeSave(
  bytes: Uint8Array,
  migrations: Readonly<Partial<Record<number, Migration>>> = MIGRATIONS,
): SaveData {
  if (
    bytes.length < PREFIX_BYTES ||
    new TextDecoder().decode(bytes.subarray(0, 4)) !== SAVE_MAGIC
  ) {
    throw new SaveError('format', "ce n'est pas une sauvegarde");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  if (version > SAVE_FORMAT_VERSION) {
    throw new SaveError('version', `version ${version}, plus récente que ${SAVE_FORMAT_VERSION}`);
  }
  const headerLength = view.getUint32(6, true);
  if (PREFIX_BYTES + headerLength > bytes.length) throw new SaveError('corrupt', 'en-tête tronqué');
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
  const arrays: Record<string, SavedArray> = {};
  for (const { name, type, offset, length } of header.arrays) {
    const constructor = ARRAY_TYPES[type];
    const start = dataStart + offset;
    const byteLength = length * constructor.BYTES_PER_ELEMENT;
    if (start + byteLength > bytes.length)
      throw new SaveError('corrupt', `tableau ${name} tronqué`);
    // Copie dans un tampon neuf et aligné, indépendant du fichier.
    const copy = bytes.slice(start, start + byteLength);
    arrays[name] = new constructor(copy.buffer, 0, length);
  }
  let save: SaveData = { meta: header.meta, json: header.json, arrays };
  for (let from = version; from < SAVE_FORMAT_VERSION; from++) {
    const migrate = migrations[from];
    if (migrate === undefined)
      throw new SaveError('version', `aucune migration depuis la version ${from}`);
    save = migrate(save);
  }
  return save;
}

async function transform(
  bytes: Uint8Array<ArrayBuffer>,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array<ArrayBuffer>> {
  const output = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(output).arrayBuffer());
}

/** Fichier de sauvegarde : le conteneur, compressé en gzip. */
export async function writeSave(save: SaveData): Promise<Uint8Array<ArrayBuffer>> {
  return transform(encodeSave(save), new CompressionStream('gzip'));
}

/** Lit un fichier de sauvegarde, compressé ou non. */
export async function readSave(
  file: Uint8Array<ArrayBuffer>,
  migrations: Readonly<Partial<Record<number, Migration>>> = MIGRATIONS,
): Promise<SaveData> {
  const gzip = file[0] === 0x1f && file[1] === 0x8b;
  let bytes = file;
  if (gzip) {
    try {
      bytes = await transform(file, new DecompressionStream('gzip'));
    } catch {
      throw new SaveError('corrupt', 'compression illisible');
    }
  }
  return decodeSave(bytes, migrations);
}
