/**
 * Terrain de la simulation : la case qui contient un point du monde cylindrique, le coût
 * de marche de chaque case et les terres où l'on marche (ADR 0011). Le fil principal s'en
 * sert aussi, pour juger comme la simulation la case où l'outil d'apparition fait venir un
 * groupe : ce module ne dépend que du monde et du contenu.
 */
import { altitudeLevelIndex } from '../core/altitude';
import { wrapX } from '../core/cylinder';
import type { Biome, Catalog } from '../core/data';
import type { AltitudeLevel } from '../core/data/schemas';
import type { WorldLayers, WorldSize } from '../core/world';

/** Contenu dont dépend le coût de marche. */
export interface TerrainContent {
  readonly biomes: Catalog<Biome>;
  readonly altitudeLevels: Catalog<AltitudeLevel>;
}

/**
 * Case qui contient le point (x, y) : sa colonne boucle d'est en ouest, et une ligne
 * hors du monde, au nord ou au sud, n'en a pas, pas plus qu'un point non fini. La partie
 * entière est prise avant de boucler : x = -0,1 tombe bien dans la dernière colonne.
 */
export function cellIndex(size: WorldSize, x: number, y: number): number | undefined {
  const { width, height } = size;
  const row = Math.floor(y);
  if (!Number.isFinite(x) || !(row >= 0 && row < height)) return undefined;
  return row * width + wrapX(Math.floor(x), width);
}

const costs = new WeakMap<Catalog<Biome>, Float64Array>();

/** Coût de marche de chaque case du monde (voir walkCost). */
export function terrainCosts(
  world: WorldLayers,
  content: TerrainContent,
): Float32Array<ArrayBuffer> {
  return Float32Array.from(world.biome, (_, cell) => walkCost(world, cell, content));
}

/** Coût de marche d'une case : son biome, fois son étage ; Infinity s'il est infranchissable. */
export function walkCost(world: WorldLayers, cell: number, content: TerrainContent): number {
  let table = costs.get(content.biomes);
  if (table === undefined) {
    table = Float64Array.from(
      content.biomes.entries,
      (biome) => biome.movementCost ?? Number.POSITIVE_INFINITY,
    );
    costs.set(content.biomes, table);
  }
  const biome = table[world.biome[cell] ?? 0] ?? Number.POSITIVE_INFINITY;
  const levels = content.altitudeLevels.entries;
  const level = levels.at(altitudeLevelIndex(levels, world.elevation[cell] ?? 0));
  const movement = level?.movement ?? null;
  return movement === null ? Number.POSITIVE_INFINITY : biome * movement;
}

/**
 * Terres où l'on marche : le numéro de la terre de chaque case franchissable, -1 pour une
 * case infranchissable. Une terre réunit les cases franchissables voisines par un côté,
 * d'est en ouest à travers la couture, mais pas par les pôles. La marche (walk, dans
 * groups.ts) n'enjambe jamais une case infranchissable, pas même par un coin : une terre
 * est donc exactement ce qu'une suite de pas relie, et une marche n'en change jamais. Les
 * terres sont numérotées dans l'ordre de leur première case.
 */
export function terrainLands(cost: Float32Array, size: WorldSize): Int32Array<ArrayBuffer> {
  const { width } = size;
  const count = cost.length;
  const land = new Int32Array(count).fill(-1);
  // Cases numérotées dont on n'a pas encore regardé les voisines : chacune y entre une fois.
  const stack = new Int32Array(count);
  let top = 0;
  let next = 0;
  const visit = (cell: number) => {
    if (land[cell] !== -1 || !Number.isFinite(cost[cell] ?? Number.POSITIVE_INFINITY)) return;
    land[cell] = next;
    stack[top++] = cell;
  };
  for (let start = 0; start < count; start++) {
    if (land[start] !== -1 || !Number.isFinite(cost[start] ?? Number.POSITIVE_INFINITY)) continue;
    visit(start);
    while (top > 0) {
      const cell = stack[--top] ?? 0;
      const x = cell % width;
      visit(x === width - 1 ? cell + 1 - width : cell + 1);
      visit(x === 0 ? cell - 1 + width : cell - 1);
      if (cell >= width) visit(cell - width);
      if (cell + width < count) visit(cell + width);
    }
    next++;
  }
  return land;
}
