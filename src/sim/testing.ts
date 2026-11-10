/**
 * Outils des tests de la simulation et de l'hôte du worker : un vrai monde Petit,
 * généré une fois par fichier de test, et de quoi y commencer des parties. Le jeu
 * n'importe pas ce module.
 */
import { loadGameData, type Species } from '../core/data';
import { loadCatalog } from '../core/data/catalog';
import { SpeciesListSchema } from '../core/data/people';
import { copyLayers, emptyLayers, type WorldLayers } from '../core/world';
import { defaultWorldParams, type WorldParams } from '../core/worldParams';
import { generateWorld } from '../worldgen/generate';
import { WORLD_SIZES } from '../core/world';
import { createState, type SimState } from './state';
import type { SimContent } from './step';

export const testData = loadGameData();

/** Les humains des données, l'espèce des tests. */
export const testHuman: Species = (() => {
  const human = testData.species.entries.at(0);
  if (human === undefined) throw new Error('pas d’humains dans les données');
  return human;
})();

/**
 * Le contenu des tests, avec des humains modifiés par `change` ; la variante passe par le
 * schéma de data/species.json, comme une espèce des données.
 */
export function withHuman(change: (human: Species) => Species): SimContent {
  return {
    ...testData,
    species: loadCatalog('variante de data/species.json', SpeciesListSchema, [change(testHuman)]),
  };
}

/**
 * Nouvel état sur un monde Petit sans génération, tout de steppe à 120 m et à 0 °C : ni
 * froid, ni chaleur, ni relief, de quoi poser des familles à la main ou mesurer vite.
 */
export function flatState(seed = 'plat'): SimState {
  const world = emptyLayers(WORLD_SIZES.small);
  world.biome.fill(testData.biomes.indexOf('steppe') ?? 0);
  world.elevation.fill(120);
  return createState(testParams(seed), world, testData);
}

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
  return createState(testParams(seed), testWorld(seed), testData);
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
