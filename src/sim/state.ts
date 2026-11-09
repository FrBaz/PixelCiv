/**
 * État de la simulation : une couche par attribut, en tableaux typés (CLAUDE.md,
 * « Performances »). La phase 0 n'a qu'une couche de test, que parcourent quelques
 * promeneurs de test.
 */
import { wrapX } from '../core/cylinder';
import type { ChunkLayer, GameCommand, LoggedCommand } from '../core/protocol';
import { Rng } from '../core/rng';
import { CHUNK_SIZE, chunkGrid, type WorldSize } from '../core/world';

/** Nombre de promeneurs de test. */
export const WALKER_COUNT = 12;

/** Flux du générateur réservé aux promeneurs de test. */
export const WALKER_STREAM = 'test.walkers';

export interface SimState {
  readonly seed: string;
  readonly size: WorldSize;
  /** Pas écoulés depuis le début de la partie, un par mois. */
  tick: number;
  /** Couche de test : une valeur par case, ligne par ligne, 0 pour une case vide. */
  readonly testLayer: Uint8Array<ArrayBuffer>;
  /** Commandes de jeu appliquées, dans l'ordre : rejouées depuis la graine, elles redonnent l'état. */
  readonly commandLog: LoggedCommand[];
  /**
   * Commandes reçues et vérifiées, qui s'appliqueront au début du prochain pas. Elles
   * font partie de la sauvegarde : une partie rechargée les applique comme l'aurait
   * fait l'originale.
   */
  readonly pending: GameCommand[];
  /** Générateur de la partie, découpé en flux nommés (ADR 0003). */
  readonly rng: Rng;
  /** Positions des promeneurs de test, une colonne par coordonnée. */
  readonly walkerX: Uint16Array<ArrayBuffer>;
  readonly walkerY: Uint16Array<ArrayBuffer>;
  /**
   * Blocs modifiés depuis le dernier envoi, un drapeau par bloc. Ce n'est pas l'état
   * du monde : ni la sauvegarde ni l'empreinte n'en tiennent compte.
   */
  readonly dirtyChunks: Uint8Array;
}

export function createState(seed: string, size: WorldSize): SimState {
  const grid = chunkGrid(size);
  const rng = new Rng(seed);
  const random = rng.stream(WALKER_STREAM);
  const walkerX = new Uint16Array(WALKER_COUNT);
  const walkerY = new Uint16Array(WALKER_COUNT);
  for (let walker = 0; walker < WALKER_COUNT; walker++) {
    walkerX[walker] = random.nextInt(size.width);
    walkerY[walker] = random.nextInt(size.height);
  }
  return {
    seed,
    size,
    tick: 0,
    testLayer: new Uint8Array(size.width * size.height),
    commandLog: [],
    pending: [],
    rng,
    walkerX,
    walkerY,
    dirtyChunks: new Uint8Array(grid.columns * grid.rows),
  };
}

/** Marque le bloc de la case (x, y), déjà normalisée, comme modifié. */
function markDirty(state: SimState, x: number, y: number): void {
  const { columns } = chunkGrid(state.size);
  const column = Math.floor(x / CHUNK_SIZE);
  const row = Math.floor(y / CHUNK_SIZE);
  state.dirtyChunks[row * columns + column] = 1;
}

/**
 * Case qui contient le point (x, y) : sa colonne boucle d'est en ouest, et une ligne
 * hors du monde, au nord ou au sud, n'en a pas. La partie entière est prise avant de
 * boucler : x = -0,1 tombe bien dans la dernière colonne.
 */
function cellIndex(state: SimState, x: number, y: number): number | undefined {
  const { width, height } = state.size;
  const row = Math.floor(y);
  if (!(row >= 0 && row < height)) return undefined;
  return row * width + wrapX(Math.floor(x), width);
}

/** Valeur de la couche de test en (x, y) ; x boucle, y hors du monde vaut 0. */
export function testCell(state: SimState, x: number, y: number): number {
  const index = cellIndex(state, x, y);
  return index === undefined ? 0 : (state.testLayer[index] ?? 0);
}

/**
 * Écrit dans la couche de test. x boucle d'est en ouest ; une case hors du monde au
 * nord ou au sud est ignorée. Renvoie vrai si la case a changé.
 */
export function setTestCell(state: SimState, x: number, y: number, value: number): boolean {
  const index = cellIndex(state, x, y);
  if (index === undefined) return false;
  const { width } = state.size;
  const column = index % width;
  const row = (index - column) / width;
  const clamped = Math.max(0, Math.min(255, Math.floor(value)));
  if (state.testLayer[index] === clamped) return false;
  state.testLayer[index] = clamped;
  markDirty(state, column, row);
  return true;
}

/** Copie la couche de test d'un bloc, dans un tampon neuf, transférable. */
export function chunkLayer(state: SimState, column: number, row: number): ChunkLayer {
  const { width } = state.size;
  const cells = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
  for (let line = 0; line < CHUNK_SIZE; line++) {
    const start = (row * CHUNK_SIZE + line) * width + column * CHUNK_SIZE;
    cells.set(state.testLayer.subarray(start, start + CHUNK_SIZE), line * CHUNK_SIZE);
  }
  return { column, row, cells };
}

/** Tous les blocs, pour un instantané. */
export function allChunks(state: SimState): ChunkLayer[] {
  const { columns, rows } = chunkGrid(state.size);
  const chunks: ChunkLayer[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      chunks.push(chunkLayer(state, column, row));
    }
  }
  return chunks;
}

/** Blocs modifiés depuis le dernier appel, dont les drapeaux sont alors effacés. */
export function takeDirtyChunks(state: SimState): ChunkLayer[] {
  const { columns } = chunkGrid(state.size);
  const chunks: ChunkLayer[] = [];
  state.dirtyChunks.forEach((dirty, index) => {
    if (dirty !== 0) chunks.push(chunkLayer(state, index % columns, Math.floor(index / columns)));
  });
  state.dirtyChunks.fill(0);
  return chunks;
}
