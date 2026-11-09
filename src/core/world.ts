/** Dimensions du monde et découpage en blocs de carte (ADR 0002). */

/** Côté d'un bloc de carte, en cases. */
export const CHUNK_SIZE = 64;

export interface WorldSize {
  readonly width: number;
  readonly height: number;
}

/** Tailles prédéfinies, au format 2:1 (MON-02). */
export const WORLD_SIZES = {
  small: { width: 512, height: 256 },
  medium: { width: 768, height: 384 },
  large: { width: 1024, height: 512 },
  huge: { width: 2048, height: 1024 },
} as const satisfies Record<string, WorldSize>;

export type WorldSizeId = keyof typeof WORLD_SIZES;

export interface ChunkGrid {
  readonly columns: number;
  readonly rows: number;
}

/** Nombre de blocs dans chaque direction ; les tailles sont des multiples de CHUNK_SIZE. */
export function chunkGrid(size: WorldSize): ChunkGrid {
  return { columns: size.width / CHUNK_SIZE, rows: size.height / CHUNK_SIZE };
}
