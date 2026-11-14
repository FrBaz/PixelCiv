import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, emptyLayers, WORLD_SIZES } from '../core/world';
import { altitudeLevelIndex } from '../core/altitude';
import { cellIndex, createState, takeDirtyChunks } from './state';
import { applyCommand, fingerprint, step, type SimContent } from './step';
import { terrainLands } from './terrain';
import {
  firstCellOf,
  scatteredGroups,
  testData,
  testHuman,
  testParams,
  testState,
} from './testing';

const land = (family: string) => family !== 'water';

describe('cases', () => {
  it("bouclent d'est en ouest et n'existent pas au-delà des pôles", () => {
    const state = testState();
    const { width, height } = state.size;
    expect(cellIndex(state.size, -1, 10)).toBe(10 * width + width - 1);
    expect(cellIndex(state.size, width, 10)).toBe(10 * width);
    expect(cellIndex(state.size, 5, -1)).toBeUndefined();
    expect(cellIndex(state.size, 5, height)).toBeUndefined();
  });

  it('prennent la partie entière avant de boucler, et refusent un point non fini', () => {
    const state = testState();
    const { width } = state.size;
    expect(cellIndex(state.size, -1e-14, 4)).toBe(4 * width + width - 1);
    expect(cellIndex(state.size, 2.75, 6.5)).toBe(6 * width + 2);
    for (const x of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(cellIndex(state.size, x, 3)).toBeUndefined();
      expect(cellIndex(state.size, 3, x)).toBeUndefined();
    }
  });
});

describe('pinceau de biome', () => {
  it("change le biome d'une case de terre, et marque son bloc comme modifié", () => {
    const state = testState();
    const cell = firstCellOf(state, land);
    applyCommand(state, { type: 'paintBiome', ...cell, biome: 'desert' }, testData);
    const index = cell.y * state.size.width + cell.x;
    expect(state.world.biome[index]).toBe(testData.biomes.indexOf('desert'));
    const chunks = takeDirtyChunks(state);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.column).toBe(Math.floor(cell.x / CHUNK_SIZE));
    expect(chunks[0]?.biome[(cell.y % CHUNK_SIZE) * CHUNK_SIZE + (cell.x % CHUNK_SIZE)]).toBe(
      testData.biomes.indexOf('desert'),
    );
    expect(takeDirtyChunks(state)).toEqual([]);
  });

  it('ne change jamais la franchissabilité d’une case, sommets compris : les terres restent justes', () => {
    // Le pinceau ne peint ni n'efface l'eau, et ne touche pas à l'altitude, qui fait les
    // sommets : chaque biome, peint sur une case de chaque étage d'altitude, de terre comme
    // d'eau, la laisse franchissable ou non comme avant. La couche des terres, qui ne se
    // recalcule pas en cours de partie, reste celle que donnent les coûts.
    const state = testState();
    const { width } = state.size;
    const levels = testData.altitudeLevels.entries;
    const probes = new Map<string, { cell: number; water: boolean; level: number }>();
    state.world.biome.forEach((biome, cell) => {
      const water = testData.biomes.entries.at(biome)?.family === 'water';
      const level = altitudeLevelIndex(levels, state.world.elevation[cell] ?? 0);
      const key = `${String(water)} ${String(level)}`;
      if (!probes.has(key)) probes.set(key, { cell, water, level });
    });
    const passable = (cell: number) => Number.isFinite(state.cost[cell] ?? Number.NaN);
    const walkable = (level: number) => (levels.at(level)?.movement ?? null) !== null;
    const cells = [...probes.values()];
    expect(cells.length).toBeGreaterThan(20);
    // Des sommets, terres infranchissables par leur altitude, et des eaux à un étage où l'on
    // marcherait : les lacs et les fleuves des terres.
    expect(cells.some((probe) => !probe.water && !passable(probe.cell))).toBe(true);
    expect(cells.some((probe) => probe.water && walkable(probe.level))).toBe(true);
    for (const { cell } of cells) {
      const before = passable(cell);
      const at = { x: cell % width, y: Math.floor(cell / width) };
      for (const biome of testData.biomes.entries) {
        applyCommand(state, { type: 'paintBiome', ...at, biome: biome.id }, testData);
        expect({ cell, biome: biome.id, passable: passable(cell) }).toEqual({
          cell,
          biome: biome.id,
          passable: before,
        });
      }
    }
    // L'autre commande, l'apparition d'un groupe, ne touche pas au terrain.
    step(state, scatteredGroups(state, 4), testData);
    expect(state.land).toEqual(terrainLands(state.cost, state.size));
  });

  it("laisse la mer et les lacs, et ne peint pas d'eau sur les terres", () => {
    const state = testState();
    const before = fingerprint(state);
    const sea = firstCellOf(state, (family) => family === 'water');
    const ground = firstCellOf(state, land);
    applyCommand(state, { type: 'paintBiome', ...sea, biome: 'desert' }, testData);
    applyCommand(state, { type: 'paintBiome', ...ground, biome: 'ocean' }, testData);
    applyCommand(state, { type: 'paintBiome', ...ground, biome: 'inconnu' }, testData);
    applyCommand(state, { type: 'paintBiome', x: 3, y: -4, biome: 'desert' }, testData);
    expect(fingerprint(state)).toBe(before);
    expect(takeDirtyChunks(state)).toEqual([]);
  });
});

