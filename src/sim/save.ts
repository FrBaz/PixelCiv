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
import type { Catalog } from '../core/data/catalog';
import type { Genetics, Species } from '../core/data/people';
import type { AltitudeLevel, Biome, Resource } from '../core/data/schemas';
import type { Worldgen } from '../core/data/worldgen';
import { Rng } from '../core/rng';
import { SaveError, type Migrations, type SaveData, type SavedArray } from '../core/save/format';
import { dayIndex, DAYS_PER_MONTH } from '../core/time';
import { FIXED, toFixed } from '../core/position';
import {
  chunkGrid,
  LAYER_NAMES,
  LAYER_TYPES,
  WORLD_SIZES,
  type WorldLayers,
  type WorldSizeId,
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
import { Fauna, FAUNA_STREAM, seedFauna, type FaunaContent } from './fauna';
import { FaunaSaveError, restoreFauna, saveFauna } from './faunaSave';
import { PLACE, Population } from './population';
import { Movement, placeMigrated, rebuildMovement } from './movement';
import { migrateChronicle, restorePeople, savePeople } from './populationSave';
import { emptySociety } from './society';
import type { SimState } from './state';

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

/**
 * Contenu dont la sauvegarde se sert : les catalogues et les bornes des paramètres, et le gibier,
 * qu'une partie de la version 7 reçoit à la relecture (FaunaContent).
 */
export interface SaveContent extends ForageContent, FaunaContent {
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
    /** Gibier (version 8, ADR 0018) ; null pour une partie de la version 7, qui le sème. */
    fauna: z.unknown(),
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

/** Noms des tableaux des marches du mois d'une sauvegarde de la version 6 (ADR 0013). */
const WALK_ARRAYS = ['walkGroups', 'walkEnds', 'walkCells', 'walkCosts', 'walkBudgets'] as const;

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
    arrays: {
      ...save.arrays,
      walkGroups: new Uint32Array(0),
      walkEnds: new Uint32Array(0),
      walkCells: new Uint32Array(0),
      walkCosts: new Float64Array(0),
      walkBudgets: new Float64Array(0),
    },
  };
}

/** Marches d'une sauvegarde de la version 6, lues sans s'y fier : vides si elles sont abîmées. */
interface OldWalks {
  readonly groups: Uint32Array;
  readonly ends: Uint32Array;
  readonly cells: Uint32Array;
  readonly costs: Float64Array;
  readonly budgets: Float64Array;
}

function oldWalks(save: SaveData): OldWalks {
  const [groups, ends, cells, costs, budgets] = WALK_ARRAYS.map((name) => save.arrays[name]);
  const empty = {
    groups: new Uint32Array(0),
    ends: new Uint32Array(0),
    cells: new Uint32Array(0),
    costs: new Float64Array(0),
    budgets: new Float64Array(0),
  };
  if (
    !(groups instanceof Uint32Array) ||
    !(ends instanceof Uint32Array) ||
    !(cells instanceof Uint32Array) ||
    !(costs instanceof Float64Array) ||
    !(budgets instanceof Float64Array) ||
    ends.length !== groups.length ||
    budgets.length !== groups.length ||
    costs.length !== cells.length
  ) {
    return empty;
  }
  let start = 0;
  for (const end of ends) {
    if (end < start + 2 || end > cells.length) return empty;
    start = end;
  }
  return { groups, ends, cells, costs, budgets };
}

/**
 * Position, en cases, au soir du jour `day`, d'un groupe sur la marche `index` de la version 6
 * (ADR 0013) : le point de son chemin de coût cumulé min(total, day × budget / 30), entre les
 * centres de deux cases voisines, au plus court à travers la couture. Seule la migration de la
 * version 6 s'en sert encore.
 */
