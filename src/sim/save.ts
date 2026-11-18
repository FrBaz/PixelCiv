/**
 * Sauvegarde de l'état de la simulation (ADR 0007) : couches du monde, colonnes de la
 * population, chronique et stocks entamés en binaire, le reste en JSON. Une partie
 * rechargée se poursuit à l'identique (NF-09).
 *
 * La sauvegarde garde le monde lui-même, et non sa seule graine : elle reste lisible
 * quand le générateur change. Elle nomme aussi les biomes et les ressources dont ses
 * couches donnent les indices : une sauvegarde se relit après un changement du contenu,
 * tant que ses identifiants existent encore (ADR 0006).
 */
import { z } from 'zod';
import { deltaX } from '../core/cylinder';
import type { Catalog } from '../core/data/catalog';
import type { Genetics, Species } from '../core/data/people';
import type { AltitudeLevel, Biome, Resource } from '../core/data/schemas';
import type { Worldgen } from '../core/data/worldgen';
import { Rng } from '../core/rng';
import { SaveError, type Migrations, type SaveData, type SavedArray } from '../core/save/format';
import { dayIndex, DAYS_PER_MONTH } from '../core/time';
import {
  chunkGrid,
  LAYER_NAMES,
  LAYER_TYPES,
  WORLD_SIZES,
  type WorldLayers,
  type WorldSize,
} from '../core/world';
import { worldParamsSchema } from '../core/worldParams';
import { GameCommandSchema, LoggedCommandSchema } from './commands';
import {
  deplete,
  depletedCells,
  emptyStocks,
  FOOD_STRIDE,
  type FoodStocks,
  type ForageContent,
} from './forage';
import { terrainCosts, terrainLands } from './terrain';
import { Population } from './population';
import { migrateChronicle, restorePeople, savePeople } from './populationSave';
import { emptySociety, type Society } from './society';
import { rebuildPositions, type SimState } from './state';
import { DayPositions, Walks, type WalkArrays } from './walks';

/**
 * Stocks de nourriture d'une sauvegarde : la liste des cases entamées, sans doublon, et
 * leurs trois stocks, positifs et finis. Une partie de la version 3 n'en a pas.
 */
function restoreFood(save: SaveData, count: number): FoodStocks {
  const food = emptyStocks(count);
  const cells: unknown = save.arrays.foodCells;
  if (cells === undefined) return food;
  if (!(cells instanceof Int32Array)) throw new SaveError('corrupt', 'stocks illisibles');
  const layer = (name: string) => {
    const array: unknown = save.arrays[name];
    if (!(array instanceof Float32Array) || array.length !== cells.length) {
      throw new SaveError('corrupt', `stocks ${name} absents ou de mauvaise taille`);
    }
    return array;
  };
  const plants = layer('foodPlants');
  const game = layer('foodGame');
  const fish = layer('foodFish');
  cells.forEach((cell, index) => {
    const values = [plants[index] ?? 0, game[index] ?? 0, fish[index] ?? 0];
    if (cell < 0 || cell >= count || food.depleted[cell] === 1) {
      throw new SaveError('corrupt', 'cases des stocks incohérentes');
    }
    if (!values.every((value) => value >= 0 && value < 1e6)) {
      throw new SaveError('corrupt', 'stocks illisibles');
    }
    deplete(food, cell);
    food.stocks.set(values, cell * FOOD_STRIDE);
  });
  return food;
}

/** Contenu dont la sauvegarde se sert : les catalogues et les bornes des paramètres. */
export interface SaveContent extends ForageContent {
  readonly biomes: Catalog<Biome>;
  readonly altitudeLevels: Catalog<AltitudeLevel>;
  readonly resources: Catalog<Resource>;
  readonly species: Catalog<Species>;
  readonly genetics: Genetics;
  readonly worldgen: Pick<Worldgen, 'parameters'>;
}

const uint32 = z.number().int().min(0).max(0xffffffff);

/** État d'un flux : quatre mots, dont l'un au moins n'est pas nul (xoshiro bloquerait). */
const StreamStateSchema = z
  .tuple([uint32, uint32, uint32, uint32])
  .refine((words) => words.some((word) => word !== 0), 'état nul');

/** Nombre maximal de flux du générateur dans une sauvegarde : bien plus qu'il n'en faut. */
export const MAX_STREAMS = 1024;

/** Nom d'un flux du générateur. */
const StreamNameSchema = z.string().regex(/^[a-z][a-z0-9.]*$/);

/** Identifiants du contenu : au plus 256, puisque les couches les codent sur un octet. */
const ContentIdsSchema = z.array(z.string().regex(/^[a-z]+(-[a-z]+)*$/)).max(256);