describe('pas', () => {
  it('journalisent les commandes avec le pas où elles s’appliquent', () => {
    const state = testState();
    const cell = firstCellOf(state, land);
    step(state, [], testData);
    step(state, [{ type: 'paintBiome', ...cell, biome: 'steppe' }], testData);
    expect(state.tick).toBe(2);
    expect(state.commandLog).toEqual([
      { tick: 1, command: { type: 'paintBiome', ...cell, biome: 'steppe' } },
    ]);
  });

  it('écartent une commande qui échoue, sans trace dans l’état ni au journal (L-2)', () => {
    // Des humains que le schéma refuserait : en couple après la fin de leur fécondité,
    // l'âge de leurs adultes ne se tire pas. L'apparition lève une exception en plein
    // tirage, après la langue et la culture de son groupe.
    const broken: SimContent = {
      ...testData,
      species: {
        entries: [{ ...testHuman, couple: { ...testHuman.couple, minAge: 60 } }],
        indexOf: (id) => (id === testHuman.id ? 0 : undefined),
      },
    };
    const failing = testState();
    const control = testState();
    const cell = firstCellOf(failing, (family) => family === 'temperate');
    const spawn = { type: 'spawnGroup', ...cell, species: 'human', subspecies: 'plains' } as const;
    const paint = { type: 'paintBiome', ...firstCellOf(failing, land), biome: 'steppe' } as const;
    const rejected: [string, unknown][] = [];
    step(failing, [{ ...spawn, count: 12 }, paint], broken, (command, error) => {
      rejected.push([command.type, error]);
    });
    step(control, [paint], broken);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.[0]).toBe('spawnGroup');
    expect(rejected[0]?.[1]).toBeInstanceOf(RangeError);
    // Ni groupe, ni langue, ni culture, ni tirage : la partie est celle où rien n'a été tenté,
    // et la suite du mois s'est déroulée.
    expect(failing.commandLog).toEqual([{ tick: 0, command: paint }]);
    expect(failing.society.languages).toEqual([]);
    expect(fingerprint(failing)).toBe(fingerprint(control));
    // Les mois suivants le restent, une apparition réussie comprise.
    const valid = { ...spawn, count: 12 };
    step(failing, [valid], testData);
    step(control, [valid], testData);
    for (let month = 0; month < 6; month++) {
      step(failing, [], testData);
      step(control, [], testData);
    }
    expect(failing.society.groups.size).toBe(1);
    expect(fingerprint(failing)).toBe(fingerprint(control));
    // Sans rappel, l'exception remonte, comme au rejeu et dans les tests.
    expect(() => step(testState(), [{ ...spawn, count: 12 }], broken)).toThrow(RangeError);
  });

  it('donnent la même empreinte à la même graine, et une autre à une autre graine', () => {
    const a = testState('graine');
    const b = testState('graine');
    for (let tick = 0; tick < 5; tick++) {
      step(a, [], testData);
      step(b, [], testData);
    }
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(fingerprint(testState('autre'))).not.toBe(fingerprint(testState('graine')));
  });

  it("redonnent l'empreinte de référence d'un an de jeu (ADR 0003)", () => {
    // Un monde fixe, sans génération : l'empreinte ne dépend que de la simulation.
    const world = emptyLayers(WORLD_SIZES.small);
    world.biome.fill(testData.biomes.indexOf('steppe') ?? 0);
    world.elevation.fill(120);
    const state = createState(testParams('référence'), world, testData);
    step(state, [{ type: 'paintBiome', x: 10, y: 20, biome: 'desert' }], testData);
    for (let tick = 1; tick < 12; tick++) step(state, [], testData);
    expect(state.tick).toBe(12);
    // Empreinte de la phase 2 : l'état compte désormais la population, vide ici, et les
    // flux des systèmes, qui tournent chaque mois. Relecture de la phase 2 : une colonne de
    // plus, la langue du nom de famille.
    expect(fingerprint(state)).toBe('d7269069');
  });

  it("redonnent l'empreinte de référence de vingt ans d'une population (ADR 0003)", () => {
    // Le même monde fixe, et trois groupes : naissances, morts, couples, faim, marches,
    // scissions et fusions entrent dans l'empreinte, que les optimisations ne changent pas.
    const world = emptyLayers(WORLD_SIZES.small);
    world.biome.fill(testData.biomes.indexOf('steppe') ?? 0);
    world.elevation.fill(120);
    const state = createState(testParams('référence'), world, testData);
    const spawn = (x: number, y: number, subspecies: string) =>
      ({ type: 'spawnGroup', x, y, species: 'human', subspecies, count: 30 }) as const;
    step(
      state,
      [spawn(10, 60, 'plains'), spawn(30, 64, 'nordic'), spawn(505, 70, 'sands')],
      testData,
    );
    for (let tick = 1; tick < 240; tick++) step(state, [], testData);
    expect(state.people.count).toBeGreaterThan(40);
    // Relecture de la phase 2 : familles des groupes apparus, culture et nom à la
    // naissance (C2, D2), premier mois de vie, proches parents, mariages entre cultures ;
    // puis gibier plus rare dans le froid, pêche gelée comme sur la carte, marche sans
    // coin coupé, scissions (meneur, fratries, aire, une seule marche). Relecture des
    // corrections : voisins à un mois de marche, aire des scissions sur leur terre, et
    // célibataires qui cherchent plus souvent un conjoint (pairing).
    expect(fingerprint(state)).toBe('63f71745');
  });

  it("redonnent l'empreinte de référence de trente mois de trois mille individus (ADR 0011)", () => {
    // Cent groupes de trente répartis sur un vrai monde, comme les mesures de la
    // démographie (scatteredGroups) : climat, saisons, biomes, rivières et relief entrent
    // dans l'empreinte, à une échelle où les optimisations de la population comptent.
    // Trop nombreux pour le monde Petit, ils se scindent, et la faim les éclaircit : près
    // de 2 400 vivants, 177 groupes et plus de 900 morts au bout de trente mois. Comme
    // celle des scénarios du banc d'essai, qui l'imprime, l'empreinte ne change que si le
    // déroulement change (D-10) : à la relecture des corrections, par le voisinage à un
    // mois de marche, l'aire des scissions et `pairing`.
    const state = testState();
    step(state, scatteredGroups(state, 100), testData);
    for (let tick = 1; tick < 30; tick++) step(state, [], testData);
    expect(state.society.groups.size).toBeGreaterThan(100);
    expect(state.people.count).toBeGreaterThan(2000);
    expect(state.people.archive.rows).toBeGreaterThan(500);
    expect(fingerprint(state)).toBe('27ee4786');
  });
});
