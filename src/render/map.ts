/**
 * Vue de la carte (tâches 1.7 et 1.8 ; REN-01 à REN-03, REN-10 ; ADR 0010).
 *
 * Une texture par bloc, cuite par les workers de cuisson, et recuite quand le bloc
 * change (REN-02) ; un maillage par bloc visible, placé à chaque image modulo la largeur
 * du monde (ADR 0002), à des positions entières en pixels physiques. Le shader des blocs
 * y pose les saisons et les modes de carte, d'après la texture de données des saisons
 * et la texture de superposition du mode, une valeur par case.
 *
 * Les textures des blocs ont leurs mipmaps, filtrés au plus proche : aux zooms
 * inférieurs à 1, chaque pixel de l'écran lit le niveau qui lui correspond, sans
 * scintiller (niveau de détail de base).
 */
import {
  BufferImageSource,
  Container,
  Mesh,
  MeshGeometry,
  Shader,
  UniformGroup,
  type Application,
} from 'pixi.js';
import type { Biome } from '../core/data/schemas';
import { seasonFactor } from '../core/seasons';
import type { ChunkPatch, WorldInfo } from '../core/protocol';
import {
  CHUNK_SIZE,
  chunkGrid,
  type ChunkGrid,
  type WorldLayers,
  type WorldSize,
} from '../core/world';
import { bakeBiomes, CHUNK_PX, type BakeBiome } from './bake';
import { Baker } from './baker';
import { displayScale, TILE_PX, visibleChunks, type Camera, type Extent } from './camera';
import { MAP_FRAGMENT, MAP_VERTEX } from './mapShader';
import { seasonPalettes, seasonTexels } from './seasons';

/**
 * Échelle d'affichage, en pixels CSS par pixel de carte, à partir de laquelle les
 * ruisseaux paraissent : de loin, ils chargeraient la carte.
 */
export const STREAMS_SCALE = 2;

/** Modes de carte (IHM-01) : naturel, puis les superpositions. */
export const MAP_MODES = ['natural', 'relief', 'biomes', 'resources'] as const;
export type MapMode = (typeof MAP_MODES)[number];

/** Couleurs de superposition d'un mode : un texel RGBA par case. */
export type OverlayBuilder = (mode: Exclude<MapMode, 'natural'>) => Uint8Array<ArrayBuffer>;

/** Maillage d'un bloc, sous le shader de la carte. */
type ChunkMesh = Mesh<MeshGeometry, Shader>;

interface ChunkView {
  readonly pixels: Uint8Array<ArrayBuffer>;
  readonly source: BufferImageSource;
  readonly shader: Shader;
  readonly mesh: ChunkMesh;
  baked: boolean;
}

/** Texture de données brutes, filtrée au plus proche, sans prémultiplication. */
function dataSource(
  pixels: Uint8Array<ArrayBuffer>,
  width: number,
  height: number,
  mipmaps = false,
) {
  return new BufferImageSource({
    resource: pixels,
    width,
    height,
    scaleMode: 'nearest',
    alphaMode: 'premultiplied-alpha',
    autoGenerateMipmaps: mipmaps,
  });
}

