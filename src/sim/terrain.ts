/**
 * Terrain de la simulation : la case qui contient un point du monde cylindrique, et le
 * coût de marche de chaque case (ADR 0011). Le fil principal s'en sert aussi, pour juger
 * comme la simulation la case où l'outil d'apparition fait venir un groupe : ce module ne
 * dépend que du monde et du contenu.
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
