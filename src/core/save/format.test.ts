import { describe, expect, it } from 'vitest';
import {
  decodeSave,
  encodeSave,
  MAX_HEADER_BYTES,
  MAX_SAVE_BYTES,
  readSave,
  SAVE_FORMAT_VERSION,
  SaveError,
  writeSave,
  type SaveData,
} from './format';

/** Pas de migration : les fichiers de ces tests sont à la version courante. */
const NONE = {};

/** Mémoire des ArrayBuffer du processus (Node), en octets. */
const arrayBuffers = () =>
  (
    globalThis as unknown as { process: { memoryUsage(): { arrayBuffers: number } } }
  ).process.memoryUsage().arrayBuffers;

const sample: SaveData = {
  meta: { seed: 'graine', tick: 42 },
  json: { log: [{ tick: 3, command: { type: 'paint', x: 1, y: 2, value: 3 } }], note: 'é' },
  arrays: {
    layer: Uint8Array.of(0, 1, 2, 255, 7),
    walkers: Uint16Array.of(511, 0, 300),
    counts: Uint32Array.of(4294967295, 1),
    signed: Int32Array.of(-5, 5),
    heights: Float32Array.of(0.5, -1.25),
    precise: Float64Array.of(Math.PI, -0),
  },
};

async function rejection(promise: Promise<unknown>): Promise<SaveError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SaveError) return error;
    throw error;
  }
  throw new Error('la lecture aurait dû échouer');
}

describe('sauvegarde', () => {
  it('retrouve métadonnées, données et tableaux, types compris', async () => {
    const restored = await readSave(await writeSave(sample), NONE);
    expect(restored.meta).toEqual(sample.meta);
    expect(restored.json).toEqual(sample.json);
    for (const [name, array] of Object.entries(sample.arrays)) {
      expect(restored.arrays[name].constructor).toBe(array.constructor);
      expect(Array.from(restored.arrays[name])).toEqual(Array.from(array));
    }
  });

  it('est compressée en gzip', async () => {
    const file = await writeSave(sample);
    expect([file[0], file[1]]).toEqual([0x1f, 0x8b]);
    const big = { ...sample, arrays: { zeros: new Uint8Array(100_000) } };
    expect((await writeSave(big)).length).toBeLessThan(1000);
  });

  it('commence par « PXCV » et la version, puis aligne les tableaux sur 8 octets', () => {
    const bytes = encodeSave(sample);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('PXCV');
    expect(new DataView(bytes.buffer).getUint16(4, true)).toBe(SAVE_FORMAT_VERSION);
    const restored = decodeSave(bytes, NONE);
    for (const array of Object.values(restored.arrays)) expect(array.byteOffset % 8).toBe(0);
  });
});

describe('fichiers refusés', () => {
  it("refuse ce qui n'est pas une sauvegarde", async () => {
    expect((await rejection(readSave(new TextEncoder().encode('bonjour'), NONE))).code).toBe(
      'format',
    );
  });

  it('refuse une version plus récente', async () => {
    const bytes = encodeSave(sample, SAVE_FORMAT_VERSION + 1);
    expect((await rejection(readSave(bytes, NONE))).code).toBe('version');
  });

  it('refuse un fichier tronqué ou abîmé', async () => {
    const bytes = encodeSave(sample);
    expect((await rejection(readSave(bytes.slice(0, bytes.length - 3), NONE))).code).toBe(
      'corrupt',
    );
    expect((await rejection(readSave(bytes.slice(0, 30), NONE))).code).toBe('corrupt');
    const file = await writeSave(sample);
    expect((await rejection(readSave(file.slice(0, 20), NONE))).code).toBe('corrupt');
  });
});

describe('migrations', () => {
  it("font passer une ancienne version à la version courante, l'une après l'autre", async () => {
    const old = encodeSave({ ...sample, json: { ancien: true } }, SAVE_FORMAT_VERSION - 1);
    const restored = await readSave(old, {
      [SAVE_FORMAT_VERSION - 1]: (save) => ({ ...save, json: { migré: save.json } }),
    });
    expect(restored.json).toEqual({ migré: { ancien: true } });
  });

  it('jugent trop ancienne une version sans migration', async () => {
    const old = encodeSave(sample, SAVE_FORMAT_VERSION - 1);
    expect((await rejection(readSave(old, NONE))).code).toBe('obsolete');
  });

  it("refusent la version 0, qu'aucun jeu n'a écrite", async () => {
    expect((await rejection(readSave(encodeSave(sample, 0), NONE))).code).toBe('corrupt');
  });
});

/** Conteneur forgé : l'en-tête donné tel quel, puis `data` après l'alignement. */
function forged(header: unknown, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const dataStart = Math.ceil((10 + headerBytes.length) / 8) * 8;
  const bytes = new Uint8Array(dataStart + data.length);
  bytes.set(new TextEncoder().encode('PXCV'));
  const view = new DataView(bytes.buffer);
  view.setUint16(4, SAVE_FORMAT_VERSION, true);
  view.setUint32(6, headerBytes.length, true);
  bytes.set(headerBytes, 10);
  bytes.set(data, dataStart);
  return bytes;
}