function walkPoint(walks: OldWalks, index: number, day: number, width: number): [number, number] {
  const start = index === 0 ? 0 : (walks.ends[index - 1] ?? 0);
  const end = walks.ends[index] ?? start;
  const { cells, costs } = walks;
  const total = costs[end - 1] ?? 0;
  const spent = Math.min(total, (day * (walks.budgets[index] ?? 0)) / DAYS_PER_MONTH);
  let low = start;
  let high = end - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if ((costs[middle] ?? 0) <= spent) low = middle;
    else high = middle;
  }
  const from = cells[low] ?? 0;
  const fromX = from % width;
  const fromY = (from - fromX) / width;
  if (high <= low) return [fromX + 0.5, fromY + 0.5];
  const to = cells[high] ?? 0;
  const toX = to % width;
  const toY = (to - toX) / width;
  const low0 = costs[low] ?? 0;
  const span = (costs[high] ?? 0) - low0;
  const share = span > 0 ? Math.min(1, Math.max(0, (spent - low0) / span)) : 1;
  let dx = toX - fromX;
  if (dx > 1) dx -= width;
  else if (dx < -1) dx += width;
  let x = fromX + 0.5 + dx * share;
  if (x < 0) x += width;
  if (x >= width) x -= width;
  return [x, fromY + 0.5 + (toY - fromY) * share];
}

/**
 * Version 7 (ADR 0014) : chacun reçoit une position et un mouvement, et chaque groupe un camp.
 * Chaque membre se tient à la position du jour de son groupe, que donnent ses marches de la
 * version 6 (au centre de sa case, sans marche), toujours franchissable puisque ces chemins ne
 * coupent aucun coin ; il est « à poser » (PLACE), ce que seule la relecture accepte : elle
 * porte les nourrissons, et met les autres en partance le jour même vers une place au camp.
 * Le camp est la case du groupe au bout de sa marche ; son lieu, la case de sa position du
 * jour. Les marches sont ensuite oubliées, et la grégarité, inconnue, prendra à la relecture
 * la moyenne de l'ascendance. Un en-tête mal formé reste tel quel : la relecture le refusera.
 */
