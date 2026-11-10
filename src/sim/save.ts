/**
 * Sauvegarde de l'état de la simulation (ADR 0007) : couches du monde en binaire, le
 * reste en JSON. Une partie rechargée se poursuit à l'identique (NF-09).
 *
 * La sauvegarde garde le monde lui-même, et non sa seule graine : elle reste lisible
 * quand le générateur change. Elle nomme aussi les biomes et les ressources dont ses
 * couches donnent les indices : une sauvegarde se relit après un changement du contenu,
 * tant que ses identifiants existent encore (ADR 0006).
 */
import { z } from 'zod';
import type { Catalog } from '../core/data/catalog';
import type { Biome, Resource } from '../core/data/schemas';
import type { Worldgen } from '../core/data/worldgen';
import { Rng } from '../core/rng';
import { SaveError, type Migrations, type SaveData, type SavedArray } from '../core/save/format';
import { chunkGrid, LAYER_NAMES, LAYER_TYPES, WORLD_SIZES, type WorldLayers } from '../core/world';
import { worldParamsSchema } from '../core/worldParams';
import { GameCommandSchema, LoggedCommandSchema } from './commands';
import type { SimState } from './state';

/** Contenu dont la sauvegarde se sert : les catalogues et les bornes des paramètres. */
export interface SaveContent {
  readonly biomes: Catalog<Biome>;
  readonly resources: Catalog<Resource>;
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
 * Migrations des sauvegardes (ADR 0007) : celle de la clé v mène de la version v à
 * v + 1. Une version sans migration est refusée comme trop ancienne : c'est le cas des
 * versions 1 et 2, parties de test de la phase 0, sans monde à reprendre.
 */
export const MIGRATIONS: Migrations = {};

/** Copie de l'état, prise d'un coup : la simulation peut repartir aussitôt. */
export function saveState(state: SimState, generator: number, content: SaveContent): SaveData {
  const arrays: Record<string, SavedArray> = {};
  for (const name of LAYER_NAMES) arrays[name] = state.world[name].slice();
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
  const grid = chunkGrid(size);
  return {
    params: params.data,
    size,
    tick,
    world,
    commandLog: [...commandLog],
    pending: [...pending],
    rng: new Rng(save.meta.seed, rng),
    dirtyChunks: new Uint8Array(grid.columns * grid.rows),
  };
}
