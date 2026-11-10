import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../core/data/catalog';
import { BiomesSchema } from '../core/data/schemas';
import { encodeSave, readSave, SaveError, writeSave } from '../core/save/format';
import { LAYER_NAMES } from '../core/world';
import { GENERATOR_VERSION } from '../worldgen/generate';
import { MIGRATIONS, restoreState, saveState } from './save';
import type { SimState } from './state';
import { fingerprint, step } from './step';
import { cellsOf, firstCellOf, testData, testState } from './testing';
import biomesJson from '../../data/biomes.json';

const land = (family: string) => family !== 'water';

function played(ticks: number): SimState {
  const state = testState();
  const cells = cellsOf(state, land, ticks);
  for (let tick = 0; tick < ticks; tick++) {
    const cell = cells.at(tick);
    step(
      state,
      tick % 5 === 0 && cell !== undefined
        ? [{ type: 'paintBiome', ...cell, biome: 'desert' }]
        : [],
      testData,
    );
  }
  return state;
}

const save = (state: SimState) => saveState(state, GENERATOR_VERSION, testData);
const restore = (data: Parameters<typeof restoreState>[0]) => restoreState(data, testData);

describe('sauvegarde de la simulation', () => {
  it("redonne exactement l'état sauvegardé, monde compris", async () => {
    const state = played(30);
    const restored = restore(await readSave(await writeSave(save(state)), MIGRATIONS));
    expect(fingerprint(restored)).toBe(fingerprint(state));
    expect(restored.commandLog).toEqual(state.commandLog);
    expect(restored.params).toEqual(state.params);
  });

  it("se poursuit à l'identique après rechargement", async () => {
    const original = played(30);
    const restored = restore(await readSave(await writeSave(save(original)), MIGRATIONS));
    const cell = firstCellOf(original, land);
    for (let tick = 0; tick < 20; tick++) {
      const commands = tick === 3 ? [{ type: 'paintBiome' as const, ...cell, biome: 'taiga' }] : [];
      step(original, commands, testData);
      step(restored, commands, testData);
    }
    expect(fingerprint(restored)).toBe(fingerprint(original));
  });

  it('garde toutes les couches du monde, sous un fichier de taille raisonnable', async () => {
    const data = save(played(2));
    for (const name of LAYER_NAMES) expect(data.arrays[name]).toBeDefined();
    const file = await writeSave(data);
    // Un monde Petit tient en quelques centaines de kilo-octets compressés.
    expect(file.byteLength).toBeLessThan(1_500_000);
  });

  it("n'est pas modifiée par la suite de la partie", () => {
    const state = played(3);
    const data = save(state);
    const before = JSON.stringify({ json: data.json, biome: Array.from(data.arrays.biome) });
    const cell = firstCellOf(state, land);
    state.pending.push({ type: 'paintBiome', ...cell, biome: 'glacier' });
    step(state, state.pending.splice(0), testData);
    expect(JSON.stringify({ json: data.json, biome: Array.from(data.arrays.biome) })).toBe(before);
  });

  it("garde les commandes en attente, qui s'appliquent après rechargement", async () => {
    const original = played(4);
    const cell = firstCellOf(original, land);
    original.pending.push({ type: 'paintBiome', ...cell, biome: 'savanna' });
    const restored = restore(await readSave(await writeSave(save(original)), MIGRATIONS));
    expect(restored.pending).toEqual(original.pending);
    step(original, original.pending.splice(0), testData);
    step(restored, restored.pending.splice(0), testData);
    expect(fingerprint(restored)).toBe(fingerprint(original));
  });

  it('se relit après un changement du contenu, en suivant les identifiants', () => {
    const state = played(2);
    // Le contenu de demain : les mêmes biomes, dans l'ordre inverse.
    const reversed = loadCatalog('biomes.json', BiomesSchema, [...biomesJson].reverse());
    const data = saveState(state, GENERATOR_VERSION, { ...testData, biomes: reversed });
    const restored = restoreState(data, { ...testData, biomes: reversed });
    expect(restored.world.biome).toEqual(state.world.biome);
    // Relue avec le contenu d'aujourd'hui, chaque case garde son biome, sous son nouvel indice.
    const today = restoreState(data, testData);
    const id = (index: number, catalog: typeof reversed) => catalog.entries.at(index)?.id;
    for (let cell = 0; cell < state.world.biome.length; cell += 997) {
      expect(id(today.world.biome[cell] ?? 0, testData.biomes)).toBe(
        id(restored.world.biome[cell] ?? 0, reversed),
      );
    }
  });

  it('refuse une sauvegarde dont un biome a disparu du contenu', () => {
    const data = save(played(1));
    const json = data.json as { content: { biomes: string[] } };
    const forged = {
      ...data,
      json: {
        ...json,
        content: { ...json.content, biomes: ['volcan', ...json.content.biomes.slice(1)] },
      },
    };
    expect(() => restore(forged)).toThrow(SaveError);
    try {
      restore(forged);
    } catch (error) {
      expect((error as SaveError).code).toBe('obsolete');
    }
  });

  it('refuse les sauvegardes de la phase 0, sans monde à reprendre', async () => {
    // Seule la version 3, celle de la phase 1, se migre : elle reçoit une population vide.
    expect(Object.keys(MIGRATIONS)).toEqual(['3']);
    for (let version = 1; version < 3; version++) {
      const old = encodeSave(save(played(1)), version);
      await expect(readSave(old, MIGRATIONS)).rejects.toMatchObject({ code: 'obsolete' });
    }
  });

  it('refuse vite, sans épuiser la mémoire, un journal forgé de millions de commandes', () => {
    const data = save(played(3));
    const forged = {
      ...data,
      json: { ...(data.json as object), commandLog: new Array(2_000_000).fill({}) },
    };
    const start = performance.now();
    expect(() => restore(forged)).toThrow(SaveError);
    expect(performance.now() - start).toBeLessThan(3000);
  });

  it('refuse vite des flux forgés, trop nombreux ou illisibles', () => {
    const data = save(played(3));
    const json = data.json as Record<string, unknown>;
    const invalid = Object.fromEntries(
      Array.from({ length: 300_000 }, (_, i) => [`K${String(i)}`, [{}, {}, {}, {}]]),
    );
    const many = Object.fromEntries(
      Array.from({ length: 1025 }, (_, i) => [`flux${String(i)}`, [1, 2, 3, 4]]),
    );
    for (const rng of [invalid, many]) {
      const start = performance.now();
      expect(() => restore({ ...data, json: { ...json, rng } })).toThrow(SaveError);
      expect(performance.now() - start).toBeLessThan(3000);
    }
  });

  it('rend un état qui ne partage rien avec la sauvegarde', () => {
    const data = save(played(5));
    const first = restore(data);
    const second = restore(data);
    expect(first.world.biome).not.toBe(second.world.biome);
    expect(first.world.biome).not.toBe(data.arrays.biome);
    const before = fingerprint(second);
    const cell = firstCellOf(first, land);
    step(first, [{ type: 'paintBiome', ...cell, biome: 'glacier' }], testData);
    expect(fingerprint(second)).toBe(before);
  });

  it('refuse un état incohérent', () => {
    const data = save(played(3));
    const json = data.json as Record<string, unknown>;
    const params = json.params as Record<string, unknown>;
    const paint = { type: 'paintBiome', x: 1, y: 1, biome: 'desert' };
    const count = 512 * 256;
    const cases: [string, object][] = [
      ['taille inconnue', { json: { ...json, params: { ...params, size: 'géante' } } }],
      ['paramètre hors bornes', { json: { ...json, params: { ...params, relief: 7 } } }],
      ['graine différente', { json: { ...json, params: { ...params, seed: 'autre' } } }],
      ['couche absente', { arrays: { ...data.arrays, biome: undefined } }],
      ['couche trop courte', { arrays: { ...data.arrays, elevation: new Int16Array(3) } }],
      ['couche de mauvais type', { arrays: { ...data.arrays, elevation: new Uint16Array(count) } }],
      [
        'biome hors de la liste',
        { arrays: { ...data.arrays, biome: new Uint8Array(count).fill(200) } },
      ],
      [
        'gisement hors de la liste',
        { arrays: { ...data.arrays, deposit: new Uint8Array(count).fill(99) } },
      ],
      [
        'écoulement illisible',
        { arrays: { ...data.arrays, drainage: new Uint8Array(count).fill(9) } },
      ],
      ['commande future', { json: { ...json, commandLog: [{ tick: 3, command: paint }] } }],
      [
        'journal désordonné',
        {
          json: {
            ...json,
            commandLog: [
              { tick: 2, command: paint },
              { tick: 1, command: paint },
            ],
          },
        },
      ],
      [
        'commande inconnue',
        { json: { ...json, commandLog: [{ tick: 0, command: { type: 'feu' } }] } },
      ],
      ['état du générateur nul', { json: { ...json, rng: { flux: [0, 0, 0, 0] } } }],
      ['commande en attente invalide', { json: { ...json, pending: [{ ...paint, x: 0.5 }] } }],
      ['version du générateur absente', { json: { ...json, generator: undefined } }],
    ];
    for (const [label, patch] of cases) {
      expect(() => restore({ ...data, ...patch }), label).toThrow(SaveError);
    }
  });
});
