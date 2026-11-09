import { describe, expect, it } from 'vitest';
import {
  decodeSave,
  encodeSave,
  readSave,
  SAVE_FORMAT_VERSION,
  SaveError,
  writeSave,
  type SaveData,
} from './format';

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
    const restored = await readSave(await writeSave(sample));
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
    const restored = decodeSave(bytes);
    for (const array of Object.values(restored.arrays)) expect(array.byteOffset % 8).toBe(0);
  });
});

describe('fichiers refusés', () => {
  it("refuse ce qui n'est pas une sauvegarde", async () => {
    expect((await rejection(readSave(new TextEncoder().encode('bonjour')))).code).toBe('format');
  });

  it('refuse une version plus récente', async () => {
    const bytes = encodeSave(sample, SAVE_FORMAT_VERSION + 1);
    expect((await rejection(readSave(bytes))).code).toBe('version');
  });

  it('refuse un fichier tronqué ou abîmé', async () => {
    const bytes = encodeSave(sample);
    expect((await rejection(readSave(bytes.slice(0, bytes.length - 3)))).code).toBe('corrupt');
    expect((await rejection(readSave(bytes.slice(0, 30)))).code).toBe('corrupt');
    const file = await writeSave(sample);
    expect((await rejection(readSave(file.slice(0, 20)))).code).toBe('corrupt');
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

  it('refusent une version sans migration', async () => {
    const old = encodeSave(sample, SAVE_FORMAT_VERSION - 1);
    expect((await rejection(readSave(old, {}))).code).toBe('version');
  });
});