/** L'objet a-t-il au plus `limit` clés ? Le compte s'arrête dès la limite franchie. */
function fewKeys(value: object, limit: number): boolean {
  let count = 0;
  for (const key in value) {
    if (Object.hasOwn(value, key) && ++count > limit) return false;
  }
  return true;
}

/**
 * Forme de l'état sauvegardé. Les listes de commandes et les flux ne sont pas vérifiés
 * ici, mais un à un, ensuite, jusqu'à la première erreur : sur une collection entière,
 * Zod relèverait chaque champ invalide de chaque élément, et des millions d'éléments
 * forgés épuiseraient la mémoire. Les flux sont comptés avant tout.
 */
const SimJsonSchema = z
  .object({
    params: z.unknown(),
    /** Jours écoulés du mois en cours (ADR 0013). */
    day: z
      .number()
      .int()
      .min(0)
      .max(DAYS_PER_MONTH - 1),
    generator: z.number().int().positive(),
    content: z.object({ biomes: ContentIdsSchema, resources: ContentIdsSchema }).strict(),
    commandLog: z.array(z.unknown()),
    pending: z.array(z.unknown()),
    people: z.unknown(),
    rng: z.custom<Readonly<Record<string, unknown>>>(
      (value) =>
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        fewKeys(value, MAX_STREAMS),
    ),
  })
  .strict();

/** Vérifie chaque élément d'une liste, et s'arrête au premier qui ne convient pas. */
function each<T>(items: readonly unknown[], schema: z.ZodType<T>, name: string): T[] {
  return items.map((item) => {
    const parsed = schema.safeParse(item);
    if (!parsed.success) throw new SaveError('corrupt', `${name} illisible`);
    return parsed.data;
  });
}

/**
 * Population vide d'une sauvegarde : ce que la version 4 ajoute à une partie de la 3,
 * dans la forme d'aujourd'hui (les migrations suivantes n'y changent rien).
 */
function emptyPeople(): { json: unknown; arrays: SaveData['arrays'] } {
  const empty = savePeople(new Population(), emptySociety(), {
    species: { entries: [], indexOf: () => undefined },
    genetics: { loci: [], traits: [], mutation: { allele: 0, trait: 0, jump: 0 } },
  });
  return empty;
}

/** Langue et règle de nommage d'une culture d'une sauvegarde, lues sans s'y fier. */
function savedCulture(entry: unknown): { language: number; naming: unknown } {
  if (typeof entry !== 'object' || entry === null) return { language: 0, naming: undefined };
  const { language, naming } = entry as { language?: unknown; naming?: unknown };
  return { language: typeof language === 'number' ? language : 0, naming };
}

/**
 * Version 5 : chacun reçoit la langue de son nom de famille, celle de sa culture, qui le
 * rendait jusqu'ici ; ainsi les noms affichés restent les mêmes. Une personne d'une
 * culture sans nom de famille n'en affichait pas : son code, que rien ne montrait mais
 * qu'un enfant aurait pu hériter, s'efface. Un tableau absent ou mal formé reste tel quel :
 * la relecture le refusera.
 */
function migrateFamilyNames(save: SaveData): SaveData {
  const json: unknown = save.json;
  const people: unknown =
    typeof json === 'object' && json !== null ? (json as { people?: unknown }).people : undefined;
  const list: unknown =
    typeof people === 'object' && people !== null
      ? (people as { cultures?: unknown }).cultures
      : undefined;
  // Les cultures, rangées par identifiant : celui de l'entrée i vaut i + 1.
  const cultures = (Array.isArray(list) ? (list as unknown[]) : []).map(savedCulture);
  const arrays: Record<string, SavedArray> = { ...save.arrays };
  for (const prefix of ['people', 'archive']) {
    const culture = save.arrays[`${prefix}Culture`];
    const family = save.arrays[`${prefix}FamilyName`];
    if (!(culture instanceof Uint16Array) || !(family instanceof Uint32Array)) continue;
    if (family.length !== culture.length) continue;
    arrays[`${prefix}FamilyLanguage`] = Uint16Array.from(
      culture,
      (id) => cultures[id - 1]?.language ?? 0,
    );
    arrays[`${prefix}FamilyName`] = Uint32Array.from(family, (code, index) =>
      cultures[(culture[index] ?? 0) - 1]?.naming === 'none' ? 0 : code,
    );
  }
  return { meta: save.meta, json: save.json, arrays };
}

