/**
 * Outils des tests de la simulation et de l'hôte du worker : un vrai monde Petit,
 * généré une fois par fichier de test, et de quoi y commencer des parties. Le jeu
 * n'importe pas ce module.
 */
import { loadGameData } from '../core/data';
import { copyLayers, type WorldLayers } from '../core/world';
import { defaultWorldParams, type WorldParams } from '../core/worldParams';
import { generateWorld } from '../worldgen/generate';
import { WORLD_SIZES } from '../core/world';
import { createState, type SimState } from './state';

export const testData = loadGameData();

const worlds = new Map<string, WorldLayers>();

/** Paramètres par défaut d'un monde Petit. */
export function testParams(seed = 'graine'): WorldParams {
  return defaultWorldParams(testData.worldgen.parameters, seed, 'small');
}

/** Monde Petit de cette graine, généré une seule fois ; chaque appel en rend une copie. */
export function testWorld(seed = 'graine'): WorldLayers {
  let world = worlds.get(seed);
  if (world === undefined) {
    world = generateWorld({ ...testParams(seed), size: WORLD_SIZES.small }, testData);
    worlds.set(seed, world);
  }
  return copyLayers(world);
}

/** Nouvel état, sur le monde Petit de cette graine. */
export function testState(seed = 'graine'): SimState {
  return createState(testParams(seed), testWorld(seed));
}

/** Coordonnées des n premières cases dont le biome est de la famille voulue. */
export function cellsOf(
  state: SimState,
  test: (family: string) => boolean,
  count: number,
): { x: number; y: number }[] {
  const cells: { x: number; y: number }[] = [];
  const { width } = state.size;
  for (let index = 0; index < state.world.biome.length && cells.length < count; index++) {
    const family = testData.biomes.entries.at(state.world.biome[index] ?? 0)?.family ?? '';
    if (test(family)) cells.push({ x: index % width, y: Math.floor(index / width) });
  }
  return cells;
}

/** La première case dont le biome est de la famille voulue ; lève une erreur s'il n'y en a pas. */
export function firstCellOf(
  state: SimState,
  test: (family: string) => boolean,
): { x: number; y: number } {
  const cell = cellsOf(state, test, 1).at(0);
  if (cell === undefined) throw new Error('aucune case de cette famille');
  return cell;
}
