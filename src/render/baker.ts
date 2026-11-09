/**
 * Répartiteur de la cuisson (tâche 1.7 ; ADR 0010) : il confie les blocs à un ou deux
 * workers de cuisson, les blocs visibles d'abord, et remet leurs pixels à la vue de la
 * carte. Un bloc modifié par la simulation est recuit, avec ses voisins : le débordement
 * et les rivières passent d'un bloc à l'autre.
 */
import type { ChunkPatch } from '../core/protocol';
import { chunkGrid, type ChunkGrid, type WorldLayers, type WorldSize } from '../core/world';
import type { BakeBiome } from './bake';
import type { BakeReply, BakeRequest } from './bakeProtocol';

/** Blocs confiés en même temps à chaque worker : un en cours, un d'avance. */
const IN_FLIGHT = 2;

export type BakedListener = (column: number, row: number, pixels: Uint8Array<ArrayBuffer>) => void;

interface BakeWorker {
  readonly worker: Worker;
  busy: number;
}

export class Baker {
  private readonly workers: BakeWorker[];
  private readonly onBaked: BakedListener;
  private generation = 0;
  private grid: ChunkGrid | undefined;
  /** Blocs à cuire, et ceux confiés à un worker. */
  private pending = new Set<number>();
  private readonly inFlight = new Set<number>();
  /** Blocs visibles, dans l'ordre où les cuire. */
  private visible: number[] = [];

  constructor(onBaked: BakedListener, count = defaultWorkerCount()) {
    this.onBaked = onBaked;
    this.workers = Array.from({ length: count }, () => {
      const worker = new Worker(new URL('./bakeWorker.ts', import.meta.url), { type: 'module' });
      const entry: BakeWorker = { worker, busy: 0 };
      worker.addEventListener('message', (event: MessageEvent<BakeReply>) => {
        this.receive(entry, event.data);
      });
      return entry;
    });
  }

  /** Nouveau monde : chaque worker en reçoit une copie, et tous les blocs sont à cuire. */
  setWorld(
    size: WorldSize,
    layers: WorldLayers,
    biomes: readonly BakeBiome[],
    river: BakeBiome,
  ): void {
    this.generation++;
    this.grid = chunkGrid(size);
    this.pending = new Set(
      Array.from({ length: this.grid.columns * this.grid.rows }, (_, index) => index),
    );
    this.inFlight.clear();
    for (const entry of this.workers) {
      entry.busy = 0;
      this.post(entry, { type: 'world', generation: this.generation, size, layers, biomes, river });
    }
    this.pump();
  }

  /** Biomes changés dans un bloc : les workers les reçoivent, le bloc et ses voisins sont recuits. */
  patch(patch: ChunkPatch): void {
    const grid = this.grid;
    if (grid === undefined) return;
    for (const entry of this.workers) {
      this.post(entry, {
        type: 'patch',
        generation: this.generation,
        ...patch,
        biome: patch.biome.slice(),
      });
    }
    for (let dy = -1; dy <= 1; dy++) {
      const row = patch.row + dy;
      if (row < 0 || row >= grid.rows) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const column = (patch.column + dx + grid.columns) % grid.columns;
        this.pending.add(row * grid.columns + column);
      }
    }
    this.pump();
  }

  /** Blocs visibles, du centre de l'écran vers les bords : ils passent devant les autres. */
  prioritize(visible: readonly { readonly column: number; readonly row: number }[]): void {
    const grid = this.grid;
    if (grid === undefined) return;
    this.visible = visible.map((chunk) => chunk.row * grid.columns + chunk.column);
    this.pump();
  }

  /** Nombre de blocs qui restent à cuire. */
  get remaining(): number {
    return this.pending.size + this.inFlight.size;
  }

  destroy(): void {
    for (const entry of this.workers) entry.worker.terminate();
  }

  private next(): number | undefined {
    for (const index of this.visible) if (this.pending.has(index)) return index;
    for (const index of this.pending) return index;
    return undefined;
  }

  private pump(): void {
    const grid = this.grid;
    if (grid === undefined) return;
    for (const entry of this.workers) {
      while (entry.busy < IN_FLIGHT) {
        const index = this.next();
        if (index === undefined) return;
        this.pending.delete(index);
        this.inFlight.add(index);
        entry.busy++;
        this.post(entry, {
          type: 'bake',
          generation: this.generation,
          column: index % grid.columns,
          row: Math.floor(index / grid.columns),
        });
      }
    }
  }

  private receive(entry: BakeWorker, reply: BakeReply): void {
    if (reply.generation !== this.generation) return;
    entry.busy = Math.max(0, entry.busy - 1);
    const grid = this.grid;
    if (grid !== undefined) this.inFlight.delete(reply.row * grid.columns + reply.column);
    if (reply.type === 'baked') this.onBaked(reply.column, reply.row, reply.pixels);
    this.pump();
  }

  private post(entry: BakeWorker, message: BakeRequest): void {
    entry.worker.postMessage(message);
  }
}

/** Un worker de cuisson, deux si l'appareil a assez de cœurs. */
function defaultWorkerCount(): number {
  return (navigator.hardwareConcurrency || 2) >= 4 ? 2 : 1;
}