/** Noms des tableaux des marches du mois, dans une sauvegarde. */
const WALK_ARRAYS = {
  groups: 'walkGroups',
  ends: 'walkEnds',
  cells: 'walkCells',
  costs: 'walkCosts',
  budgets: 'walkBudgets',
} as const satisfies Record<keyof WalkArrays, string>;

/** Les marches du mois, en tableaux de sauvegarde. */
function savedWalks(walks: WalkArrays): Record<string, SavedArray> {
  return {
    [WALK_ARRAYS.groups]: walks.groups,
    [WALK_ARRAYS.ends]: walks.ends,
    [WALK_ARRAYS.cells]: walks.cells,
    [WALK_ARRAYS.costs]: walks.costs,
    [WALK_ARRAYS.budgets]: walks.budgets,
  };
}

/**
 * Version 6 (ADR 0013) : la partie et chaque commande de son journal reçoivent le jour 0.
 * Une commande du mois t s'y appliquait au début du mois, avant tout calcul de ce mois :
 * c'est l'instant (t, 0). La partie n'a aucune marche en cours : ses groupes restent sur
 * leur case jusqu'au pas mensuel suivant, qui décide leur marche comme il l'aurait fait.
 * Un journal mal formé reste tel quel : la relecture le refusera.
 */
function migrateDays(save: SaveData): SaveData {
  const json: unknown = save.json;
  if (typeof json !== 'object' || json === null) return save;
  const log: unknown = (json as { commandLog?: unknown }).commandLog;
  const commandLog = Array.isArray(log)
    ? (log as unknown[]).map((entry) =>
        typeof entry === 'object' && entry !== null ? { ...entry, day: 0 } : entry,
      )
    : log;
  return {
    meta: save.meta,
    json: { ...json, day: 0, commandLog },
    arrays: { ...save.arrays, ...savedWalks(new Walks().arrays()) },
  };
}

/**
 * Migrations des sauvegardes (ADR 0007) : celle de la clé v mène de la version v à
 * v + 1. Une version sans migration est refusée comme trop ancienne : c'est le cas des
 * versions 1 et 2, parties de test de la phase 0, sans monde à reprendre. La version 4
 * ajoute la population (phase 2) : une partie de la 3 n'en a pas encore. La version 5
 * suit la relecture de la phase 2 : la langue des noms de famille (migrateFamilyNames),
 * la chronique en colonnes (migrateChronicle). Elle nomme aussi les sous-espèces de
 * chaque espèce ; une partie de la 4 ne les nommait pas, et suivait l'ordre des données,
 * qui n'a pas changé depuis : la relecture le reprend. La version 6 ajoute le jour et les
 * marches du mois (migrateDays).
 */
export const MIGRATIONS: Migrations = {
  3: (save) => {
    const people = emptyPeople();
    const json = typeof save.json === 'object' && save.json !== null ? save.json : {};
    return {
      meta: save.meta,
      json: { ...json, people: people.json },
      arrays: { ...save.arrays, ...people.arrays },
    };
  },
  4: (save) => migrateChronicle(migrateFamilyNames(save)),
  5: migrateDays,
};

/** Copie de l'état, prise d'un coup : la simulation peut repartir aussitôt. */
export function saveState(state: SimState, generator: number, content: SaveContent): SaveData {
  const arrays: Record<string, SavedArray> = {};
  for (const name of LAYER_NAMES) arrays[name] = state.world[name].slice();
  const people = savePeople(state.people, state.society, content);
  Object.assign(arrays, people.arrays);
  // Les seules cases entamées, dans l'ordre des cases : les autres sont au plafond de la
  // saison.
  const list = depletedCells(state.food);
  arrays.foodCells = Int32Array.from(list);
  const stock = (kind: number) =>
    Float32Array.from(list, (cell) => state.food.stocks[cell * FOOD_STRIDE + kind] ?? 0);
  arrays.foodPlants = stock(0);
  arrays.foodGame = stock(1);
  arrays.foodFish = stock(2);
  Object.assign(arrays, savedWalks(state.walks.arrays()));
  return {
    meta: { seed: state.params.seed, tick: state.tick },
    json: {
      params: state.params,
      day: state.day,
      generator,
      content: {
        biomes: content.biomes.entries.map((biome) => biome.id),
        resources: content.resources.entries.map((resource) => resource.id),
      },
      // Les entrées du journal ne changent plus une fois écrites : copier la liste suffit.
      commandLog: [...state.commandLog],
      pending: [...state.pending],
      people: people.json,
      rng: state.rng.states(),
    },
    arrays,
  };
}