describe('disposition des tableaux', () => {
  const header = (arrays: object[]) => ({ meta: { seed: 'graine', tick: 1 }, json: null, arrays });
  const data = new Uint8Array(64);

  it('refuse un tableau mal aligné, recouvert, au nom répété ou réservé', () => {
    const layouts = [
      [{ name: 'a', type: 'u8', offset: 3, length: 4 }],
      // a occupe 16 octets : b, à 8, le recouvre.
      [
        { name: 'a', type: 'u32', offset: 0, length: 4 },
        { name: 'b', type: 'u8', offset: 8, length: 4 },
      ],
      [
        { name: 'b', type: 'u8', offset: 16, length: 4 },
        { name: 'a', type: 'u8', offset: 0, length: 4 },
      ],
      [
        { name: 'a', type: 'u8', offset: 0, length: 4 },
        { name: 'a', type: 'u8', offset: 8, length: 4 },
      ],
      [{ name: '__proto__', type: 'u8', offset: 0, length: 4 }],
      [{ name: 'a', type: 'u8', offset: 0, length: 4, extra: 1 }],
    ];
    for (const layout of layouts) {
      expect(() => decodeSave(forged(header(layout), data), NONE), JSON.stringify(layout)).toThrow(
        SaveError,
      );
    }
  });

  it("admet des tableaux dans l'ordre, alignés et disjoints", () => {
    const save = decodeSave(
      forged(
        header([
          { name: 'a', type: 'u32', offset: 0, length: 4 },
          { name: 'b', type: 'u8', offset: 16, length: 4 },
        ]),
        data,
      ),
      NONE,
    );
    expect(Object.keys(save.arrays)).toEqual(['a', 'b']);
    expect(save.arrays.a).toBeInstanceOf(Uint32Array);
  });
});

/** Compresse des octets en gzip. */
async function gzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const output = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(output).arrayBuffer());
}

describe('taille', () => {
  it('refuse un fichier trop grand sans le lire', async () => {
    const file = new Uint8Array(MAX_SAVE_BYTES + 1);
    file.set(new TextEncoder().encode('PXCV'));
    expect((await rejection(readSave(file, NONE))).code).toBe('size');
  });

  it('arrête la décompression dès que la limite est franchie', async () => {
    const huge = new Uint8Array(MAX_SAVE_BYTES + 1024);
    huge.set(new TextEncoder().encode('PXCV'));
    const bomb = await gzip(huge);
    expect(bomb.length).toBeLessThan(MAX_SAVE_BYTES / 100);
    expect((await rejection(readSave(bomb, NONE))).code).toBe('size');
  });

  it("refuse vite une liste de tableaux forgée de millions d'entrées", () => {
    const header = {
      meta: { seed: 'graine', tick: 1 },
      json: 0,
      arrays: new Array(2_000_000).fill({}),
    };
    const start = performance.now();
    expect(() => decodeSave(forged(header, new Uint8Array(0)), NONE)).toThrow(SaveError);
    // Zod vérifie la longueur avant les éléments : ni millions d'erreurs, ni secondes.
    expect(performance.now() - start).toBeLessThan(3000);
  });

  it("refuse d'écrire un en-tête que la lecture refuserait", () => {
    const big = { ...sample, json: { log: 'x'.repeat(MAX_HEADER_BYTES) } };
    expect(() => encodeSave(big)).toThrow(expect.objectContaining({ code: 'size' }) as Error);
  });

  it("refuse d'écrire, avant d'allouer le conteneur, des tableaux que la lecture refuserait", async () => {
    // Avec l'en-tête, ces tableaux dépassent la borne.
    const big = { ...sample, arrays: { big: new Uint8Array(MAX_SAVE_BYTES) } };
    // Alloué, le conteneur pèserait 256 Mio de plus : la mémoire des ArrayBuffer du processus
    // n'en montre rien. La mesure se fait autour de encodeSave seul : autour de writeSave, le
    // ramasse-miettes, qui libère des tampons plus anciens, la fausserait.
    const before = arrayBuffers();
    expect(() => encodeSave(big)).toThrow(expect.objectContaining({ code: 'size' }) as Error);
    expect(arrayBuffers() - before).toBeLessThan(16 * 1024 * 1024);
    expect((await rejection(writeSave(big))).code).toBe('size');
  });

  it("refuse un en-tête trop grand avant de l'analyser", () => {
    const filler = '[],'.repeat(Math.ceil(MAX_HEADER_BYTES / 3));
    const header = { meta: { seed: 'graine', tick: 1 }, json: `[${filler}[]]`, arrays: [] };
    expect(() => decodeSave(forged(header, new Uint8Array(0)), NONE)).toThrow(
      expect.objectContaining({ code: 'size' }) as Error,
    );
  });

  it("s'arrête au début d'un fichier compressé qui n'est pas une sauvegarde", async () => {
    // Plus gros que la limite : seul l'examen du début peut répondre « format ».
    const bomb = await gzip(new Uint8Array(MAX_SAVE_BYTES + 1024));
    expect((await rejection(readSave(bomb, NONE))).code).toBe('format');
  });
});
