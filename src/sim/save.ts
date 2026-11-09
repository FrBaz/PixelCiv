/**
 * Sauvegarde de l'état de la simulation (ADR 0007) : tableaux typés en binaire, le
 * reste en JSON. Une partie rechargée se poursuit à l'identique (NF-09).
 */
import { z } from 'zod';
import { Rng } from '../core/rng';
import { SaveError, type Migrations, type SaveData } from '../core/save/format';
import { chunkGrid, WORLD_SIZES, type WorldSize } from '../core/world';
import { GameCommandSchema, LoggedCommandSchema } from './commands';
import { WALKER_COUNT, WALKER_STREAM, type SimState } from './state';

const uint32 = z.number().int().min(0).max(0xffffffff);

/** État d'un flux : quatre mots, dont l'un au moins n'est pas nul (xoshiro bloquerait). */
const StreamStateSchema = z
  .tuple([uint32, uint32, uint32, uint32])
  .refine((words) => words.some((word) => word !== 0), 'état nul');

/** Seules les tailles prédéfinies existent : une autre trahit un fichier abîmé ou forgé. */
const WorldSizeSchema = z
  .object({ width: z.number(), height: z.number() })
  .strict()
  .refine(
    (size) =>
      Object.values(WORLD_SIZES).some(
        (known: WorldSize) => known.width === size.width && known.height === size.height,
      ),
    'taille de monde inconnue',
  );

const SimJsonSchema = z
  .object({
    size: WorldSizeSchema,
    commandLog: z.array(LoggedCommandSchema),
    pending: z.array(GameCommandSchema),
    rng: z.record(z.string().regex(/^[a-z][a-z0-9.]*$/), StreamStateSchema),
  })
  .strict();

/**
 * Migrations des sauvegardes (ADR 0007) : celle de la clé v mène de la version v à
 * v + 1. Une version sans migration est refusée comme trop ancienne.
 */
export const MIGRATIONS: Migrations = {
  // 1 → 2 : les commandes en attente du prochain pas entrent dans la sauvegarde.
  1: (save) =>
    typeof save.json === 'object' && save.json !== null && !Array.isArray(save.json)
      ? { ...save, json: { ...save.json, pending: [] } }
      : save,
};

/** Copie de l'état, prise d'un coup : la simulation peut repartir aussitôt. */
export function saveState(state: SimState): SaveData {
  return {
    meta: { seed: state.seed, tick: state.tick },
    json: {
      size: { width: state.size.width, height: state.size.height },
      // Les entrées du journal ne changent plus une fois écrites : copier la liste suffit.
      commandLog: [...state.commandLog],
      pending: [...state.pending],
      rng: state.rng.states(),
    },
    arrays: {
      testLayer: state.testLayer.slice(),
      walkerX: state.walkerX.slice(),
      walkerY: state.walkerY.slice(),
    },
  };
}

/** Tableau d'une sauvegarde, vérifié dans son type et sa longueur. */
function savedArray<T extends { readonly length: number }>(
  save: SaveData,
  name: string,
  type: abstract new (...args: never[]) => T,
  length: number,
): T {
  const array: unknown = save.arrays[name];
  if (!(array instanceof type) || array.length !== length) {
    throw new SaveError('corrupt', `tableau ${name} absent ou de mauvaise taille`);
  }
  return array;
}

/** Vérifie que chaque valeur d'un tableau reste sous `limit`. */
function within(array: Uint16Array, limit: number, name: string): void {
  if (array.some((value) => value >= limit)) {
    throw new SaveError('corrupt', `${name} hors du monde`);
  }
}

/**
 * Reconstruit l'état d'une sauvegarde ; lève une SaveError si elle est incohérente.
 * Les champs sont vérifiés entre eux : promeneurs dans le monde, journal ordonné et
 * antérieur au pas courant, flux du générateur présents et valides.
 */
export function restoreState(save: SaveData): SimState {
  const parsed = SimJsonSchema.safeParse(save.json);
  if (!parsed.success) throw new SaveError('corrupt', 'état illisible');
  const { size, commandLog, pending, rng } = parsed.data;
  const { tick } = save.meta;
  // Une commande journalisée au pas t s'est appliquée avant que le temps ne passe à t + 1.
  let previous = 0;
  for (const entry of commandLog) {
    if (entry.tick < previous || entry.tick >= tick) {
      throw new SaveError('corrupt', 'journal des commandes incohérent');
    }
    previous = entry.tick;
  }
  // La création de la partie tire déjà les promeneurs de ce flux.
  if (!Object.hasOwn(rng, WALKER_STREAM)) {
    throw new SaveError('corrupt', `flux ${WALKER_STREAM} absent`);
  }
  const walkerX = savedArray(save, 'walkerX', Uint16Array<ArrayBuffer>, WALKER_COUNT);
  const walkerY = savedArray(save, 'walkerY', Uint16Array<ArrayBuffer>, WALKER_COUNT);
  within(walkerX, size.width, 'walkerX');
  within(walkerY, size.height, 'walkerY');
  const grid = chunkGrid(size);
  return {
    seed: save.meta.seed,
    size,
    tick,
    testLayer: savedArray(save, 'testLayer', Uint8Array<ArrayBuffer>, size.width * size.height),
    commandLog: [...commandLog],
    pending: [...pending],
    rng: new Rng(save.meta.seed, rng),
    walkerX,
    walkerY,
    dirtyChunks: new Uint8Array(grid.columns * grid.rows),
  };
}
