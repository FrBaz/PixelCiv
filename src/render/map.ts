/**
 * Vue de la carte : une texture par bloc, recuite quand le bloc change (REN-02),
 * et des sprites placés à chaque image sur les blocs visibles, modulo la largeur du
 * monde (ADR 0002). Les positions sont entières en pixels physiques.
 */
import { BufferImageSource, Container, Sprite, Texture, type Application } from 'pixi.js';
import type { ChunkPatch, WorldInfo } from '../core/protocol';
import { CHUNK_SIZE, chunkGrid, type ChunkGrid, type WorldLayers } from '../core/world';
import { bakeChunk, CHUNK_PX, type BakeWorld, type BiomePalette } from './bake';
import { TILE_PX, visibleChunks, type Camera, type Extent } from './camera';

interface ChunkTexture {
  readonly pixels: Uint8Array<ArrayBuffer>;
  readonly source: BufferImageSource;
  readonly texture: Texture;
}

export class MapView {
  private readonly app: Application;
  private readonly layer = new Container();
  private readonly sprites: Sprite[] = [];
  private grid: ChunkGrid | undefined;
  private chunks: ChunkTexture[] = [];
  private baked: BakeWorld | undefined;

  constructor(app: Application) {
    this.app = app;
    app.stage.addChild(this.layer);
  }

  /** Taille du monde en pixels de carte, connue après le premier instantané. */
  get world(): Extent | undefined {
    if (this.grid === undefined) return undefined;
    return { width: this.grid.columns * CHUNK_PX, height: this.grid.rows * CHUNK_PX };
  }

  /** Taille de l'écran en pixels physiques. */
  get viewport(): Extent {
    const { resolution } = this.app.renderer;
    return {
      width: Math.round(this.app.screen.width * resolution),
      height: Math.round(this.app.screen.height * resolution),
    };
  }

  /** Nouveau monde : une texture par bloc, cuite d'après ses couches. */
  setWorld(info: WorldInfo, layers: WorldLayers, palettes: readonly BiomePalette[]): void {
    for (const chunk of this.chunks) chunk.texture.destroy(true);
    const grid = chunkGrid(info.size);
    this.grid = grid;
    this.baked = { size: info.size, layers, palettes };
    this.chunks = Array.from({ length: grid.columns * grid.rows }, () => {
      const pixels = new Uint8Array(CHUNK_PX * CHUNK_PX * 4);
      const source = new BufferImageSource({
        resource: pixels,
        width: CHUNK_PX,
        height: CHUNK_PX,
        scaleMode: 'nearest',
      });
      return { pixels, source, texture: new Texture({ source }) };
    });
    for (let row = 0; row < grid.rows; row++) {
      for (let column = 0; column < grid.columns; column++) this.bake(column, row);
    }
  }

  /** Reporte les blocs modifiés dans les couches, et recuit ces blocs, eux seuls. */
  updateChunks(patches: readonly ChunkPatch[]): void {
    const world = this.baked;
    if (world === undefined) return;
    const { width } = world.size;
    for (const patch of patches) {
      for (let line = 0; line < CHUNK_SIZE; line++) {
        const start = (patch.row * CHUNK_SIZE + line) * width + patch.column * CHUNK_SIZE;
        world.layers.biome.set(
          patch.biome.subarray(line * CHUNK_SIZE, (line + 1) * CHUNK_SIZE),
          start,
        );
      }
      this.bake(patch.column, patch.row);
    }
  }

  private bake(column: number, row: number): void {
    const grid = this.grid;
    const world = this.baked;
    if (grid === undefined || world === undefined) return;
    const chunk = this.chunks.at(row * grid.columns + column);
    if (chunk === undefined) return;
    chunk.pixels.set(bakeChunk(world, column, row));
    chunk.source.update();
  }

  /** Dessine les blocs visibles depuis la caméra. */
  draw(camera: Camera): void {
    const grid = this.grid;
    if (grid === undefined) return;
    const { resolution } = this.app.renderer;
    const placements = visibleChunks(camera, this.viewport, grid, CHUNK_PX);
    while (this.sprites.length < placements.length) {
      const sprite = new Sprite();
      this.layer.addChild(sprite);
      this.sprites.push(sprite);
    }
    this.sprites.forEach((sprite, index) => {
      const placement = placements.at(index);
      const chunk =
        placement === undefined
          ? undefined
          : this.chunks.at(placement.row * grid.columns + placement.column);
      if (placement === undefined || chunk === undefined) {
        sprite.visible = false;
        return;
      }
      sprite.visible = true;
      sprite.texture = chunk.texture;
      sprite.position.set(placement.left / resolution, placement.top / resolution);
      sprite.width = placement.width / resolution;
      sprite.height = placement.height / resolution;
    });
  }
}

/** Case du monde sous un point de la carte, en pixels de carte. */
export function cellAt(mapX: number, mapY: number): { x: number; y: number } {
  return { x: Math.floor(mapX / TILE_PX), y: Math.floor(mapY / TILE_PX) };
}
