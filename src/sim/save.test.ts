import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../core/data/catalog';
import { BiomesSchema } from '../core/data/schemas';
import {
  encodeSave,
  readSave,
  SaveError,
  writeSave,
  type SaveData,
  type SavedArray,
} from '../core/save/format';
import { LAYER_NAMES } from '../core/world';
import { GENERATOR_VERSION } from '../worldgen/generate';
import { replay } from './replay';
import { MIGRATIONS, restoreState, saveState } from './save';
import type { SimState } from './state';
import { advanceDay, step } from './day';
import { applyCommands, fingerprint } from './step';
import {
  cellsOf,
  firstCellOf,
  scatteredGroups,
  testData,
  testParams,
  testState,
  testWorld,
} from './testing';
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

  it('se relit, prise en pause juste après des commandes appliquées aussitôt (U-7)', async () => {
    const original = testState();
    step(original, [], testData);
    step(original, [], testData);
    // En pause, l'hôte applique les commandes dès leur réception (applyCommands) : elles se
    // journalisent au pas courant, qui n'a pas encore commencé, et la sauvegarde aussi.
    const cell = firstCellOf(original, land);
    applyCommands(
      original,
      [...scatteredGroups(original, 2, 12), { type: 'paintBiome', ...cell, biome: 'desert' }],
      testData,
    );
    const data = save(original);
    expect(data.meta.tick).toBe(2);
    expect(original.commandLog.map((entry) => entry.tick)).toEqual([2, 2, 2]);
    const restored = restore(await readSave(await writeSave(data), MIGRATIONS));
    expect(fingerprint(restored)).toBe(fingerprint(original));
    expect(restored.commandLog).toEqual(original.commandLog);
    expect(restored.society.groups.size).toBe(2);
    // Le rejeu du journal redonne l'état sauvegardé, commandes du pas courant comprises.
    const replayed = replay(
      testParams(),
      testWorld(),
      restored.commandLog,
      { tick: 2, day: 0 },
      testData,
    );
    expect(fingerprint(replayed)).toBe(fingerprint(original));
    // La partie relue se poursuit à l'identique.
    for (let month = 0; month < 24; month++) {
      step(original, [], testData);
      step(restored, [], testData);
    }
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

  it('relit les stocks des cases entamées, et refuse des stocks forgés', () => {
    const data = save(played(1));
    const count = 512 * 256;
    const stocks = (
      cells: SaveData['arrays'][string],
      plants: number[],
      arrays: SaveData['arrays'] = {},
    ): SaveData => ({
      ...data,
      arrays: {
        ...data.arrays,
        foodCells: cells,
        foodPlants: Float32Array.from(plants),
        foodGame: Float32Array.of(2, 0),
        foodFish: Float32Array.of(0, 0.5),
        ...arrays,
      },
    });
    const valid = stocks(Int32Array.of(5, 9), [1, 3]);
    const noFish = Object.fromEntries(
      Object.entries(valid.arrays).filter(([name]) => name !== 'foodFish'),
    );
    // Témoin : deux cases entamées, relues à leur place.
    const restored = restore(valid);
    expect(restored.food.count).toBe(2);
    expect(Array.from(restored.food.stocks.subarray(9 * 3, 9 * 3 + 3))).toEqual([3, 0, 0.5]);
    const cases: [string, SaveData][] = [
      ['case en double', stocks(Int32Array.of(5, 5), [1, 3])],
      ['case négative', stocks(Int32Array.of(-1, 9), [1, 3])],
      ['case hors du monde', stocks(Int32Array.of(5, count), [1, 3])],
      ['stock NaN', stocks(Int32Array.of(5, 9), [Number.NaN, 3])],
      ['stock infini', stocks(Int32Array.of(5, 9), [Number.POSITIVE_INFINITY, 3])],
      ['stock négatif', stocks(Int32Array.of(5, 9), [-1, 3])],
      ['stock démesuré', stocks(Int32Array.of(5, 9), [1e7, 3])],
      ['gibier trop court', stocks(Int32Array.of(5, 9), [1, 3], { foodGame: Float32Array.of(2) })],
      ['poisson absent', { ...valid, arrays: noFish }],
      [
        'plantes de mauvais type',
        stocks(Int32Array.of(5, 9), [1, 3], { foodPlants: Float64Array.of(1, 3) }),
      ],
      [
        'cases de mauvais type',
        stocks(Int32Array.of(5, 9), [1, 3], { foodCells: Uint32Array.of(5, 9) }),
      ],
    ];
    for (const [label, forged] of cases) {
      expect(() => restore(forged), label).toThrow(
        expect.objectContaining({ code: 'corrupt' }) as Error,
      );
    }
  });

  it('refuse les sauvegardes de la phase 0, sans monde à reprendre', async () => {
    // Seules les versions 3, celle de la phase 1, qui reçoit une population vide, 4, celle
    // de la phase 2 avant sa relecture, et 5, celle d'avant les deux horloges, se migrent.
    expect(Object.keys(MIGRATIONS)).toEqual(['3', '4', '5']);
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
    // Témoin : le journal va jusqu'au pas courant compris, où l'hôte journalise une commande
    // appliquée en pause, avant que ce pas ne commence (U-7).
    const current = [{ tick: data.meta.tick, day: 0, command: paint }];
    expect(restore({ ...data, json: { ...json, commandLog: current } }).commandLog).toEqual(
      current,
    );
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
      [
        'commande future',
        { json: { ...json, commandLog: [{ tick: data.meta.tick + 1, day: 0, command: paint }] } },
      ],
      [
        'journal désordonné',
        {
          json: {
            ...json,
            commandLog: [
              { tick: 2, day: 0, command: paint },
              { tick: 1, day: 0, command: paint },
            ],
          },
        },
      ],
      [
        'commande inconnue',
        { json: { ...json, commandLog: [{ tick: 0, day: 0, command: { type: 'feu' } }] } },
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

describe('sauvegarde des deux horloges (ADR 0013)', () => {
  /** Une partie de groupes nomades, arrêtée au jour `day` d'un mois où ils marchent. */
  function midMonth(day: number): SimState {
    const state = testState();
    step(state, scatteredGroups(state, 30, 30), testData);
    step(state, [], testData);
    for (let passed = 0; passed < day; passed++) advanceDay(state, [], testData);
    return state;
  }

  it('se relit en cours de mois, marches comprises, et se poursuit à l’identique', async () => {
    const original = midMonth(11);
    expect(original.walks.count).toBeGreaterThan(10);
    expect(original.dayPositions.walking).toBeGreaterThan(0);
    const data = save(original);
    expect(data.meta).toEqual({ seed: 'graine', tick: 2 });
    expect((data.json as { day: number }).day).toBe(11);
    const restored = restore(await readSave(await writeSave(data), MIGRATIONS));
    expect([restored.tick, restored.day]).toEqual([2, 11]);
    expect(restored.walks.arrays()).toEqual(original.walks.arrays());
    expect(fingerprint(restored)).toBe(fingerprint(original));
    // Les positions du jour, que la sauvegarde ne garde pas, sont les mêmes.
    expect(restored.dayPositions.positions).toEqual(original.dayPositions.positions);
    expect(restored.dayPositions.walking).toBe(original.dayPositions.walking);
    const cell = firstCellOf(original, land);
    for (let day = 0; day < 45; day++) {
      const commands = day === 7 ? [{ type: 'paintBiome' as const, ...cell, biome: 'taiga' }] : [];
      advanceDay(original, commands, testData);
      advanceDay(restored, commands, testData);
      expect(restored.dayPositions.positions).toEqual(original.dayPositions.positions);
    }
    expect(fingerprint(restored)).toBe(fingerprint(original));
  });

  it('refuse un jour, un journal ou des marches abîmés', () => {
    const original = midMonth(6);
    const data = save(original);
    const json = data.json as Record<string, unknown>;
    const paint = { type: 'paintBiome', x: 1, y: 1, biome: 'desert' };
    const arrays = data.arrays;
    const walks = original.walks.arrays();
    const groups = [...original.society.groups.values()];
    expect(walks.groups.length).toBeGreaterThan(3);
    /** La sauvegarde, une marche ou un tableau des marches changé. */
    const forged = (change: Partial<Record<keyof typeof walks, SavedArray>>): SaveData => ({
      ...data,
      arrays: {
        ...arrays,
        ...Object.fromEntries(
          Object.entries(change).map(([name, array]) => [
            `walk${name.charAt(0).toUpperCase()}${name.slice(1)}`,
            array,
          ]),
        ),
      },
    });
    const firstEnd = walks.ends.at(0) ?? 0;
    const width = original.size.width;
    /** Les cases de la première marche, la case `at` changée. */
    const cells = (at: number, cell: number) => {
      const copy = walks.cells.slice();
      copy[at] = cell;
      return copy;
    };
    const costs = (at: number, cost: number) => {
      const copy = walks.costs.slice();
      copy[at] = cost;
      return copy;
    };
    const budgets = (budget: number) => {
      const copy = walks.budgets.slice();
      copy[0] = budget;
      return copy;
    };
    const ids = (id: number, at = 0) => {
      const copy = walks.groups.slice();
      copy[at] = id;
      return copy;
    };
    const unknown = Math.max(...groups.map((group) => group.id)) + 1;
    // Témoin : la sauvegarde telle quelle, et une commande au jour même de la sauvegarde.
    expect(restore(data).walks.arrays()).toEqual(walks);
    const today = [{ tick: data.meta.tick, day: 6, command: paint }];
    expect(restore({ ...data, json: { ...json, commandLog: today } }).commandLog).toEqual(today);
    // Chaque sauvegarde abîmée, et la raison du refus : l'en-tête et le journal, puis les
    // marches, chacune abîmée d'une seule façon.
    const count = walks.groups.length;
    const swapped = walks.groups.slice();
    swapped[0] = walks.groups.at(1) ?? 0;
    swapped[1] = walks.groups.at(0) ?? 0;
    const cases: [string, SaveData, string][] = [
      ['jour 30', { ...data, json: { ...json, day: 30 } }, 'état illisible'],
      ['jour négatif', { ...data, json: { ...json, day: -1 } }, 'état illisible'],
      ['jour fractionnaire', { ...data, json: { ...json, day: 1.5 } }, 'état illisible'],
      ['jour absent', { ...data, json: { ...json, day: undefined } }, 'état illisible'],
      [
        'commande du lendemain',
        {
          ...data,
          json: { ...json, commandLog: [{ tick: data.meta.tick, day: 7, command: paint }] },
        },
        'journal des commandes incohérent',
      ],
      [
        'commande sans jour',
        { ...data, json: { ...json, commandLog: [{ tick: 0, command: paint }] } },
        'journal illisible',
      ],
      [
        'journal désordonné dans le mois',
        {
          ...data,
          json: {
            ...json,
            commandLog: [
              { tick: 1, day: 4, command: paint },
              { tick: 1, day: 3, command: paint },
            ],
          },
        },
        'journal des commandes incohérent',
      ],
      [
        'cases non voisines',
        forged({ cells: cells(1, ((walks.cells.at(0) ?? 0) + 2) % (width * 256)) }),
        'cases non voisines',
      ],
      ['case hors du monde', forged({ cells: cells(1, width * 256) }), 'case hors du monde'],
      ['case répétée', forged({ cells: cells(1, walks.cells.at(0) ?? 0) }), 'cases non voisines'],
      ['arrivée hors de la case du groupe', forged({ groups: swapped }), 'arrivée hors de la case'],
      ['coûts décroissants', forged({ costs: costs(1, -1) }), 'coûts'],
      ['coût de départ non nul', forged({ costs: costs(0, 0.5) }), 'coût de départ non nul'],
      ['coût NaN', forged({ costs: costs(1, Number.NaN) }), 'coûts'],
      [
        'chemin au-delà du budget',
        forged({ budgets: budgets((walks.costs[firstEnd - 1] ?? 0) - 0.01) }),
        'chemin au-delà du budget',
      ],
      ['budget nul', forged({ budgets: budgets(0) }), 'budget illisible'],
      ['budget infini', forged({ budgets: budgets(Number.POSITIVE_INFINITY) }), 'budget illisible'],
      ['groupe inconnu', forged({ groups: ids(unknown) }), 'groupe inconnu ou en double'],
      [
        'groupe en double',
        forged({ groups: ids(walks.groups.at(0) ?? 0, count - 1) }),
        'groupe inconnu ou en double',
      ],
      [
        'chemin d’une seule case',
        forged({ ends: Uint32Array.from(walks.ends, (end, i) => (i === 0 ? 1 : end)) }),
        'chemin trop court',
      ],
      [
        'cases en trop',
        forged({
          cells: Uint32Array.of(...walks.cells, 0),
          costs: Float64Array.of(...walks.costs, 99),
        }),
        'cases en trop',
      ],
      [
        'budgets trop courts',
        forged({ budgets: walks.budgets.slice(1) }),
        'tableaux de longueurs différentes',
      ],
      [
        'coûts de mauvais type',
        forged({ costs: Float32Array.from(walks.costs) }),
        'costs illisible',
      ],
      [
        'marches absentes',
        {
          ...data,
          arrays: Object.fromEntries(
            Object.entries(arrays).filter(([name]) => name !== 'walkCells'),
          ),
        },
        'cells illisible',
      ],
    ];
    for (const [label, broken, reason] of cases) {
      expect(() => restore(broken), label).toThrow(
        expect.objectContaining({
          code: 'corrupt',
          message: expect.stringContaining(reason) as string,
        }) as Error,
      );
    }
  });

  it('migre une partie de la version 5, qui se poursuit comme son rejeu', async () => {
    // Une vraie partie de la version 5 : sans jour dans les données ni au journal, et sans
    // marches ; ses groupes se tiennent sur leur case, à un pas mensuel juste fait.
    const original = played(8);
    step(original, scatteredGroups(original, 20, 30), testData);
    step(original, [], testData);
    const current = save(original);
    const { day, commandLog, ...rest } = current.json as {
      day: number;
      commandLog: { tick: number; day: number; command: unknown }[];
    };
    expect(day).toBe(0);
    const v5: SaveData = {
      meta: current.meta,
      json: { ...rest, commandLog: commandLog.map(({ tick, command }) => ({ tick, command })) },
      arrays: Object.fromEntries(
        Object.entries(current.arrays).filter(([name]) => !name.startsWith('walk')),
      ),
    };
    const file = encodeSave(v5, 5);
    // L'en-tête de la version 5 garde ses métadonnées d'alors : la graine et le mois.
    const header = JSON.parse(
      new TextDecoder().decode(
        file.subarray(10, 10 + new DataView(file.buffer).getUint32(6, true)),
      ),
    ) as { meta: object };
    expect(header.meta).toEqual({ seed: 'graine', tick: 10 });
    const migrated = restore(await readSave(file, MIGRATIONS));
    expect([migrated.tick, migrated.day]).toEqual([10, 0]);
    expect(migrated.walks.count).toBe(0);
    expect(migrated.commandLog).toEqual(original.commandLog);
    expect(migrated.commandLog.every((entry) => entry.day === 0)).toBe(true);
    // Ses groupes se tiennent au centre de leur case jusqu'au pas mensuel suivant.
    [...migrated.society.groups.values()].forEach((group, rank) => {
      expect(migrated.dayPositions.positions[rank * 2]).toBe(group.x + 0.5);
      expect(migrated.dayPositions.positions[rank * 2 + 1]).toBe(group.y + 0.5);
    });
    // Après un pas mensuel, la partie migrée et son rejeu ne font plus qu'une : le pas
    // décide les mêmes marches, de la même case.
    const replayed = replay(
      testParams(),
      testWorld(),
      migrated.commandLog,
      { tick: 10, day: 0 },
      testData,
    );
    for (let month = 0; month < 3; month++) {
      step(migrated, [], testData);
      step(replayed, [], testData);
      expect(fingerprint(migrated), `mois ${String(month)}`).toBe(fingerprint(replayed));
    }
  });
});
