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
import { chunkGrid, LAYER_NAMES, LAYER_TYPES, WORLD_SIZES, type WorldLayers } from '../core/world';
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
import { terrainCosts } from './groups';
import { Population } from './population';
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

/**
 * Migrations des sauvegardes (ADR 0007) : celle de la clé v mène de la version v à
 * v + 1. Une version sans migration est refusée comme trop ancienne : c'est le cas des
 * versions 1 et 2, parties de test de la phase 0, sans monde à reprendre. La version 4
 * ajoute la population (phase 2) : une partie de la 3 n'en a pas encore. La version 5
 * suit la relecture de la phase 2 : la langue des noms de famille (migrateFamilyNames),
 * la chronique en colonnes (migrateChronicle). Elle nomme aussi les sous-espèces de
 * chaque espèce ; une partie de la 4 ne les nommait pas, et suivait l'ordre des données,
 * qui n'a pas changé depuis : la relecture le reprend.
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
  return {
    meta: { seed: state.params.seed, tick: state.tick },
    json: {
      params: state.params,
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

/**
 * Reconstruit l'état d'une sauvegarde ; lève une SaveError si elle est incohérente.
 * Les champs sont vérifiés entre eux : paramètres du monde, couches de la bonne taille,
 * indices du contenu connus, journal ordonné et antérieur au pas courant, flux du
 * générateur valides.
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
  // Une commande journalisée au pas t s'est appliquée avant que le temps ne passe à t + 1.
  let previous = 0;
  for (const entry of commandLog) {
    if (entry.tick < previous || entry.tick >= tick) {
      throw new SaveError('corrupt', 'journal des commandes incohérent');
    }
    previous = entry.tick;
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
  return {
    params: params.data,
    size,
    tick,
    world,
    people,
    society,
    food,
    cost: terrainCosts(world, content),
    commandLog: [...commandLog],
    pending: [...pending],
    rng: new Rng(save.meta.seed, rng),
    dirtyChunks: new Uint8Array(grid.columns * grid.rows),
  };
}
