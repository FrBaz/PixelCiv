/**
 * Outils des tests de la simulation et de l'hôte du worker : un vrai monde Petit,
 * généré une fois par fichier de test, et de quoi y commencer des parties. Le jeu
 * n'importe pas ce module.
 */
import { loadGameData, type Species } from '../core/data';
import { catalogOf, loadCatalog } from '../core/data/catalog';
import { SpeciesListSchema } from '../core/data/people';
import type { SpawnGroupCommand } from '../core/protocol';
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
 * Le contenu `content` sans gibier (ADR 0018) : une partie créée avec lui n'en sème pas, et ses
 * jours n'en font rien. La suite des humains n'en dépend pas (state.test.ts le vérifie) : les
 * tests longs des humains s'en servent, et ne paient pas le gibier.
 */
export function withoutFauna<T extends SimContent>(content: T): T {
  return { ...content, fauna: catalogOf([]) };
}

/**
 * Le contenu `content` sans activités (ADR 0021) : personne n'en choisit, ni ne tire sur le flux
 * des activités ; chacun se repose à sa place ou suit son groupe, comme en 2b.7. Sans les colonnes
 * des activités, l'empreinte d'une partie est celle d'avant elles (state.test.ts).
 */
export function withoutActivities<T extends SimContent>(content: T): T {
  return { ...content, activities: { ...content.activities, activities: [] } };
}

/**
 * Le contenu `content` sans chasse : son poids nul, personne ne chasse, et les humains ne lisent
 * plus rien du gibier (state.test.ts : le gibier ne change rien aux humains).
 */
export function withoutHunting<T extends SimContent>(content: T): T {
  return {
    ...content,
    activities: {
      ...content.activities,
      activities: content.activities.activities.map((activity) =>
        activity.place === 'prey' ? { ...activity, weight: 0 } : activity,
      ),
    },
  };
}

/** Le contenu `content` où chaque coup porte avec la chance `chance`, pour toute espèce du gibier. */
export function withHuntChance<T extends SimContent>(content: T, chance: number): T {
  return {
    ...content,
    fauna: catalogOf(
      content.fauna.entries.map((entry) => ({ ...entry, hunt: { ...entry.hunt, chance } })),
    ),
  };
}

/** Température d'un monde plat, en dixièmes de degré : 15 °C, une belle saison sans fin. */
export const FLAT_TEMPERATURE = 150;

/**
 * Nouvel état sur un monde Petit sans génération, tout de steppe à 120 m et à 15 °C toute
 * l'année : ni froid, ni chaleur, ni hiver, ni relief, de quoi poser des familles à la
 * main ou mesurer vite. `shape` retouche le monde avant que la partie commence : coûts de
 * marche et terres en découlent, comme dans une vraie partie.
 */
export function flatState(seed = 'plat', shape?: (world: WorldLayers) => void): SimState {
  const world = emptyLayers(WORLD_SIZES.small);
  world.biome.fill(testData.biomes.indexOf('steppe') ?? 0);
  world.elevation.fill(120);
  world.temperature.fill(FLAT_TEMPERATURE);
  shape?.(world);
  return createState(testParams(seed), world, testData);
}

/** Retouche d'un monde plat (flatState) : de l'océan sur les cases (x, y) que choisit `where`. */
export function flooded(where: (x: number, y: number) => boolean): (world: WorldLayers) => void {
  const ocean = testData.biomes.indexOf('ocean') ?? 0;
  const { width } = WORLD_SIZES.small;
  return (world) => {
    world.biome.forEach((_, cell) => {
      if (where(cell % width, Math.floor(cell / width))) world.biome[cell] = ocean;
    });
  };
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

/** Nouvel état, sur le monde Petit de cette graine ; `content` sans gibier n'en sème pas. */
export function testState(seed = 'graine', content: SimContent = testData): SimState {
  return createState(testParams(seed), testWorld(seed), content);
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

/** Familles de biomes où l'on pose des groupes répartis : celles où l'on vit de la cueillette. */
const HABITABLE = new Set(['temperate', 'tropical', 'arid', 'wetland', 'coast', 'cold']);

/**
 * `count` groupes de `members` humains répartis sur les terres d'une partie, comme les
 * mesures de la démographie (docs/BACKLOG.md) : les cases franchissables et habitables d'une
 * grille de 8 cases, prises à intervalles réguliers dans l'ordre des cases, et les
 * sous-espèces des humains à tour de rôle (nordiques, gens des plaines, des sables).
 */
export function scatteredGroups(state: SimState, count: number, members = 30): SpawnGroupCommand[] {
  const cells = habitableGrid(state);
  const subspecies = testHuman.subspecies.map((entry) => entry.id);
  return Array.from({ length: count }, (_, index) => ({
    type: 'spawnGroup',
    ...(cells[Math.floor((index * cells.length) / count)] ?? { x: 0, y: 0 }),
    species: testHuman.id,
    subspecies: subspecies[index % subspecies.length] ?? 'plains',
    count: members,
  }));
}

/**
 * Deux apparitions de `members` gens des plaines sur deux cases voisines, d'ouest en est,
 * franchissables et habitables : la première case de la grille de scatteredGroups dont la
 * voisine de l'est l'est aussi. Leurs membres se posent les uns près des autres.
 */
export function neighboringGroups(
  state: SimState,
  members = 20,
): [SpawnGroupCommand, SpawnGroupCommand] {
  const { width } = state.size;
  const spawnAt = (x: number, y: number): SpawnGroupCommand => ({
    type: 'spawnGroup',
    x,
    y,
    species: testHuman.id,
    subspecies: 'plains',
    count: members,
  });
  for (const { x, y } of habitableGrid(state)) {
    const east = (x + 1) % width;
    if (habitable(state, east, y)) return [spawnAt(x, y), spawnAt(east, y)];
  }
  throw new Error('aucune paire de cases voisines habitables');
}

/** Case franchissable dont le biome est habitable (HABITABLE). */
function habitable(state: SimState, x: number, y: number): boolean {
  const cell = y * state.size.width + x;
  const biome = testData.biomes.entries.at(state.world.biome[cell] ?? 0);
  const walkable = Number.isFinite(state.cost[cell] ?? Number.POSITIVE_INFINITY);
  return biome !== undefined && HABITABLE.has(biome.family) && walkable;
}

/** Les cases habitables d'une grille de 8 cases, dans l'ordre des cases. */
function habitableGrid(state: SimState): { x: number; y: number }[] {
  const { width, height } = state.size;
  const cells: { x: number; y: number }[] = [];
  for (let y = 4; y < height; y += 8) {
    for (let x = 4; x < width; x += 8) if (habitable(state, x, y)) cells.push({ x, y });
  }
  return cells;
}
