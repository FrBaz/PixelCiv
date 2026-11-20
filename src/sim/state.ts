/**
 * État de la simulation : le monde généré, une couche par attribut en tableaux typés
 * (CLAUDE.md, « Performances » ; ADR 0009), la population et ses groupes (ADR 0011), dont la
 * position et le mouvement de chacun (ADR 0014), le temps, au mois et au jour (ADR 0013), le
 * journal des commandes et le générateur de la partie.
 */
import type { ChunkPatch, GameCommand, LoggedCommand } from '../core/protocol';
import { Rng } from '../core/rng';
import {
  CHUNK_SIZE,
  chunkGrid,
  WORLD_SIZES,
  type WorldLayers,
  type WorldSize,
} from '../core/world';
import type { WorldParams } from '../core/worldParams';
import { Fauna, seedFauna, type FaunaContent } from './fauna';
import { emptyStocks, type FoodStocks } from './forage';
import type { GroupsContent } from './groups';
import { Movement } from './movement';
import { Population } from './population';
import { emptySociety, type Society } from './society';
import { terrainCosts, terrainLands } from './terrain';

export { cellIndex } from './terrain';

export interface SimState {
  /** Paramètres du monde : graine, taille, réglages de la création. */
  readonly params: WorldParams;
  readonly size: WorldSize;
  /** Pas mensuels faits depuis le début de la partie, un par mois. */
  tick: number;
  /** Jours écoulés du mois en cours, de 0 à DAYS_PER_MONTH − 1 (ADR 0013). */
  day: number;
  /** Couches du monde. Le biome peut changer en cours de partie (pinceau). */
  readonly world: WorldLayers;
  /** Individus vivants, en colonnes, et archive des morts. */
  readonly people: Population;
  /** Groupes nomades, cultures, langues et chronique. */
  readonly society: Society;
  /** Stocks de nourriture des cases entamées : cueillette, gibier, poisson. */
  readonly food: FoodStocks;
  /** Gibier (ADR 0018) : animaux et hardes, en colonnes, et leurs caches. */
  readonly fauna: Fauna;
  /**
   * Caches du mouvement (ADR 0014) : marcheurs, départs, places tenues, portés, guides et
   * champs de distances. Ils se déduisent des colonnes des vivants et des groupes
   * (rebuildMovement) : ni la sauvegarde ni l'empreinte n'en tiennent compte.
   */
  readonly movement: Movement;
  /**
   * Coût de marche de chaque case (Infinity si elle est infranchissable). Il découle du
   * monde et du contenu : ni la sauvegarde ni l'empreinte n'en tiennent compte.
   */
  readonly cost: Float32Array<ArrayBuffer>;
  /**
   * Terre de chaque case, -1 pour une case infranchissable (terrainLands) : deux cases se
   * relient à pied si et seulement si elles sont sur la même terre. Elle découle de `cost`,
   * et se calcule avec lui, à la création et à la relecture d'une partie : ni la sauvegarde
   * ni l'empreinte n'en tiennent compte. Aucune commande ne change la franchissabilité d'une
   * case : le pinceau ne peint ni n'efface l'eau, seule infranchissable parmi les biomes, et
   * ne touche pas à l'altitude, qui fait les sommets. La couche ne se recalcule donc pas.
   */
  readonly land: Int32Array<ArrayBuffer>;
  /** Commandes de jeu appliquées, dans l'ordre : rejouées depuis le monde, elles redonnent l'état. */
  readonly commandLog: LoggedCommand[];
  /**
   * Commandes reçues et vérifiées, qui s'appliqueront au début du prochain jour. Elles
   * font partie de la sauvegarde : une partie rechargée les applique comme l'aurait
   * fait l'originale.
   */
  readonly pending: GameCommand[];
  /** Générateur de la simulation, découpé en flux nommés (ADR 0003). */
  readonly rng: Rng;
  /**
   * Blocs modifiés depuis le dernier envoi, un drapeau par bloc. Ce n'est pas l'état
   * du monde : ni la sauvegarde ni l'empreinte n'en tiennent compte.
   */
  readonly dirtyChunks: Uint8Array;
}

/**
 * Nouvel état, sur un monde qui vient d'être généré pour ces paramètres. Avec le contenu du
 * gibier, le gibier se sème avec le monde, d'après l'habitat (ADR 0018).
 */
export function createState(
  params: WorldParams,
  world: WorldLayers,
  content: Pick<GroupsContent, 'biomes' | 'altitudeLevels'> & Partial<FaunaContent>,
): SimState {
  const size = WORLD_SIZES[params.size];
  const grid = chunkGrid(size);
  const cost = terrainCosts(world, content);
  const state: SimState = {
    params,
    size,
    tick: 0,
    day: 0,
    world,
    people: new Population(),
    society: emptySociety(),
    food: emptyStocks(world.biome.length),
    fauna: new Fauna(),
    movement: new Movement(size.width, size.height),
    cost,
    land: terrainLands(cost, size),
    commandLog: [],
    pending: [],
    rng: new Rng(params.seed),
    dirtyChunks: new Uint8Array(grid.columns * grid.rows),
  };
  const { fauna, faunaRules, nomads, species } = content;
  if (
    fauna !== undefined &&
    faunaRules !== undefined &&
    nomads !== undefined &&
    species !== undefined
  ) {
    seedFauna(state, { ...content, fauna, faunaRules, nomads, species });
  }
  return state;
}

/** Marque le bloc de la case `index` comme modifié. */
export function markDirty(state: SimState, index: number): void {
  const { width } = state.size;
  const { columns } = chunkGrid(state.size);
  const x = index % width;
  const y = (index - x) / width;
  state.dirtyChunks[Math.floor(y / CHUNK_SIZE) * columns + Math.floor(x / CHUNK_SIZE)] = 1;
}

/** Biome d'un bloc, dans un tampon neuf, transférable. */
export function chunkPatch(state: SimState, column: number, row: number): ChunkPatch {
  const { width } = state.size;
  const biome = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
  for (let line = 0; line < CHUNK_SIZE; line++) {
    const start = (row * CHUNK_SIZE + line) * width + column * CHUNK_SIZE;
    biome.set(state.world.biome.subarray(start, start + CHUNK_SIZE), line * CHUNK_SIZE);
  }
  return { column, row, biome };
}

/** Blocs modifiés depuis le dernier appel, dont les drapeaux sont alors effacés. */
export function takeDirtyChunks(state: SimState): ChunkPatch[] {
  const { columns } = chunkGrid(state.size);
  const chunks: ChunkPatch[] = [];
  state.dirtyChunks.forEach((dirty, index) => {
    if (dirty !== 0) chunks.push(chunkPatch(state, index % columns, Math.floor(index / columns)));
  });
  state.dirtyChunks.fill(0);
  return chunks;
}
