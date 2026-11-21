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
 *
 * La mer animée (tâche 2b.4, ADR 0015) a son programme : chaque bloc a deux shaders, aux
 * mêmes textures, et ne prend celui de l'onde que si elle s'y voit (force non nulle, échelle
 * 1 ou plus, mode naturel) et que la partie visible du bloc touche une tuile de mer de sa
 * cuisson (seaMask). L'onde ne recuit rien : seuls ses uniformes changent, à chaque pas.
 *
 * La neige et la glace à inertie (tâche 2b.7, ADR 0019) : les calendriers de chaque case, que
 * l'instantané apporte du worker, forment une texture de W × 2H texels (la neige, puis la glace),
 * lue au plus proche ; le shader en tire la part du jour continu (uDay). Rien ne se recuit, et
 * aucun pas ne les change.
 */
import {
  BufferImageSource,
  Container,
  Mesh,
  MeshGeometry,
  RenderTexture,
  Shader,
  UniformGroup,
  type Application,
} from 'pixi.js';
import type { Biome, Seasons } from '../core/data/schemas';
import { seasonFactor } from '../core/seasons';
import { CALENDAR_BYTES } from '../core/snow';
import { DAYS_PER_MONTH } from '../core/time';
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
import {
  displayScale,
  visibleChunks,
  type Camera,
  type ChunkPlacement,
  type Extent,
} from './camera';
import { coverUniforms, MAP_FRAGMENT, MAP_FRAGMENT_WAVES, MAP_VERTEX } from './mapShader';
import { seasonPalettes, seasonTexels, shadowTones } from './seasons';
import type { GroundTextures } from './humanShader';
import {
  MAX_WAVE_BIOMES,
  seaInRect,
  seaTones,
  WAVE_NOISE,
  waveNoise,
  wavePhase,
  waveTable,
  type WaveTable,
} from './waves';

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
  /** Le shader de la carte, et celui de la mer animée, aux mêmes textures. */
  readonly shader: Shader;
  readonly waveShader: Shader;
  readonly mesh: ChunkMesh;
  baked: boolean;
  /** Masque de la mer animée de sa cuisson, un octet par tuile (src/render/waves.ts, seaMask). */
  seaMask: Uint8Array;
}

/**
 * La partie de l'écran `viewport` (pixels physiques) que couvre le bloc placé en `placement`,
 * en pixels du bloc : [left, right[ × [top, bottom[, élargie aux pixels du bloc entamés ; vide
 * (right ≤ left ou bottom ≤ top) si le bloc est hors de l'écran.
 */
