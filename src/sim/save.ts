/**
 * Sauvegarde de l'état de la simulation (ADR 0007) : tableaux typés en binaire, le
 * reste en JSON. Une partie rechargée se poursuit à l'identique (NF-09).
 */
import { z } from 'zod';
import type { GameCommand } from '../core/protocol';
import { Rng } from '../core/rng';
import { SaveError, type SaveData } from '../core/save/format';
import { CHUNK_SIZE, chunkGrid } from '../core/world';
import { WALKER_COUNT, type SimState } from './state';

const uint32 = z.number().int().min(0).max(0xffffffff);

const GameCommandSchema = z
  .object({ type: z.literal('paint'), x: z.number(), y: z.number(), value: z.number() })
  .strict() satisfies z.ZodType<GameCommand>;

const dimension = z
  .number()
  .int()
  .positive()
  .refine((value) => value % CHUNK_SIZE === 0, 'multiple de la taille des blocs');

const SimJsonSchema = z
  .object({
    size: z.object({ width: dimension, height: dimension }).strict(),
    commandLog: z.array(
      z.object({ tick: z.number().int().nonnegative(), command: GameCommandSchema }).strict(),
    ),
    rng: z.record(z.string(), z.tuple([uint32, uint32, uint32, uint32])),
  })
  .strict();

/** Copie de l'état, prise d'un coup : la simulation peut repartir aussitôt. */
export function saveState(state: SimState): SaveData {
  return {
    meta: { seed: state.seed, tick: state.tick },
    json: { size: state.size, commandLog: state.commandLog, rng: state.rng.states() },
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

/** Reconstruit l'état d'une sauvegarde ; lève une SaveError si elle est incohérente. */
export function restoreState(save: SaveData): SimState {
  const parsed = SimJsonSchema.safeParse(save.json);
  if (!parsed.success) throw new SaveError('corrupt', 'état illisible');
  const { size, commandLog, rng } = parsed.data;
  const grid = chunkGrid(size);
  return {
    seed: save.meta.seed,
    size,
    tick: save.meta.tick,
    testLayer: savedArray(save, 'testLayer', Uint8Array<ArrayBuffer>, size.width * size.height),
    commandLog: [...commandLog],
    rng: new Rng(save.meta.seed, rng),
    walkerX: savedArray(save, 'walkerX', Uint16Array<ArrayBuffer>, WALKER_COUNT),
    walkerY: savedArray(save, 'walkerY', Uint16Array<ArrayBuffer>, WALKER_COUNT),
    dirtyChunks: new Uint8Array(grid.columns * grid.rows),
  };
}