export class MapView {
  private readonly app: Application;
  private readonly layer = new Container();
  private readonly biomes: readonly Biome[];
  private readonly bake: readonly BakeBiome[];
  /** Indice du biome « rivière ». */
  private readonly riverBiome: number;
  private readonly geometry = new MeshGeometry({
    positions: new Float32Array([0, 0, CHUNK_PX, 0, CHUNK_PX, CHUNK_PX, 0, CHUNK_PX]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  });
  /** Réglages communs à tous les blocs : saison, mode, trame, tailles. */
  private readonly globals = new UniformGroup({
    uWorldCells: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
    uBiomes: { value: 1, type: 'f32' },
    uRiver: { value: 0, type: 'f32' },
    uSnow: { value: 0, type: 'f32' },
    uSeason: { value: 0, type: 'f32' },
    uMode: { value: 0, type: 'f32' },
    uRiverColor: { value: new Float32Array([0, 0, 1]), type: 'vec3<f32>' },
    uFine: { value: 1, type: 'f32' },
    uStreams: { value: 0, type: 'f32' },
  });
  private readonly palettes: BufferImageSource;
  private readonly baker: Baker;
  private grid: ChunkGrid | undefined;
  private size: WorldSize | undefined;
  private layers: WorldLayers | undefined;
  private chunks: ChunkView[] = [];
  private data: BufferImageSource | undefined;
  private overlay: BufferImageSource | undefined;
  private overlays: OverlayBuilder | undefined;
  private mode: MapMode = 'natural';

  constructor(app: Application, biomes: readonly Biome[]) {
    this.app = app;
    this.biomes = biomes;
    this.bake = bakeBiomes(biomes);
    this.riverBiome = biomes.findIndex((biome) => biome.id === 'river');
    const river = this.bake.at(this.riverBiome);
    if (river === undefined) throw new Error('biome « rivière » absent de data/biomes.json');
    this.globals.uniforms.uRiverColor = new Float32Array(river.base.map((value) => value / 255));
    this.palettes = dataSource(seasonPalettes(biomes), 3, biomes.length);
    this.globals.uniforms.uBiomes = biomes.length;
    this.globals.uniforms.uRiver = this.riverBiome;
    this.globals.uniforms.uSnow = Math.max(
      0,
      biomes.findIndex((biome) => biome.seasons.cover === 'snow'),
    );
    this.baker = new Baker((column, row, pixels) => {
      this.baked(column, row, pixels);
    });
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

  /** Blocs qui restent à cuire. */
  get pendingChunks(): number {
    return this.baker.remaining;
  }

  /** Nouveau monde : textures neuves, cuisson de tous les blocs, visibles d'abord. */
  setWorld(info: WorldInfo, layers: WorldLayers, overlays: OverlayBuilder): void {
    // Les shaders d'abord : un shader vivant garderait ses textures détruites, et Pixi
    // s'en plaindrait à chaque bloc.
    for (const chunk of this.chunks) {
      chunk.mesh.destroy();
      chunk.shader.destroy();
      chunk.source.destroy();
    }
    for (const mesh of this.copies) mesh.destroy();
    this.copies = [];
    this.data?.destroy();
    this.overlay?.destroy();
    const { size } = info;
    const grid = chunkGrid(size);
    this.grid = grid;
    this.size = size;
    this.layers = layers;
    this.overlays = overlays;
    this.data = dataSource(seasonTexels(size, layers, this.biomes), size.width, size.height);
    this.overlay = dataSource(
      new Uint8Array(size.width * size.height * 4),
      size.width,
      size.height,
    );
    this.globals.uniforms.uWorldCells = new Float32Array([size.width, size.height]);
    this.chunks = Array.from({ length: grid.columns * grid.rows }, (_, index) =>
      this.chunkView(index % grid.columns, Math.floor(index / grid.columns)),
    );
    this.setMode(this.mode);
    this.baker.setWorld(size, layers, this.bake, this.riverBiome);
  }

  /** Reporte les blocs modifiés dans les couches et la texture des saisons, puis les recuit. */
  updateChunks(patches: readonly ChunkPatch[]): void {
    const layers = this.layers;
    const size = this.size;
    if (layers === undefined || size === undefined || patches.length === 0) return;
    for (const patch of patches) {
      for (let line = 0; line < CHUNK_SIZE; line++) {
        const start = (patch.row * CHUNK_SIZE + line) * size.width + patch.column * CHUNK_SIZE;
        layers.biome.set(patch.biome.subarray(line * CHUNK_SIZE, (line + 1) * CHUNK_SIZE), start);
      }
      this.baker.patch(patch);
    }
    const data = this.data;
    if (data !== undefined) {
      (data.resource as Uint8Array).set(seasonTexels(size, layers, this.biomes));
      data.update();
    }
    if (this.mode !== 'natural') this.setMode(this.mode);
  }

  /** Mois courant, continu : 0 au début de janvier, 11,5 à la mi-décembre. */
  setSeason(month: number): void {
    this.globals.uniforms.uSeason = seasonFactor(month);
  }

  /** Mode de carte : sa superposition se calcule à la demande. */
  setMode(mode: MapMode): void {
    this.mode = mode;
    this.globals.uniforms.uMode = mode === 'natural' ? 0 : mode === 'resources' ? 2 : 1;
    const overlay = this.overlay;
    if (mode === 'natural' || overlay === undefined || this.overlays === undefined) return;
    (overlay.resource as Uint8Array).set(this.overlays(mode));
    overlay.update();
  }

  get currentMode(): MapMode {
    return this.mode;
  }

  /** Dessine les blocs visibles depuis la caméra. */
  draw(camera: Camera): void {
    const grid = this.grid;
    if (grid === undefined) return;
    const { resolution } = this.app.renderer;
    const scale = displayScale(camera.zoom);
    // De près, la trame suit les pixels ; de loin, les cases, pour ne pas scintiller.
    this.globals.uniforms.uFine = scale >= 1 ? 1 : 0;
    // Les ruisseaux ne paraissent qu'à partir de 2 pixels de l'écran (CSS) par pixel de carte.
    this.globals.uniforms.uStreams = scale / resolution >= STREAMS_SCALE ? 1 : 0;
    const placements = visibleChunks(camera, this.viewport, grid, CHUNK_PX);
    for (const chunk of this.chunks) chunk.mesh.visible = false;
    const shown = new Set<ChunkMesh>();
    const order: { column: number; row: number; distance: number }[] = [];
    const center = { x: this.viewport.width / 2, y: this.viewport.height / 2 };
    for (const placement of placements) {
      const chunk = this.chunks.at(placement.row * grid.columns + placement.column);
      if (chunk === undefined) continue;
      order.push({
        column: placement.column,
        row: placement.row,
        distance: Math.hypot(
          placement.left + placement.width / 2 - center.x,
          placement.top + placement.height / 2 - center.y,
        ),
      });
      if (!chunk.baked) continue;
      // Un bloc affiché deux fois (monde plus étroit que l'écran) : une copie du maillage.
      const mesh = shown.has(chunk.mesh) ? this.copyOf(chunk) : chunk.mesh;
      shown.add(mesh);
      mesh.visible = true;
      mesh.position.set(placement.left / resolution, placement.top / resolution);
      mesh.scale.set(
        placement.width / resolution / CHUNK_PX,
        placement.height / resolution / CHUNK_PX,
      );
    }
    this.releaseCopies(shown);
    this.globals.update();
    order.sort((a, b) => a.distance - b.distance);
    this.baker.prioritize(order);
  }

  private chunkView(column: number, row: number): ChunkView {
    const pixels = new Uint8Array(CHUNK_PX * CHUNK_PX * 4);
    const source = dataSource(pixels, CHUNK_PX, CHUNK_PX, true);
    const origin = new UniformGroup({
      uOrigin: {
        value: new Float32Array([column * CHUNK_SIZE, row * CHUNK_SIZE]),
        type: 'vec2<f32>',
      },
    });
    const shader = this.shaderFor(source, origin);
    const mesh: ChunkMesh = new Mesh({ geometry: this.geometry, shader });
    mesh.visible = false;
    this.layer.addChild(mesh);
    return { pixels, source, shader, mesh, baked: false };
  }

  private shaderFor(source: BufferImageSource, origin: UniformGroup): Shader {
    return Shader.from({
      gl: { vertex: MAP_VERTEX, fragment: MAP_FRAGMENT, name: 'pixelciv-map' },
      resources: {
        uChunk: source,
        uData: this.data ?? source,
        uPalettes: this.palettes,
        uOverlay: this.overlay ?? source,
        globals: this.globals,
        origin,
      },
    });
  }

  /** Copies des maillages d'un bloc qui paraît plusieurs fois à l'écran. */
  private copies: ChunkMesh[] = [];
  private copiesInUse = 0;

  private copyOf(chunk: ChunkView): ChunkMesh {
    let mesh = this.copies.at(this.copiesInUse);
    if (mesh === undefined) {
      mesh = new Mesh<MeshGeometry, Shader>({ geometry: this.geometry, shader: chunk.shader });
      this.layer.addChild(mesh);
      this.copies.push(mesh);
    } else {
      mesh.shader = chunk.shader;
    }
    this.copiesInUse++;
    return mesh;
  }

  private releaseCopies(shown: Set<ChunkMesh>): void {
    for (const mesh of this.copies) if (!shown.has(mesh)) mesh.visible = false;
    this.copiesInUse = 0;
  }

  private baked(column: number, row: number, pixels: Uint8Array<ArrayBuffer>): void {
    const grid = this.grid;
    if (grid === undefined) return;
    const chunk = this.chunks.at(row * grid.columns + column);
    if (chunk === undefined) return;
    chunk.pixels.set(pixels);
    chunk.source.update();
    chunk.baked = true;
  }
}

/** Case du monde sous un point de la carte, en pixels de carte. */
export function cellAt(mapX: number, mapY: number): { x: number; y: number } {
  return { x: Math.floor(mapX / TILE_PX), y: Math.floor(mapY / TILE_PX) };
}