function visiblePart(placement: ChunkPlacement, viewport: Extent) {
  // Sur un côté : le bloc commence à `start` et mesure `size` pixels de l'écran, qui en a `screen`.
  const span = (start: number, size: number, screen: number) => {
    if (size <= 0) return [0, 0] as const;
    const from = Math.max(0, -start);
    const to = Math.min(size, screen - start);
    return [
      Math.max(0, Math.floor((from * CHUNK_PX) / size)),
      Math.min(CHUNK_PX, Math.ceil((to * CHUNK_PX) / size)),
    ] as const;
  };
  const [left, right] = span(placement.left, placement.width, viewport.width);
  const [top, bottom] = span(placement.top, placement.height, viewport.height);
  return { left, top, right, bottom };
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
  /** Réglages communs à tous les blocs : saison, couvertures, mode, trame, tailles. */
  private readonly globals = new UniformGroup({
    uWorldCells: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
    uBiomes: { value: 1, type: 'f32' },
    uRiver: { value: 0, type: 'f32' },
    uSnow: { value: 0, type: 'f32' },
    uSeason: { value: 0, type: 'f32' },
    uDay: { value: 0, type: 'f32' },
    uSnowRamp: { value: new Float32Array(3), type: 'vec3<f32>' },
    uIceRamp: { value: new Float32Array(3), type: 'vec3<f32>' },
    uSeaIceRamp: { value: new Float32Array(3), type: 'vec3<f32>' },
    uForestSnow: { value: 1, type: 'f32' },
    uMode: { value: 0, type: 'f32' },
    uRiverColor: { value: new Float32Array([0, 0, 1]), type: 'vec3<f32>' },
    uFine: { value: 1, type: 'f32' },
    uStreams: { value: 0, type: 'f32' },
  });
  /**
   * Réglages de la mer animée, que seul son programme lit (src/render/waves.ts). Statiques :
   * PixiJS ne les renvoie au GPU qu'après update(), appelé quand ils changent (phase, force,
   * table, monde), une fois pour le programme et non à chaque bloc de chaque image.
   */
  private readonly waveGlobals = new UniformGroup(
    {
      uWavePhase: { value: new Float32Array(4), type: 'vec4<f32>' },
      uWorldPx: { value: CHUNK_PX, type: 'f32' },
      uWaveCount: { value: 0, type: 'f32' },
      uWaveTones: {
        value: new Float32Array(MAX_WAVE_BIOMES * 9),
        type: 'vec3<f32>',
        size: MAX_WAVE_BIOMES * 3,
      },
      uWaveCrests: {
        value: new Float32Array(MAX_WAVE_BIOMES * 4),
        type: 'vec4<f32>',
        size: MAX_WAVE_BIOMES,
      },
      uWaveRipples: {
        value: new Float32Array(MAX_WAVE_BIOMES * 4),
        type: 'vec4<f32>',
        size: MAX_WAVE_BIOMES,
      },
      uCalmDays: { value: 1, type: 'f32' },
    },
    { isStatic: true },
  );
  /** Bruit fixe de l'onde, lu au plus proche. */
  private readonly waveNoise = dataSource(waveNoise(), WAVE_NOISE, WAVE_NOISE);
  /** Force de l'onde (0 : pas d'onde), son pas, et sa table à cette force. */
  private waveForce = 1;
  private waveStep = 0;
  private table: WaveTable;
  /** Un bloc a-t-il pris le programme de l'onde à la dernière image (wavesShown) ? */
  private seaShown = false;
  /** Le programme de l'onde a-t-il été compilé, hors de l'écran ? */
  private warmed = false;
  /**
   * Version de ce que montrent les blocs, hors caméra, saison et onde : augmentée à chaque
   * texture envoyée (bloc cuit, données des saisons, superposition), à chaque mode, à chaque
   * monde et à chaque table de l'onde. La signature de l'image la lit (rendu à la demande).
   */
  private version = 0;
  private readonly palettes: BufferImageSource;
  /** Tons d'ombre des biomes, pour l'ombre portée « ground » des objets (ADR 0017, § 4). */
  private readonly tones: BufferImageSource;
  private readonly baker: Baker;
  private grid: ChunkGrid | undefined;
  private size: WorldSize | undefined;
  private layers: WorldLayers | undefined;
  private chunks: ChunkView[] = [];
  private data: BufferImageSource | undefined;
  /** Calendriers de la neige et de la glace du monde, W × 2H texels (src/core/snow.ts). */
  private calendars: BufferImageSource | undefined;
  /** Les rampes et la part de neige des forêts (data/seasons.json), pour l'ombre « ground ». */
  private readonly covers: ReturnType<typeof coverUniforms>;
  private overlay: BufferImageSource | undefined;
  private overlays: OverlayBuilder | undefined;
  private mode: MapMode = 'natural';

  constructor(app: Application, biomes: readonly Biome[], seasons: Seasons) {
    this.app = app;
    this.biomes = biomes;
    this.covers = coverUniforms(seasons);
    const { uniforms } = this.globals;
    uniforms.uSnowRamp = this.covers.snow;
    uniforms.uIceRamp = this.covers.ice;
    uniforms.uSeaIceRamp = this.covers.seaIce;
    uniforms.uForestSnow = this.covers.forest;
    this.waveGlobals.uniforms.uCalmDays = seasons.calmDays;
    this.bake = bakeBiomes(biomes);
    this.riverBiome = biomes.findIndex((biome) => biome.id === 'river');
    const river = this.bake.at(this.riverBiome);
    if (river === undefined) throw new Error('biome « rivière » absent de data/biomes.json');
    this.globals.uniforms.uRiverColor = new Float32Array(river.base.map((value) => value / 255));
    this.palettes = dataSource(seasonPalettes(biomes), 3, biomes.length);
    this.tones = dataSource(shadowTones(biomes), 2, biomes.length);
    this.globals.uniforms.uBiomes = biomes.length;
    this.globals.uniforms.uRiver = this.riverBiome;
    this.globals.uniforms.uSnow = Math.max(
      0,
      biomes.findIndex((biome) => biome.seasons.cover === 'snow'),
    );
    this.table = waveTable(biomes, this.waveForce);
    this.applyWaveTable();
    this.baker = new Baker((column, row, pixels, seaMask) => {
      this.baked(column, row, pixels, seaMask);
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

  /**
   * Le sol du monde, que lit l'ombre portée « ground » des objets (people.ts) : la texture des
   * saisons et celle des calendriers, une valeur par case, les tons d'ombre des biomes et les
   * rampes des couvertures. Des textures neuves par monde.
   */
  get ground(): GroundTextures | undefined {
    if (this.data === undefined || this.calendars === undefined || this.size === undefined) {
      return undefined;
    }
    return {
      data: this.data,
      calendars: this.calendars,
      tones: this.tones,
      columns: this.size.width,
      rows: this.size.height,
      biomes: this.biomes.length,
      covers: this.covers,
    };
  }

  /** Blocs qui restent à cuire. */
  get pendingChunks(): number {
    return this.baker.remaining;
  }

  /**
   * Nouveau monde : textures neuves, cuisson de tous les blocs, visibles d'abord. `calendars` :
   * ceux de l'instantané (protocole 8), huit octets par case, gardés tels quels dans leur texture.
   */
  setWorld(
    info: WorldInfo,
    layers: WorldLayers,
    calendars: Uint8Array<ArrayBuffer>,
    overlays: OverlayBuilder,
  ): void {
    // Les shaders d'abord : un shader vivant garderait ses textures détruites, et Pixi
    // s'en plaindrait à chaque bloc.
    for (const chunk of this.chunks) {
      chunk.mesh.destroy();
      chunk.shader.destroy();
      chunk.waveShader.destroy();
      chunk.source.destroy();
    }
    for (const mesh of this.copies) mesh.destroy();
    this.copies = [];
    this.data?.destroy();
    this.calendars?.destroy();
    this.overlay?.destroy();
    const { size } = info;
    if (calendars.length !== size.width * size.height * 2 * CALENDAR_BYTES) {
      throw new RangeError('calendriers de la neige et de la glace : longueur inattendue');
    }
    const grid = chunkGrid(size);
    this.grid = grid;
    this.size = size;
    this.layers = layers;
    this.overlays = overlays;
    this.data = dataSource(seasonTexels(size, layers, this.biomes), size.width, size.height);
    this.calendars = dataSource(calendars, size.width, size.height * 2);
    this.overlay = dataSource(
      new Uint8Array(size.width * size.height * 4),
      size.width,
      size.height,
    );
    this.globals.uniforms.uWorldCells = new Float32Array([size.width, size.height]);
    this.waveGlobals.uniforms.uWorldPx = grid.columns * CHUNK_PX;
    this.waveGlobals.update();
    this.version++;
    this.setWaves(this.waveStep, this.waveForce);
    this.chunks = Array.from({ length: grid.columns * grid.rows }, (_, index) =>
      this.chunkView(index % grid.columns, Math.floor(index / grid.columns)),
    );
    this.setMode(this.mode);
    this.baker.setWorld(size, layers, this.bake, this.riverBiome, seaTones(this.table));
    this.warmUp();
  }

  /**
   * Pas de l'onde, entier et sans borne (src/render/waves.ts), réduit ici en sa phase ; force
   * de l'onde, de 0 à 1 (0 : pas d'onde, et le programme de la carte seul). Rien ne se recuit.
   */
  setWaves(step: number, force: number): void {
    const strength = Number.isFinite(force) ? Math.min(1, Math.max(0, force)) : 0;
    if (strength !== this.waveForce) {
      this.waveForce = strength;
      this.table = waveTable(this.biomes, strength);
      this.applyWaveTable();
      this.version++;
    }
    this.waveStep = step;
    const width = this.world?.width ?? CHUNK_PX;
    const phase = wavePhase(step, width);
    const shown = this.waveGlobals.uniforms.uWavePhase as Float32Array;
    if (phase.some((value, index) => value !== shown[index])) {
      shown.set(phase);
      this.waveGlobals.update();
    }
  }

  /** L'onde se voyait-elle à la dernière image, la partie visible d'un bloc touchant la mer ? */
  get wavesShown(): boolean {
    return this.seaShown;
  }

  /**
   * Signature de ce que la carte a dessiné à la dernière image, hors caméra et écran : sa
   * version, la saison et le jour, la force de l'onde, et son pas si l'onde se voyait
   * (wavesShown). Le rendu à la demande ne redessine l'image que si elle change
   * (src/render/frameGate.ts).
   */
  signature(): readonly number[] {
    return [
      this.version,
      this.globals.uniforms.uSeason,
      this.globals.uniforms.uDay,
      this.waveForce,
      this.seaShown ? this.waveStep : -1,
    ];
  }

  /** Les uniformes de la table de l'onde, renvoyés au GPU à la prochaine image. */
  private applyWaveTable(): void {
    const { uniforms } = this.waveGlobals;
    uniforms.uWaveCount = this.table.biomes.length;
    uniforms.uWaveTones = this.table.tones;
    uniforms.uWaveCrests = this.table.crests;
    uniforms.uWaveRipples = this.table.ripples;
    this.waveGlobals.update();
  }

  /**
   * Compile le programme de l'onde dès le premier monde, en dessinant un bloc hors de
   * l'écran : PixiJS ne le compilerait qu'à son premier usage, au milieu d'une image.
   */
  private warmUp(): void {
    const chunk = this.chunks.at(0);
    if (this.warmed || chunk === undefined) return;
    this.warmed = true;
    const mesh: ChunkMesh = new Mesh({ geometry: this.geometry, shader: chunk.waveShader });
    const target = RenderTexture.create({ width: 1, height: 1 });
    this.app.renderer.render({ container: mesh, target });
    mesh.destroy();
    target.destroy(true);
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
    this.version++;
  }

  /**
   * Mois courant, continu : 0 au début de janvier, 11,5 à la mi-décembre. Il donne le facteur de
   * saison et le jour continu de l'année, que lisent les calendriers de la neige et de la glace.
   */
  setSeason(month: number): void {
    this.globals.uniforms.uSeason = seasonFactor(month);
    this.globals.uniforms.uDay = month * DAYS_PER_MONTH;
  }

  /** Mode de carte : sa superposition se calcule à la demande. */
  setMode(mode: MapMode): void {
    this.mode = mode;
    this.version++;
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
    const viewport = this.viewport;
    const placements = visibleChunks(camera, viewport, grid, CHUNK_PX);
    // L'onde se voit de près, en mode naturel, à une force non nulle, là où la partie visible
    // d'un bloc touche une tuile de mer : ailleurs, elle ne changerait aucun pixel de l'écran.
    const waves = this.waveForce > 0 && scale >= 1 && this.mode === 'natural';
    let seaShown = false;
    for (const chunk of this.chunks) chunk.mesh.visible = false;
    const shown = new Set<ChunkMesh>();
    const order: { column: number; row: number; distance: number }[] = [];
    const center = { x: viewport.width / 2, y: viewport.height / 2 };
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
      const part = waves ? visiblePart(placement, viewport) : undefined;
      const wavy =
        part !== undefined &&
        seaInRect(chunk.seaMask, CHUNK_PX, part.left, part.top, part.right, part.bottom);
      mesh.shader = wavy ? chunk.waveShader : chunk.shader;
      seaShown ||= wavy;
      mesh.position.set(placement.left / resolution, placement.top / resolution);
      mesh.scale.set(
        placement.width / resolution / CHUNK_PX,
        placement.height / resolution / CHUNK_PX,
      );
    }
    this.releaseCopies(shown);
    this.seaShown = seaShown;
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
    const waveShader = this.waveShaderFor(source, origin);
    const mesh: ChunkMesh = new Mesh({ geometry: this.geometry, shader });
    mesh.visible = false;
    this.layer.addChild(mesh);
    return { pixels, source, shader, waveShader, mesh, baked: false, seaMask: new Uint8Array(0) };
  }

  /** Textures et réglages d'un bloc, communs à ses deux programmes. */
  private resourcesFor(source: BufferImageSource, origin: UniformGroup) {
    return {
      uChunk: source,
      uData: this.data ?? source,
      uCalendars: this.calendars ?? source,
      uPalettes: this.palettes,
      uOverlay: this.overlay ?? source,
      globals: this.globals,
      origin,
    };
  }

  private shaderFor(source: BufferImageSource, origin: UniformGroup): Shader {
    return Shader.from({
      gl: { vertex: MAP_VERTEX, fragment: MAP_FRAGMENT, name: 'pixelciv-map' },
      resources: this.resourcesFor(source, origin),
    });
  }

  /** Le shader de la mer animée : les mêmes ressources, plus le bruit et les réglages de l'onde. */
  private waveShaderFor(source: BufferImageSource, origin: UniformGroup): Shader {
    return Shader.from({
      gl: { vertex: MAP_VERTEX, fragment: MAP_FRAGMENT_WAVES, name: 'pixelciv-map-waves' },
      resources: {
        ...this.resourcesFor(source, origin),
        uWaveNoise: this.waveNoise,
        waves: this.waveGlobals,
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

  private baked(
    column: number,
    row: number,
    pixels: Uint8Array<ArrayBuffer>,
    seaMask: Uint8Array<ArrayBuffer>,
  ): void {
    const grid = this.grid;
    if (grid === undefined) return;
    const chunk = this.chunks.at(row * grid.columns + column);
    if (chunk === undefined) return;
    chunk.pixels.set(pixels);
    chunk.source.update();
    chunk.baked = true;
    chunk.seaMask = seaMask;
    this.version++;
  }
}
