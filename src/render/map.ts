/**
 * Vue de la carte : une texture par bloc, mise à jour quand le bloc change (REN-02),
 * et des sprites placés à chaque image sur les blocs visibles, modulo la largeur du
 * monde (ADR 0002). Les positions sont entières en pixels physiques.
 */
import { BufferImageSource, Container, Sprite, Texture, type Application } from 'pixi.js';
import type { ChunkLayer, WorldInfo } from '../core/protocol';
import { chunkGrid, type ChunkGrid } from '../core/world';
import { TILE_PX, visibleChunks, type Camera, type Extent } from './camera';
import { bakeTestChunk, CHUNK_PX } from './testGrid';

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

  /** Nouveau monde : une texture par bloc, remplie par l'instantané. */
  setWorld(world: WorldInfo, layers: readonly ChunkLayer[]): void {
    for (const chunk of this.chunks) chunk.texture.destroy(true);
    this.grid = chunkGrid(world.size);
    this.chunks = Array.from({ length: this.grid.columns * this.grid.rows }, () => {
      const pixels = new Uint8Array(CHUNK_PX * CHUNK_PX * 4);
      const source = new BufferImageSource({
        resource: pixels,
        width: CHUNK_PX,
        height: CHUNK_PX,
        scaleMode: 'nearest',
      });
      return { pixels, source, texture: new Texture({ source }) };
    });
    this.updateChunks(layers);
  }

  /** Recuit les blocs modifiés, et eux seuls. */
  updateChunks(layers: readonly ChunkLayer[]): void {
    const grid = this.grid;
    if (grid === undefined) return;
    for (const layer of layers) {
      const chunk = this.chunks.at(layer.row * grid.columns + layer.column);
      if (chunk === undefined) continue;
      chunk.pixels.set(bakeTestChunk(layer, grid));
      chunk.source.update();
    }
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
