import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../core/data/catalog';
import { BiomesSchema } from '../core/data/schemas';
import { encodeSave, readSave, SaveError, writeSave, type SaveData } from '../core/save/format';
import { worldCalendars } from '../core/snow';
import { LAYER_NAMES } from '../core/world';
import { GENERATOR_VERSION } from '../worldgen/generate';
import { FIXED } from '../core/position';
import { describeMovement } from './movement';
import { FAUNA_STREAM } from './fauna';
import { SAVED_FAUNA_SHARE } from './faunaSave';
import { catalogOf } from '../core/data/catalog';
import {
  ACTIVITY_COLUMNS,
  ANCESTRY_SLOTS,
  CARRIED,
  INTENTION,
  LEAVE,
  NONE,
  REST,
  WALK,
} from './population';
import { replay } from './replay';
import { MIGRATIONS, restoreState, saveState } from './save';
import type { SimState } from './state';
import { advanceDay, step } from './day';
import { applyCommands, fingerprint } from './step';
import { dayIndex } from '../core/time';
import { ACT_RUN } from '../core/protocol';
import {
  cellsOf,
  firstCellOf,
  scatteredGroups,
  testData,
  testParams,
  testState,
  testWorld,
  withHuman,
} from './testing';
import { meanGregariousness } from './temper';
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

  it('refait à la relecture les calendriers de la neige et de la glace, que le pinceau ne change pas', async () => {
    // Trente mois où le pinceau a fait du désert de six cases de terre (played) : les calendriers
    // de l'état sont ceux du monde généré, et la relecture les refait depuis le monde repeint.
    const state = played(30);
    expect(state.commandLog.length).toBeGreaterThan(5);
    const restored = restore(await readSave(await writeSave(save(state)), MIGRATIONS));
    expect(restored.calendars).toEqual(state.calendars);
    expect(restored.calendars).not.toBe(state.calendars);
    // Chaque biome de terre sur des cases de terre de toutes latitudes : aucun calendrier ne bouge.
    const painted = testState();
    const before = painted.calendars.slice();
    const lands = testData.biomes.entries.filter((biome) => biome.family !== 'water');
    // Une case de terre sur 97, des pôles à l'équateur.
    const cells = cellsOf(painted, land, painted.world.biome.length).filter(
      (_, index) => index % 97 === 0,
    );
    expect(new Set(cells.map((cell) => Math.floor(cell.y / 32))).size).toBeGreaterThan(6);
    applyCommands(
      painted,
      cells.map((cell, index) => ({
        type: 'paintBiome' as const,
        ...cell,
        biome: lands[index % lands.length]?.id ?? 'desert',
      })),
      testData,
    );
    expect(painted.world.biome).not.toEqual(testWorld().biome);
    expect(
      worldCalendars(painted.size, painted.world, testData.biomes.entries, testData.seasons),
    ).toEqual(before);
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
    // de la phase 2 avant sa relecture, 5, celle d'avant les deux horloges, 6, celle d'avant
    // les individus hors de la grille, 7, celle d'avant le gibier, et 8, celle d'avant les
    // activités, se migrent.
    expect(Object.keys(MIGRATIONS)).toEqual(['3', '4', '5', '6', '7', '8']);
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

  it("donne la moyenne de son ascendance au caractère qu'une sauvegarde ne connaît pas", () => {
    const state = testState();
    step(state, scatteredGroups(state, 10, 30), testData);
    for (let tick = 0; tick < 6; tick++) step(state, [], testData);
    const data = save(state);
    const arrays = { ...data.arrays };
    delete arrays.peopleGregariousness;
    delete arrays.archiveGregariousness;
    // Des sous-espèces de grégarités différentes : chacun reçoit celle de son ascendance.
    const { species } = withHuman((human) => ({
      ...human,
      subspecies: human.subspecies.map((entry, index) => ({
        ...entry,
        temperament: { gregariousness: { mean: [0.2, 0.6, 0.9][index] ?? 0.5, sd: 0.1 } },
      })),
    }));
    const content = { ...testData, species };
    const restored = restoreState({ ...data, arrays }, content);
    const human = content.species.entries.at(0);
    if (human === undefined) throw new Error('pas d’humains');
    const { people } = restored;
    expect(people.count).toBeGreaterThan(0);
    people.forEach((slot) => {
      const expected = meanGregariousness(human, people.columns.ancestry, slot * ANCESTRY_SLOTS);
      expect(people.get('gregariousness', slot)).toBe(expected);
    });
    const archive = people.archive;
    expect(archive.rows).toBeGreaterThan(0);
    for (let row = 0; row < archive.rows; row++) {
      const expected = meanGregariousness(human, archive.columns.ancestry, row * ANCESTRY_SLOTS);
      expect(archive.columns.gregariousness[row]).toBe(expected);
    }
    // Les autres colonnes ne manquent jamais.
    const truncated = { ...data.arrays };
    delete truncated.peopleNutrition;
    expect(() => restore({ ...data, arrays: truncated })).toThrow(SaveError);
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

describe('sauvegarde des deux horloges et des positions (ADR 0013, ADR 0014)', () => {
  /** Une partie de groupes nomades, arrêtée au jour `day` d'un mois où ils marchent. */
  function midMonth(day: number): SimState {
    const state = testState();
    step(state, scatteredGroups(state, 30, 30), testData);
    step(state, [], testData);
    for (let passed = 0; passed < day; passed++) advanceDay(state, [], testData);
    return state;
  }

  it('se relit en cours de mois, positions et marches comprises, et se poursuit à l’identique', async () => {
    const original = midMonth(7);
    expect(original.movement.activeCount).toBeGreaterThan(10);
    const data = save(original);
    expect(data.meta).toEqual({ seed: 'graine', tick: 2 });
    expect((data.json as { day: number }).day).toBe(7);
    const restored = restore(await readSave(await writeSave(data), MIGRATIONS));
    expect([restored.tick, restored.day]).toEqual([2, 7]);
    expect(fingerprint(restored)).toBe(fingerprint(original));
    // Les caches du mouvement, que la sauvegarde ne garde pas, se refont à l'identique.
    expect(describeMovement(restored).text).toBe(describeMovement(original).text);
    const cell = firstCellOf(original, land);
    for (let day = 0; day < 40; day++) {
      const commands = day === 5 ? [{ type: 'paintBiome' as const, ...cell, biome: 'taiga' }] : [];
      advanceDay(original, commands, testData);
      advanceDay(restored, commands, testData);
      const end = original.people.end;
      expect(restored.people.end).toBe(end);
      const columns = (state: SimState) =>
        [state.people.columns.x, state.people.columns.y].map((column) => column.subarray(0, end));
      expect(columns(restored), `jour ${String(day)}`).toEqual(columns(original));
    }
    expect(fingerprint(restored)).toBe(fingerprint(original));
  });

  it('refuse un jour, un journal, une position ou un mouvement abîmés', () => {
    const original = midMonth(6);
    const data = save(original);
    const json = data.json as Record<string, unknown>;
    const paint = { type: 'paintBiome', x: 1, y: 1, biome: 'desert' };
    const { people } = original;
    const { width, height } = original.size;
    // Un marcheur, un porté, et un autre vivant.
    let walker = -1;
    let carried = -1;
    people.forEach((slot) => {
      const intention = people.get('move', slot) & INTENTION;
      if (intention === WALK && people.get('stepDays', slot) > 0 && walker < 0) walker = slot;
      if (intention === CARRIED && carried < 0) carried = slot;
    });
    expect(walker).toBeGreaterThanOrEqual(0);
    expect(carried).toBeGreaterThanOrEqual(0);
    /** La sauvegarde, la colonne `name` changée pour l'emplacement `slot`. */
    const column = (name: string, slot: number, value: number): SaveData => {
      const key = `people${name.charAt(0).toUpperCase()}${name.slice(1)}`;
      if (!Object.hasOwn(data.arrays, key)) throw new Error(`colonne ${key} absente`);
      const copy = data.arrays[key].slice();
      copy[slot] = value;
      return { ...data, arrays: { ...data.arrays, [key]: copy } };
    };
    const peopleJson = json.people as { groups: { campX: number }[] };
    const camp = (value: number): SaveData => ({
      ...data,
      json: {
        ...json,
        people: {
          ...peopleJson,
          groups: peopleJson.groups.map((group, index) =>
            index === 0 ? { ...group, campX: value } : group,
          ),
        },
      },
    });
    // Témoin : la sauvegarde telle quelle, et une commande au jour même de la sauvegarde.
    expect(fingerprint(restore(data))).toBe(fingerprint(original));
    const today = [{ tick: data.meta.tick, day: 6, command: paint }];
    expect(restore({ ...data, json: { ...json, commandLog: today } }).commandLog).toEqual(today);
    const days = people.get('stepDays', walker);
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
        'position hors du monde, à l’est',
        column('x', walker, width * FIXED),
        'position hors du monde',
      ],
      ['position négative', column('x', walker, -1), 'position hors du monde'],
      ['position au-delà du pôle', column('y', walker, height * FIXED), 'position hors du monde'],
      [
        'place hors du monde',
        column('goalY', walker, height * FIXED + 5),
        'position hors du monde',
      ],
      ['intention inconnue', column('move', walker, 5), 'intention inconnue'],
      ['intention 7', column('move', walker, 7), 'intention inconnue'],
      ['jour de départ 30', column('depart', walker, 30), 'jour de départ'],
      ['étape de plus de mille jours', column('stepDays', walker, 1001), 'étape illisible'],
      ['pas de plus de quatre cases', column('stepX', walker, 5 * FIXED), 'étape illisible'],
      [
        'étape qui finit au-delà du pôle',
        column('stepY', walker, Math.ceil((height * FIXED) / Math.max(1, days))),
        'étape illisible',
      ],
      ['porté sans mère', column('mother', carried, NONE), 'porté sans sa mère'],
      [
        'porté d’un autre groupe',
        column('group', carried, (people.get('group', carried) % 3) + 1),
        '',
      ],
      ['camp hors du monde', camp(width), 'groupes incohérents'],
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

  /**
   * Une sauvegarde de la version 6, tirée d'une partie d'aujourd'hui : sans les colonnes de
   * position, de mouvement et de grégarité, sans camps, et avec les marches du mois de 2b.2 :
   * pour chaque groupe dont les cases à l'ouest se franchissent, une marche droite de huit
   * cases qui finit sur sa case, au coût cumulé du terrain, d'un budget de 30.
   */
  function version6(state: SimState): SaveData {
    const current = save(state);
    const json = current.json as Record<string, unknown> & {
      people: { groups: Record<string, unknown>[] };
    };
    const groups = json.people.groups.map(({ campX: _x, campY: _y, ...group }) => group);
    const { width } = state.size;
    const walkGroups: number[] = [];
    const walkEnds: number[] = [];
    const walkCells: number[] = [];
    const walkCosts: number[] = [];
    for (const group of state.society.groups.values()) {
      const path = Array.from({ length: 9 }, (_, k) => {
        const x = (group.x - 8 + k + width) % width;
        return group.y * width + x;
      });
      if (!path.every((cell) => (state.cost[cell] ?? Infinity) < Infinity)) continue;
      let spent = 0;
      path.forEach((cell, k) => {
        if (k > 0) spent += state.cost[cell] ?? 0;
        walkCells.push(cell);
        walkCosts.push(spent);
      });
      walkGroups.push(group.id);
      walkEnds.push(walkCells.length);
    }
    const v7 =
      /^(people(X|Y|Move|Depart|GoalX|GoalY|StepX|StepY|StepDays|Gregariousness)|archiveGregariousness)$/;
    return {
      meta: current.meta,
      json: { ...json, people: { ...json.people, groups } },
      arrays: {
        ...Object.fromEntries(Object.entries(current.arrays).filter(([name]) => !v7.test(name))),
        walkGroups: Uint32Array.from(walkGroups),
        walkEnds: Uint32Array.from(walkEnds),
        walkCells: Uint32Array.from(walkCells),
        walkCosts: Float64Array.from(walkCosts),
        walkBudgets: new Float64Array(walkGroups.length).fill(30),
      },
    };
  }

  it('migre une partie de la version 6 en cours de mois : chacun se pose, et rejoint le camp', async () => {
    const original = midMonth(6);
    const v6 = version6(original);
    const walks = (v6.arrays.walkGroups as Uint32Array).length;
    expect(walks).toBeGreaterThan(5);
    const file = encodeSave(v6, 6);
    const read = await readSave(file, MIGRATIONS);
    expect(read.arrays.walkCells).toBeUndefined();
    const migrated = restore(read);
    expect([migrated.tick, migrated.day]).toEqual([original.tick, 6]);
    expect(migrated.commandLog).toEqual(original.commandLog);
    const { people } = migrated;
    const { move, x, y, group, gregariousness } = people.columns;
    // Chacun se tient à la position du jour de son groupe, en partance le jour même, sauf les
    // nourrissons, portés par leur mère ; la grégarité prend la moyenne de l'ascendance.
    const camps = new Map([...migrated.society.groups.values()].map((entry) => [entry.id, entry]));
    let leaving = 0;
    people.forEach((slot) => {
      const intention = (move[slot] ?? 0) & INTENTION;
      expect([LEAVE, CARRIED]).toContain(intention);
      if (intention === LEAVE) {
        leaving++;
        expect(people.get('depart', slot)).toBe(6);
      }
      expect(gregariousness[slot]).toBe(128);
      const home = camps.get(group[slot] ?? 0);
      expect(home).toBeDefined();
      const cell =
        Math.floor((y[slot] ?? 0) / FIXED) * migrated.size.width +
        Math.floor((x[slot] ?? 0) / FIXED);
      expect(migrated.cost[cell]).toBeLessThan(Infinity);
    });
    expect(leaving).toBeGreaterThan(people.count / 2);
    // Les membres d'un groupe qui marchait se tiennent ensemble, en route : son camp est la
    // case du bout de la marche, et sa case du jour, une case du chemin, à l'ouest du camp.
    const walked = (v6.arrays.walkGroups as Uint32Array)[0];
    const home = camps.get(walked);
    if (home === undefined) throw new Error('groupe introuvable');
    expect(home.x).toBeLessThan(home.campX + (home.campX < 8 ? migrated.size.width : 0));
    // La partie continue : chacun rejoint le camp de son groupe, de façon déterministe.
    const again = restore(await readSave(file, MIGRATIONS));
    for (let day = 0; day < 40; day++) {
      advanceDay(migrated, [], testData);
      advanceDay(again, [], testData);
    }
    expect(fingerprint(again)).toBe(fingerprint(migrated));
    // Arrivés au camp, ils n'en suivent plus le chemin : ils s'y reposent, ou en partent pour leurs
    // activités (ADR 0021).
    const follow = testData.activities.activities.findIndex((a) => a.place === 'camp');
    let arrived = 0;
    migrated.people.forEach((slot) => {
      const intention = migrated.people.get('move', slot) & INTENTION;
      const activity = migrated.people.get('activity', slot) & 0x0f;
      if (intention !== LEAVE && intention !== CARRIED && activity !== follow) arrived++;
    });
    expect(arrived).toBeGreaterThan(migrated.people.count / 3);
  });

  it('migre une partie de la version 5, qui se poursuit de façon déterministe', async () => {
    // Une vraie partie de la version 5 : sans jour dans les données ni au journal, et sans
    // marches ; ses groupes se tiennent sur leur case, à un pas mensuel juste fait.
    const original = played(8);
    step(original, scatteredGroups(original, 20, 30), testData);
    step(original, [], testData);
    const v6 = version6(original);
    const { day, commandLog, ...rest } = v6.json as {
      day: number;
      commandLog: { tick: number; day: number; command: unknown }[];
    };
    expect(day).toBe(0);
    const v5: SaveData = {
      meta: v6.meta,
      json: { ...rest, commandLog: commandLog.map(({ tick, command }) => ({ tick, command })) },
      arrays: Object.fromEntries(
        Object.entries(v6.arrays).filter(([name]) => !name.startsWith('walk')),
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
    expect(migrated.commandLog).toEqual(original.commandLog);
    expect(migrated.commandLog.every((entry) => entry.day === 0)).toBe(true);
    // Sans marches, chacun se tient au centre de la case de son groupe, qui est son camp.
    const { x, y, group } = migrated.people.columns;
    migrated.people.forEach((slot) => {
      const home = migrated.society.groups.get(group[slot] ?? 0);
      if (home === undefined) throw new Error('groupe introuvable');
      expect([home.campX, home.campY]).toEqual([home.x, home.y]);
      expect(x[slot]).toBe(home.x * FIXED + FIXED / 2);
      expect(y[slot]).toBe(home.y * FIXED + FIXED / 2);
    });
    // Elle se poursuit de façon déterministe, mais ne rejoint plus son rejeu (ADR 0014).
    const again = restore(await readSave(file, MIGRATIONS));
    for (let month = 0; month < 3; month++) {
      step(migrated, [], testData);
      step(again, [], testData);
      expect(fingerprint(migrated), `mois ${String(month)}`).toBe(fingerprint(again));
    }
  });
});

describe('sauvegarde du gibier (version 8, ADR 0018, § 5)', () => {
  /** Une partie en cours de mois, des animaux en route, des fuites devant les marcheurs. */
  function wild(): SimState {
    const state = testState('pixelciv');
    step(state, scatteredGroups(state, 40), testData);
    for (let day = 0; day < 37; day++) advanceDay(state, [], testData);
    return state;
  }

  it('relit le gibier tel qu’il était, étapes en cours comprises, et la partie se poursuit à l’identique', async () => {
    const original = wild();
    const walking = [...original.fauna.stepDays.subarray(0, original.fauna.end)].filter(
      (days) => days > 0,
    ).length;
    expect(walking).toBeGreaterThan(10);
    expect(original.fauna.free.length + original.fauna.herdFree.length).toBeGreaterThan(0);
    const restored = restore(await readSave(await writeSave(save(original)), MIGRATIONS));
    expect(fingerprint(restored)).toBe(fingerprint(original));
    expect(restored.fauna.count).toBe(original.fauna.count);
    for (let day = 0; day < 75; day++) {
      advanceDay(original, [], testData);
      advanceDay(restored, [], testData);
    }
    expect(fingerprint(restored)).toBe(fingerprint(original));
  });

  it('ramène les espèces sauvegardées à celles du contenu d’aujourd’hui', () => {
    const original = wild();
    const data = save(original);
    // Le même gibier, relu avec un contenu dont les espèces sont dans l'autre ordre.
    const reversed = { ...testData, fauna: catalogOf([...testData.fauna.entries].reverse()) };
    const restored = restoreState(data, reversed);
    const fauna = restored.fauna;
    for (let slot = 0; slot < fauna.end; slot++) {
      if (fauna.alive[slot] !== 1) continue;
      const before = testData.fauna.entries[original.fauna.species[slot] ?? 0]?.id;
      expect(reversed.fauna.entries[fauna.species[slot] ?? 0]?.id).toBe(before);
    }
    // Une espèce disparue du contenu rend la sauvegarde illisible.
    const json = data.json as { fauna: { species: string[] } };
    const gone = {
      ...data,
      json: { ...json, fauna: { ...json.fauna, species: ['aurochs', 'boar', 'hare'] } },
    };
    expect(() => restore(gone)).toThrow(expect.objectContaining({ code: 'corrupt' }) as Error);
  });

  it('refuse chaque défaut d’un gibier abîmé', () => {
    const data = save(wild());
    const json = data.json as { fauna: Record<string, unknown> };
    const arrays = data.arrays;
    const ints = arrays.faunaInts as Int32Array;
    const bytes = arrays.faunaBytes as Uint8Array;
    const herdInts = arrays.herdInts as Int32Array;
    const herdBytes = arrays.herdBytes as Uint8Array;
    // Le premier vivant, et sa harde.
    const alive = [...Array(bytes.length / 4).keys()].filter((slot) => bytes[slot * 4] === 1);
    const slot = alive[0] ?? 0;
    const herd = ints[slot * 10] ?? 0;
    const free = arrays.faunaFree as Int32Array;
    expect(free.length).toBeGreaterThan(0);
    const changed = <T extends Int32Array | Uint8Array | Uint32Array | Uint16Array>(
      array: T,
      at: number,
      value: number,
    ): T => {
      const copy = array.slice() as T;
      copy[at] = value;
      return copy;
    };
    const withArrays = (change: Record<string, unknown>): SaveData =>
      ({ ...data, arrays: { ...arrays, ...change } }) as SaveData;
    const withFauna = (change: Record<string, unknown>): SaveData => ({
      ...data,
      json: { ...json, fauna: { ...json.fauna, ...change } },
    });
    const huge = Math.floor(512 * 256 * SAVED_FAUNA_SHARE) + 1;
    const cases: [string, SaveData][] = [
      ['gibier illisible', { ...data, json: { ...json, fauna: 3 } }],
      ['compteur nul', withFauna({ nextId: 0 })],
      ['compteur des hardes fractionnaire', withFauna({ nextHerdId: 2.5 })],
      ['espèces illisibles', withFauna({ species: 'deer' })],
      ['colonne absente', withArrays({ faunaIds: undefined })],
      [
        'colonne de mauvais type',
        withArrays({ faunaDays: Uint32Array.from(arrays.faunaDays as Uint16Array) }),
      ],
      ['colonne trop courte', withArrays({ faunaInts: ints.slice(1) })],
      ['hardes de mauvaise taille', withArrays({ herdInts: herdInts.slice(1) })],
      [
        'trop d’animaux',
        withArrays({
          faunaIds: new Uint32Array(huge),
          faunaDays: new Uint16Array(huge),
          faunaInts: new Int32Array(huge * 10),
          faunaBytes: new Uint8Array(huge * 4),
        }),
      ],
      ['vivant ni mort', withArrays({ faunaBytes: changed(bytes, slot * 4, 2) })],
      ['espèce hors de la liste', withArrays({ faunaBytes: changed(bytes, slot * 4 + 1, 9) })],
      ['sexe illisible', withArrays({ faunaBytes: changed(bytes, slot * 4 + 2, 2) })],
      ['allure inconnue', withArrays({ faunaBytes: changed(bytes, slot * 4 + 3, 3) })],
      ['sans harde', withArrays({ faunaInts: changed(ints, slot * 10, -1) })],
      ['harde morte', withArrays({ herdBytes: changed(herdBytes, herd * 2, 0) })],
      [
        'harde d’une autre espèce',
        withArrays({
          herdBytes: changed(herdBytes, herd * 2 + 1, ((herdBytes[herd * 2 + 1] ?? 0) + 1) % 3),
        }),
      ],
      [
        'position hors du monde',
        withArrays({ faunaInts: changed(ints, slot * 10 + 2, 512 * FIXED) }),
      ],
      ['position négative', withArrays({ faunaInts: changed(ints, slot * 10 + 3, -1) })],
      ['place hors du monde', withArrays({ faunaInts: changed(ints, slot * 10 + 5, 256 * FIXED) })],
      [
        'pas démesuré',
        withArrays({
          faunaInts: changed(ints, slot * 10 + 6, 5 * FIXED),
          faunaDays: changed(arrays.faunaDays as Uint16Array, slot, 1),
        }),
      ],
      [
        'pas sans jours',
        withArrays({
          faunaInts: changed(ints, slot * 10 + 7, 100),
          faunaDays: changed(arrays.faunaDays as Uint16Array, slot, 0),
        }),
      ],
      [
        'étape trop longue',
        withArrays({ faunaDays: changed(arrays.faunaDays as Uint16Array, slot, 1001) }),
      ],
      [
        'étape hors du monde',
        withArrays({
          faunaInts: changed(ints, slot * 10 + 7, 4 * FIXED),
          faunaDays: changed(arrays.faunaDays as Uint16Array, slot, 1000),
        }),
      ],
      [
        'identifiant nul',
        withArrays({ faunaIds: changed(arrays.faunaIds as Uint32Array, slot, 0) }),
      ],
      [
        'identifiant à venir',
        withArrays({ faunaIds: changed(arrays.faunaIds as Uint32Array, slot, 0xfffffff) }),
      ],
      ['identifiant de harde nul', withArrays({ herdInts: changed(herdInts, herd * 7, 0) })],
      ['domaine hors du monde', withArrays({ herdInts: changed(herdInts, herd * 7 + 1, 512) })],
      ['but hors du monde', withArrays({ herdInts: changed(herdInts, herd * 7 + 4, -5) })],
      ['pile libre d’un vivant', withArrays({ faunaFree: changed(free, 0, slot) })],
      [
        'pile libre hors des emplacements',
        withArrays({ faunaFree: changed(free, 0, bytes.length) }),
      ],
      ['pile libre en double', withArrays({ faunaFree: Int32Array.of(free[0], free[0]) })],
      ['emplacement perdu', withArrays({ faunaFree: free.slice(1) })],
      ['hardes perdues', withArrays({ herdFree: new Int32Array(0) })],
    ];
    expect(() => restore(data)).not.toThrow();
    for (const [label, forged] of cases) {
      expect(() => restore(forged), label).toThrow(
        expect.objectContaining({ code: 'corrupt' }) as Error,
      );
    }
  });

  it('migre une partie de la version 7 : son gibier se sème d’après son état, de façon déterministe', async () => {
    const original = wild();
    const current = save(original);
    // Une vraie partie de la version 7 : ni gibier, ni flux du gibier ; on lui en forge un, que
    // la migration ôte.
    const {
      fauna: _fauna,
      rng,
      ...json
    } = current.json as { fauna: unknown; rng: Record<string, unknown> };
    const v7: SaveData = {
      meta: current.meta,
      json: { ...json, rng: { ...rng, [FAUNA_STREAM]: [1, 2, 3, 4] } },
      arrays: Object.fromEntries(
        Object.entries(current.arrays).filter(([name]) => !/^(fauna|herd)/.test(name)),
      ),
    };
    const file = encodeSave(v7, 7);
    const read = await readSave(file, MIGRATIONS);
    expect((read.json as { fauna: unknown }).fauna).toBeNull();
    expect((read.json as { rng: Record<string, unknown> }).rng[FAUNA_STREAM]).toBeUndefined();
    const migrated = restore(read);
    // Le gibier semé d'après l'état de la partie, stocks entamés compris, comme seedFauna le fait.
    expect(migrated.fauna.count).toBeGreaterThan(300);
    const control = restore(read);
    expect(fingerprint(control)).toBe(fingerprint(migrated));
    // Le flux forgé n'y a rien changé : la même partie sans lui donne le même gibier.
    const clean = restore(
      await readSave(encodeSave({ ...v7, json: { ...json, rng } }, 7), MIGRATIONS),
    );
    expect(fingerprint(clean)).toBe(fingerprint(migrated));
    // La migration ne touche pas aux humains, hors des colonnes des activités, qu'elle déduit ; la
    // partie continue de façon déterministe.
    const omit = ACTIVITY_COLUMNS;
    expect(fingerprint(migrated, { fauna: false, omit })).toBe(
      fingerprint(original, { fauna: false, omit }),
    );
    for (let month = 0; month < 2; month++) {
      step(migrated, [], testData);
      step(control, [], testData);
      expect(fingerprint(control), `mois ${String(month)}`).toBe(fingerprint(migrated));
    }
  });
});

describe('sauvegarde des activités (version 9, ADR 0021)', () => {
  /** Une partie de groupes nomades, arrêtée au jour 6 d'un mois où ils marchent. */
  function midMonth(): SimState {
    const state = testState();
    step(state, scatteredGroups(state, 30, 30), testData);
    step(state, [], testData);
    for (let passed = 0; passed < 6; passed++) advanceDay(state, [], testData);
    return state;
  }
  const rankOf = (id: string) => testData.activities.activities.findIndex((a) => a.id === id);
  /** Un vivant de l'intention `intention`, et un porté. */
  function slots(state: SimState) {
    const { people } = state;
    let rest = -1;
    let walker = -1;
    let carried = -1;
    people.forEach((slot) => {
      const intention = people.get('move', slot) & INTENTION;
      if (intention === REST && rest < 0) rest = slot;
      if (intention === WALK && walker < 0) walker = slot;
      if (intention === CARRIED && carried < 0) carried = slot;
    });
    expect(Math.min(rest, walker, carried)).toBeGreaterThanOrEqual(0);
    return { rest, walker, carried };
  }

  it('migre une partie de la version 8 : places au camp déduites de l’état, relue deux fois à l’identique', async () => {
    const original = midMonth();
    const current = save(original);
    const json = current.json as { people: Record<string, unknown> };
    const { activities: _activities, ...people } = json.people;
    const v8: SaveData = {
      meta: current.meta,
      json: { ...json, people },
      arrays: Object.fromEntries(
        Object.entries(current.arrays).filter(
          ([name]) => !/^people(Activity|Until|HomeX|HomeY)$/.test(name),
        ),
      ),
    };
    const read = await readSave(encodeSave(v8, 8), MIGRATIONS);
    expect((read.json as { people: { activities: unknown } }).people.activities).toBeNull();
    const migrated = restore(read);
    const control = restore(read);
    expect(fingerprint(control)).toBe(fingerprint(migrated));
    // La place au camp : celle que vise qui marche vers son camp, la position des autres.
    const { columns } = migrated.people;
    let checked = 0;
    migrated.people.forEach((slot) => {
      const walking = ((columns.move[slot] ?? 0) & INTENTION) === WALK;
      expect(columns.homeX[slot]).toBe(walking ? columns.goalX[slot] : columns.x[slot]);
      expect(columns.homeY[slot]).toBe(walking ? columns.goalY[slot] : columns.y[slot]);
      checked++;
    });
    expect(checked).toBeGreaterThan(500);
    // Hors des colonnes des activités, la partie est celle d'avant ; elle se poursuit à
    // l'identique d'une relecture à l'autre.
    const omit = ACTIVITY_COLUMNS;
    expect(fingerprint(migrated, { omit })).toBe(fingerprint(original, { omit }));
    for (let day = 0; day < 40; day++) {
      advanceDay(migrated, [], testData);
      advanceDay(control, [], testData);
    }
    expect(fingerprint(control)).toBe(fingerprint(migrated));
  });

  it('ramène les activités sauvegardées à celles du contenu d’aujourd’hui, par leurs noms', () => {
    const original = midMonth();
    const { rest, walker } = slots(original);
    const now = dayIndex(original);
    const { columns } = original.people;
    columns.activity[rest] = rankOf('gather');
    columns.until[rest] = now + 5;
    columns.activity[walker] = rankOf('follow');
    columns.until[walker] = 0;
    const data = save(original);
    expect((data.json as { people: { activities: string[] } }).people.activities).toEqual(
      testData.activities.activities.map((a) => a.id),
    );
    // Le même contenu, ses activités dans l'ordre inverse : chacun garde la sienne.
    const reversed = [...testData.activities.activities].reverse();
    const content = { ...testData, activities: { ...testData.activities, activities: reversed } };
    const restored = restoreState(data, content);
    const idOf = (state: SimState, slot: number) =>
      reversed[state.people.columns.activity[slot] ?? 15]?.id;
    expect(idOf(restored, rest)).toBe('gather');
    expect(idOf(restored, walker)).toBe('follow');
    expect(restored.people.columns.until[rest]).toBe(now + 5);
    // Une activité qui a disparu du contenu rend la partie trop ancienne.
    const fewer = {
      ...testData,
      activities: {
        ...testData.activities,
        activities: testData.activities.activities.filter((a) => a.id !== 'water'),
      },
    };
    expect(() => restoreState(data, fewer)).toThrow(
      expect.objectContaining({ code: 'obsolete', message: 'activité inconnue : water' }),
    );
  });

  it('refuse une activité, un jour du prochain choix ou une place au camp abîmés', () => {
    const original = midMonth();
    const { rest, walker, carried } = slots(original);
    const now = dayIndex(original);
    const gather = rankOf('gather');
    const hunt = rankOf('hunt');
    const follow = rankOf('follow');
    const { columns } = original.people;
    // Un témoin valide : qui cueille, qui chasse en courant, qui part vers le lieu de la sienne.
    columns.activity[rest] = gather;
    columns.until[rest] = now;
    columns.activity[walker] = hunt | ACT_RUN;
    columns.until[walker] = now + 1000;
    const data = save(original);
    expect(fingerprint(restore(data))).toBe(fingerprint(original));
    const column = (name: string, slot: number, value: number): SaveData => {
      const key = `people${name.charAt(0).toUpperCase()}${name.slice(1)}`;
      if (!Object.hasOwn(data.arrays, key)) throw new Error(`colonne ${key} absente`);
      const copy = data.arrays[key].slice();
      copy[slot] = value;
      return { ...data, arrays: { ...data.arrays, [key]: copy } };
    };
    const both = (slot: number, activity: number, until: number): SaveData => {
      const first = column('activity', slot, activity);
      const key = 'peopleUntil';
      const copy = first.arrays[key].slice();
      copy[slot] = until;
      return { ...first, arrays: { ...first.arrays, [key]: copy } };
    };
    const { width, height } = original.size;
    const json = data.json as { people: Record<string, unknown> };
    const cases: [string, SaveData, string][] = [
      ['rang inconnu', column('activity', rest, 9), 'activité inconnue'],
      ['bit inconnu', column('activity', rest, gather | 0x20), 'activité illisible'],
      [
        'course hors de la chasse',
        column('activity', rest, gather | ACT_RUN),
        'activité illisible',
      ],
      ['porté qui cueille', both(carried, gather, now + 3), 'un porté a une activité'],
      ['choix sans activité', column('activity', rest, 15), 'jour de la prochaine activité'],
      ['activité sans choix', column('until', rest, 0), 'jour de la prochaine activité'],
      ['choix passé', column('until', rest, now - 1), 'jour de la prochaine activité'],
      ['choix lointain', column('until', walker, now + 1001), 'jour de la prochaine activité'],
      ['suivi du groupe avec un choix', column('activity', rest, follow), 'jour de la prochaine'],
      ['séjour sans marche', column('until', rest, -3), 'jour de la prochaine activité'],
      ['séjour trop long', both(walker, gather, -61), 'jour de la prochaine activité'],
      [
        'place au camp à l’est',
        column('homeX', rest, width * FIXED),
        'place au camp hors du monde',
      ],
      ['place au camp négative', column('homeY', rest, -1), 'place au camp hors du monde'],
      ['place au camp au pôle', column('homeY', rest, height * FIXED), 'place au camp hors du'],
      [
        'trop d’activités nommées',
        {
          ...data,
          json: {
            ...json,
            people: { ...json.people, activities: Array.from({ length: 16 }, () => 'rest') },
          },
        },
        'population illisible',
      ],
    ];
    // Le séjour d'un marcheur vers le lieu de son activité, lui, se relit.
    expect(() => restore(both(walker, gather, -60))).not.toThrow();
    for (const [label, broken, reason] of cases) {
      expect(() => restore(broken), label).toThrow(
        expect.objectContaining({
          code: 'corrupt',
          message: expect.stringContaining(reason) as string,
        }) as Error,
      );
    }
  });
});