/** Couche d'une sauvegarde, vérifiée dans son type et sa longueur, puis copiée. */
function savedLayer<K extends keyof WorldLayers>(
  save: SaveData,
  name: K,
  length: number,
): WorldLayers[K] {
  const array: unknown = save.arrays[name];
  const type = LAYER_TYPES[name];
  if (!(array instanceof type) || array.length !== length) {
    throw new SaveError('corrupt', `couche ${name} absente ou de mauvaise taille`);
  }
  return array.slice() as WorldLayers[K];
}

/**
 * Table de conversion des indices sauvegardés vers ceux du contenu actuel. Un
 * identifiant disparu du contenu rend la sauvegarde trop ancienne pour être reprise.
 */
function remapping(
  saved: readonly string[],
  catalog: Catalog<{ id: string }>,
  name: string,
): Uint8Array {
  const table = new Uint8Array(saved.length);
  saved.forEach((id, index) => {
    const current = catalog.indexOf(id);
    if (current === undefined) throw new SaveError('obsolete', `${name} inconnu : ${id}`);
    table[index] = current;
  });
  return table;
}

/** Un tableau des marches d'une sauvegarde, du type attendu. */
function walkArray<T extends Uint32Array<ArrayBuffer> | Float64Array<ArrayBuffer>>(
  save: SaveData,
  name: keyof WalkArrays,
  type: new (length: number) => T,
): T {
  const array: unknown = save.arrays[WALK_ARRAYS[name]];
  if (!(array instanceof type)) throw new SaveError('corrupt', `marches : ${name} illisible`);
  return array;
}

/**
 * Marches du mois d'une sauvegarde, vérifiées (ADR 0013) : chacune d'un groupe vivant, qui
 * n'en a pas d'autre ; deux cases au moins, dans le monde, chacune voisine de la
 * précédente, à travers la couture s'il le faut ; la dernière, celle du groupe ; des coûts
 * finis, de 0 au départ, croissants, au plus le budget, fini et positif. Les cases ne sont
 * pas jugées franchissables ou non : les coûts du terrain se recalculent d'après le contenu
 * du moment, qui a pu changer depuis la sauvegarde.
 */
function restoreWalks(save: SaveData, society: Society, size: WorldSize): WalkArrays {
  const walks: WalkArrays = {
    groups: walkArray(save, 'groups', Uint32Array),
    ends: walkArray(save, 'ends', Uint32Array),
    cells: walkArray(save, 'cells', Uint32Array),
    costs: walkArray(save, 'costs', Float64Array),
    budgets: walkArray(save, 'budgets', Float64Array),
  };
  const { groups, ends, cells, costs, budgets } = walks;
  const corrupt = (reason: string) => new SaveError('corrupt', `marches : ${reason}`);
  if (ends.length !== groups.length || budgets.length !== groups.length) {
    throw corrupt('tableaux de longueurs différentes');
  }
  if (costs.length !== cells.length) throw corrupt('coûts et cases de longueurs différentes');
  const { width, height } = size;
  const seen = new Set<number>();
  let start = 0;
  for (let index = 0; index < groups.length; index++) {
    const id = groups[index] ?? 0;
    const group = society.groups.get(id);
    if (group === undefined || seen.has(id)) throw corrupt('groupe inconnu ou en double');
    seen.add(id);
    const end = ends[index] ?? 0;
    if (end < start + 2 || end > cells.length) throw corrupt('chemin trop court ou tronqué');
    const budget = budgets[index] ?? Number.NaN;
    if (!(Number.isFinite(budget) && budget > 0)) throw corrupt('budget illisible');
    if (costs[start] !== 0) throw corrupt('coût de départ non nul');
    for (let at = start; at < end; at++) {
      const cell = cells[at] ?? 0;
      if (cell >= width * height) throw corrupt('case hors du monde');
      if (at === start) continue;
      const cost = costs[at] ?? Number.NaN;
      if (!(Number.isFinite(cost) && cost > (costs[at - 1] ?? 0))) throw corrupt('coûts');
      const previous = cells[at - 1] ?? 0;
      const dx = deltaX(previous % width, cell % width, width);
      const dy = Math.floor(cell / width) - Math.floor(previous / width);
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (dx === 0 && dy === 0)) {
        throw corrupt('cases non voisines');
      }
    }
    if (!((costs[end - 1] ?? Number.NaN) <= budget)) throw corrupt('chemin au-delà du budget');
    if (cells[end - 1] !== group.y * width + group.x) throw corrupt('arrivée hors de la case');
    start = end;
  }
  if (start !== cells.length) throw corrupt('cases en trop');
  return walks;
}

