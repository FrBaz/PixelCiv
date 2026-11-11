/**
 * État de la simulation : le monde généré, une couche par attribut en tableaux typés
 * (CLAUDE.md, « Performances » ; ADR 0009), la population et ses groupes (ADR 0011), le
 * temps, le journal des commandes et le générateur de la partie.
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
import { emptyStocks, type FoodStocks } from './forage';
import type { GroupsContent } from './groups';
import { Population } from './population';
import { emptySociety, type Society } from './society';
import { terrainCosts } from './terrain';

export { cellIndex } from './terrain';

export interface SimState {
  /** Paramètres du monde : graine, taille, réglages de la création. */
  readonly params: WorldParams;
  readonly size: WorldSize;
  /** Pas écoulés depuis le début de la partie, un par mois. */
  tick: number;
  /** Couches du monde. Le biome peut changer en cours de partie (pinceau). */
  readonly world: WorldLayers;
  /** Individus vivants, en colonnes, et archive des morts. */
  readonly people: Population;
  /** Groupes nomades, cultures, langues et chronique. */
  readonly society: Society;
  /** Stocks de nourriture des cases entamées : cueillette, gibier, poisson. */
  readonly food: FoodStocks;
  /**
   * Coût de marche de chaque case (Infinity si elle est infranchissable). Il découle du
   * monde et du contenu : ni la sauvegarde ni l'empreinte n'en tiennent compte.
   */
  readonly cost: Float32Array<ArrayBuffer>;
  /** Commandes de jeu appliquées, dans l'ordre : rejouées depuis le monde, elles redonnent l'état. */
  readonly commandLog: LoggedCommand[];
  /**
   * Commandes reçues et vérifiées, qui s'appliqueront au début du prochain pas. Elles
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

/** Nouvel état, sur un monde qui vient d'être généré pour ces paramètres. */
export function createState(
  params: WorldParams,
  world: WorldLayers,
  content: Pick<GroupsContent, 'biomes' | 'altitudeLevels'>,
): SimState {
  const size = WORLD_SIZES[params.size];
  const grid = chunkGrid(size);
  return {
    params,
    size,
    tick: 0,
    world,
    people: new Population(),
    society: emptySociety(),
    food: emptyStocks(world.biome.length),
    cost: terrainCosts(world, content),
    commandLog: [],
    pending: [],
    rng: new Rng(params.seed),
    dirtyChunks: new Uint8Array(grid.columns * grid.rows),
  };
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