function migratePositions(save: SaveData): SaveData {
  const json: unknown = save.json;
  const walkArrays = new Set<string>(WALK_ARRAYS);
  const arrays: Record<string, SavedArray> = Object.fromEntries(
    Object.entries(save.arrays).filter(([name]) => !walkArrays.has(name)),
  );
  if (typeof json !== 'object' || json === null) return { meta: save.meta, json, arrays };
  const { day, params, people } = json as { day?: unknown; params?: unknown; people?: unknown };
  const sizeId: unknown =
    typeof params === 'object' && params !== null ? (params as { size?: unknown }).size : undefined;
  const size =
    WORLD_SIZES[
      typeof sizeId === 'string' && sizeId in WORLD_SIZES ? (sizeId as WorldSizeId) : 'small'
    ];
  const list: unknown =
    typeof people === 'object' && people !== null
      ? (people as { groups?: unknown }).groups
      : undefined;
  const end: unknown =
    typeof people === 'object' && people !== null ? (people as { end?: unknown }).end : undefined;
  if (!Array.isArray(list) || typeof end !== 'number' || !Number.isSafeInteger(end) || end < 0) {
    return { meta: save.meta, json, arrays };
  }
  const walks = oldWalks(save);
  const walkOf = new Map<number, number>();
  walks.groups.forEach((group, index) => walkOf.set(group, index));
  const today = typeof day === 'number' ? day : 0;
  const positions = new Map<number, [number, number]>();
  const groups = (list as unknown[]).map((entry) => {
    if (typeof entry !== 'object' || entry === null) return entry;
    const { id, x, y } = entry as { id?: unknown; x?: unknown; y?: unknown };
    if (typeof id !== 'number' || typeof x !== 'number' || typeof y !== 'number') return entry;
    const walk = walkOf.get(id);
    const point: [number, number] =
      walk === undefined ? [x + 0.5, y + 0.5] : walkPoint(walks, walk, today, size.width);
    positions.set(id, point);
    return {
      ...entry,
      x: Math.min(size.width - 1, Math.floor(point[0])),
      y: Math.min(size.height - 1, Math.floor(point[1])),
      campX: x,
      campY: y,
    };
  });
  const saved: unknown = save.arrays.peopleGroup;
  const memberGroups =
    saved instanceof Uint32Array && saved.length === end ? saved : new Uint32Array(0);
  const px = new Int32Array(end);
  const py = new Int32Array(end);
  for (let slot = 0; slot < memberGroups.length; slot++) {
    const point = positions.get(memberGroups[slot]) ?? [0.5, 0.5];
    px[slot] = Math.min(size.width * FIXED - 1, toFixed(point[0]));
    py[slot] = Math.min(size.height * FIXED - 1, toFixed(point[1]));
  }
  arrays.peopleX = px;
  arrays.peopleY = py;
  arrays.peopleMove = new Uint8Array(end).fill(PLACE);
  arrays.peopleDepart = new Uint8Array(end);
  arrays.peopleGoalX = px.slice();
  arrays.peopleGoalY = py.slice();
  arrays.peopleStepX = new Int32Array(end);
  arrays.peopleStepY = new Int32Array(end);
  arrays.peopleStepDays = new Uint16Array(end);
  return {
    meta: save.meta,
    json: { ...json, people: { ...(people as object), groups } },
    arrays,
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
  6: migratePositions,
  7: migrateFauna,
};

/**
 * Version 8 (tâche 2b.6, ADR 0018) : le gibier. Une partie de la version 7 n'en a pas
 * (`fauna: null`) : la relecture le sème d'après son état, ses stocks entamés compris, sur un flux
 * `sim.fauna` neuf. Une sauvegarde de la version 7 n'a pas ce flux ; une sauvegarde forgée qui en
 * porterait un le perd, pour que deux relectures donnent la même partie.
 */
function migrateFauna(save: SaveData): SaveData {
  const json = (typeof save.json === 'object' && save.json !== null ? save.json : {}) as Record<
    string,
    unknown
  >;
  const saved: unknown = json.rng;
  let rng = saved;
  if (typeof saved === 'object' && saved !== null && Object.hasOwn(saved, FAUNA_STREAM)) {
    const { [FAUNA_STREAM]: _dropped, ...rest } = saved as Record<string, unknown>;
    rng = rest;
  }
  return { meta: save.meta, json: { ...json, rng, fauna: null }, arrays: save.arrays };
}

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
  const fauna = saveFauna(state.fauna, content);
  Object.assign(arrays, fauna.arrays);
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
      fauna: fauna.json,
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
    fauna:
      parsed.data.fauna === null ? new Fauna() : savedFauna(parsed.data.fauna, save, content, size),
    movement: new Movement(size.width, size.height),
    cost,
    land: terrainLands(cost, size),
    commandLog: [...commandLog],
    pending: [...pending],
    rng: new Rng(save.meta.seed, rng),
    dirtyChunks: new Uint8Array(grid.columns * grid.rows),
  };
  // Les caches du mouvement, que la sauvegarde ne garde pas, se refont ; les membres d'une
  // partie de la version 6 se posent (migratePositions).
  rebuildMovement(state);
  placeMigrated(state, content);
  // Une partie de la version 7 n'a pas de gibier : il se sème d'après son état, de façon
  // déterministe (migrateFauna).
  if (parsed.data.fauna === null) seedFauna(state, content);
  return state;
}

/** Le gibier d'une sauvegarde, ou l'erreur d'une sauvegarde abîmée. */
function savedFauna(
  json: unknown,
  save: SaveData,
  content: SaveContent,
  size: { readonly width: number; readonly height: number },
): Fauna {
  try {
    return restoreFauna(json, save.arrays, content, size);
  } catch (error) {
    if (error instanceof FaunaSaveError) throw new SaveError('corrupt', error.message);
    throw error;
  }
}