/**
 * Reconstruit l'état d'une sauvegarde ; lève une SaveError si elle est incohérente.
 * Les champs sont vérifiés entre eux : paramètres du monde, couches de la bonne taille,
 * indices du contenu connus, journal ordonné, jusqu'à l'instant courant compris, flux du
 * générateur valides, marches du mois.
 */
export function restoreState(save: SaveData, content: SaveContent): SimState {
  const parsed = SimJsonSchema.safeParse(save.json);
  if (!parsed.success) throw new SaveError('corrupt', 'état illisible');
  const params = worldParamsSchema(content.worldgen.parameters).safeParse(parsed.data.params);
  if (!params.success || params.data.seed !== save.meta.seed) {
    throw new SaveError('corrupt', 'paramètres du monde illisibles');
  }
  const size = WORLD_SIZES[params.data.size];
  const count = size.width * size.height;
  const rng: Record<string, [number, number, number, number]> = {};
  for (const [name, words] of Object.entries(parsed.data.rng)) {
    const state = StreamStateSchema.safeParse(words);
    if (!StreamNameSchema.safeParse(name).success || !state.success) {
      throw new SaveError('corrupt', 'flux du générateur illisible');
    }
    rng[name] = state.data;
  }
  const commandLog = each(parsed.data.commandLog, LoggedCommandSchema, 'journal');
  const pending = each(parsed.data.pending, GameCommandSchema, 'commandes en attente');
  const { tick } = save.meta;
  const { day } = parsed.data;
  // Une commande journalisée à l'instant (t, j) s'applique au début du jour j + 1, ou en
  // pause dès sa réception, avant que ce jour ne passe (ADR 0003, ADR 0013) : une
  // sauvegarde prise en pause juste après elle la garde au journal, à l'instant courant.
  const now = dayIndex({ tick, day });
  let previous = 0;
  for (const entry of commandLog) {
    const at = dayIndex(entry);
    if (at < previous || at > now) {
      throw new SaveError('corrupt', 'journal des commandes incohérent');
    }
    previous = at;
  }

  // Couches, puis indices du contenu ramenés à celui d'aujourd'hui.
  const world: WorldLayers = {
    elevation: savedLayer(save, 'elevation', count),
    waterDepth: savedLayer(save, 'waterDepth', count),
    biome: savedLayer(save, 'biome', count),
    drainage: savedLayer(save, 'drainage', count),
    temperature: savedLayer(save, 'temperature', count),
    amplitude: savedLayer(save, 'amplitude', count),
    precipitation: savedLayer(save, 'precipitation', count),
    deposit: savedLayer(save, 'deposit', count),
    trees: savedLayer(save, 'trees', count),
    shrubs: savedLayer(save, 'shrubs', count),
  };
  const biomes = remapping(parsed.data.content.biomes, content.biomes, 'biome');
  const resources = remapping(parsed.data.content.resources, content.resources, 'ressource');
  for (let cell = 0; cell < count; cell++) {
    const biome = world.biome[cell] ?? 0;
    const deposit = world.deposit[cell] ?? 0;
    const drainage = world.drainage[cell] ?? 0;
    if (biome >= biomes.length || deposit > resources.length) {
      throw new SaveError('corrupt', 'indice du contenu hors des listes');
    }
    // Direction de 0 à 8, classe de rivière sur deux bits, rien au-delà.
    if ((drainage & 0x0f) > 8 || drainage >> 6 !== 0) {
      throw new SaveError('corrupt', 'écoulement illisible');
    }
    world.biome[cell] = biomes[biome] ?? 0;
    if (deposit > 0) world.deposit[cell] = (resources[deposit - 1] ?? 0) + 1;
  }
  const { people, society } = restorePeople(save, parsed.data.people, content, size, tick);
  const walks = new Walks();
  walks.restore(restoreWalks(save, society, size));
  const food = restoreFood(save, count);
  const grid = chunkGrid(size);
  // Couches dérivées du monde et du contenu, comme à la création de la partie.
  const cost = terrainCosts(world, content);
  const state: SimState = {
    params: params.data,
    size,
    tick,
    day,
    world,
    people,
    society,
    food,
    walks,
    dayPositions: new DayPositions(),
    cost,
    land: terrainLands(cost, size),
    commandLog: [...commandLog],
    pending: [...pending],
    rng: new Rng(save.meta.seed, rng),
    dirtyChunks: new Uint8Array(grid.columns * grid.rows),
  };
  // Les positions du jour, cache que la sauvegarde ne garde pas, se recalculent.
  rebuildPositions(state);
  return state;
}
