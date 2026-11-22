/**
 * Les humains des planches peints par un shader (tâche 2b.5, ADR 0016 ; REN-09) : l'atlas des
 * rôles, une texture qui garde un rôle par pixel (le rouge, de 0 à 255) ; les palettes des
 * apparences visibles, une texture de PALETTE_ROLES texels par apparence ; et le programme qui
 * lit le rôle d'un pixel du motif puis sa couleur dans la palette de l'individu. Chaque individu
 * est une particule d'un même ParticleContainer : son motif est un cadre de l'atlas des rôles,
 * sa palette se désigne par la teinte de la particule, qui porte le numéro de sa place dans la
 * texture des palettes. Aucune texture recolorée, aucune page, un seul appel de dessin pour tous
 * les humains ; recolorer une apparence, c'est écrire PALETTE_ROLES texels, une fois.
 *
 * Écrit en GLSL ES 1.0, comme le shader des particules de PixiJS, en précision haute : les
 * coordonnées des palettes dépassent ce que la moyenne précision lit sans erreur.
 *
 * Les objets du calque commun (le décor, tâche 2b.6, ADR 0017 ; le gibier ensuite) sont des
 * particules du même conteneur, peintes par le même programme : leurs motifs sont rangés sous
 * ceux des humains dans l'atlas des rôles, leurs palettes dans la même texture. Une palette dit
 * aussi l'alpha de chaque rôle : 0, le rôle ne se peint pas ; entre 0 et 1, un noir translucide
 * (l'ombre « multiply ») ; la sortie est prémultipliée. Le bleu de la couleur d'une particule
 * porte ses drapeaux (OBJECT_FLAG) : avec `ground`, les pixels de l'ombre portée prennent le ton
 * d'ombre de la palette de la case du sol qu'ils couvrent, d'après la texture des saisons de la
 * carte, la neige comprise, tramée comme sur la carte (ADR 0017, § 4 ; C1 D10).
 */
import { BufferImageSource, GlProgram, Matrix, Shader, TextureStyle, UniformGroup } from 'pixi.js';
import { PALETTE_ROLES } from '../core/data/humans';
import { DECOR_LEGEND, legendRole } from '../gen/legend';
import type { HumanPalette } from './humans';
import { BAYER_GLSL, COVER_GLSL, type CoverUniforms } from './mapShader';
import { OBJECT_FLAG, type ObjectPalette } from './objects';

/** Apparences par rangée de la texture des palettes, et sa largeur en texels. */
export const PALETTES_PER_ROW = 8;
export const PALETTE_WIDTH = PALETTES_PER_ROW * PALETTE_ROLES;
/** Rangées au départ ; la texture double quand elle est pleine, jusqu'à MAX_PALETTE_ROWS. */
export const FIRST_PALETTE_ROWS = 16;
export const MAX_PALETTE_ROWS = 2048;

/**
 * Couleur de particule qui désigne la place `slot` de la texture des palettes : son octet bas
 * dans le rouge, son octet haut dans le vert, les drapeaux d'un objet (OBJECT_FLAG) dans le bleu,
 * l'alpha plein. PixiJS la range telle quelle dans l'attribut de couleur (quatre octets non
 * signés, normalisés), que le shader relit.
 */
export function slotColor(slot: number, flags = 0): number {
  return 0xff000000 + (flags & 0xff) * 0x10000 + (slot & 0xffff);
}

/** Place que désigne une couleur de particule (slotColor), comme la relit le shader. */
export function colorSlot(color: number): number {
  return color & 0xffff;
}

/**
 * Le texel de la texture des palettes où se range le rôle `role` de la place `slot` : la
 * colonne et la rangée. PaletteTexture y écrit et y lit, et le shader y lit (PALETTE_ADDRESS).
 */
export function paletteTexel(slot: number, role: number): { column: number; row: number } {
  return {
    column: (slot % PALETTES_PER_ROW) * PALETTE_ROLES + role,
    row: Math.floor(slot / PALETTES_PER_ROW),
  };
}

const glslFloat = (value: number) => value.toFixed(1);

/**
 * L'adressage de la texture des palettes, écrit une seule fois, en expressions GLSL : le shader
 * des humains les assemble (HUMAN_FRAGMENT), et les essais les évaluent hors du GPU
 * (humanShader.test.ts), pour vérifier qu'elles relisent la place de slotColor et lisent le
 * texel de paletteTexel, à tout nombre de rangées. `roleRed` est le rouge du texel de l'atlas
 * des rôles, `vColor` la couleur de la particule, normalisés comme les lit le GPU.
 */
/** Rôles de l'ombre portée des objets (tools/role-grids.ts, withShadow), que lit le shader. */
export const SHADOW_ROLE_RANGE = [
  legendRole(DECOR_LEGEND, 'shadow', 0),
  legendRole(DECOR_LEGEND, 'shadow', 1),
] as const;

export const PALETTE_ADDRESS = {
  role: 'floor(roleRed * 255.0 + 0.5)',
  slot: 'floor(vColor.r * 255.0 + 0.5) + 256.0 * floor(vColor.g * 255.0 + 0.5)',
  column: `mod(slot, ${glslFloat(PALETTES_PER_ROW)}) * ${glslFloat(PALETTE_ROLES)} + role`,
  row: `floor(slot / ${glslFloat(PALETTES_PER_ROW)})`,
  u: `(column + 0.5) / ${glslFloat(PALETTE_WIDTH)}`,
  v: '(row + 0.5) / uPaletteRows',
} as const;

export const HUMAN_VERTEX = /* glsl */ `attribute vec2 aVertex;
attribute vec2 aUV;
attribute vec4 aColor;
attribute vec2 aPosition;

uniform mat3 uTranslationMatrix;
uniform float uRound;
uniform vec2 uResolution;

varying vec2 vUV;
varying vec4 vColor;
varying vec2 vScreen;

vec2 roundPixels(vec2 position, vec2 targetSize) {
  return (floor(((position * 0.5 + 0.5) * targetSize) + 0.5) / targetSize) * 2.0 - 1.0;
}

void main(void) {
  gl_Position = vec4((uTranslationMatrix * vec3(aVertex + aPosition, 1.0)).xy, 0.0, 1.0);
  // Le point de l'écran, en pixels CSS : l'ombre « ground » y lit la case du sol.
  vScreen = aVertex + aPosition;
  if (uRound == 1.0) {
    gl_Position.xy = roundPixels(gl_Position.xy, uResolution);
  }
  vUV = aUV;
  // La couleur de la particule ne teinte rien : elle désigne sa palette (slotColor).
  vColor = aColor;
}
`;

export const HUMAN_FRAGMENT = /* glsl */ `precision highp float;
precision highp sampler2D;

varying vec2 vUV;
varying vec4 vColor;
varying vec2 vScreen;

uniform sampler2D uTexture;
uniform sampler2D uPalettes;
uniform float uPaletteRows;
/**
 * Le sol, pour l'ombre « ground » : la texture des saisons, celle des calendriers de la neige et
 * de la glace (comme la carte, map.ts), et les tons d'ombre des biomes.
 */
uniform sampler2D uGround;
uniform sampler2D uGroundCalendars;
uniform sampler2D uGroundTones;
/** Origine de la carte à l'écran et pixels CSS par pixel de carte ; cases du monde ; biomes. */
uniform vec4 uGroundView;
uniform vec2 uGroundCells;
uniform float uGroundBiomes;
/** cos(2π (mois − 6,5) / 12) et jour continu de l'année, comme pour la carte. */
uniform float uSeason;
uniform float uDay;
/** Rampes des couvertures et part de neige des forêts (data/seasons.json), comme la carte. */
uniform vec3 uSnowRamp;
uniform vec3 uIceRamp;
uniform vec3 uSeaIceRamp;
uniform float uForestSnow;

${BAYER_GLSL}

/** Le ton d'ombre du sol sous le point screen (pixels CSS), neige et glace comprises. */
vec4 groundShadow(vec2 screen) {
  vec2 mapPixel = floor((screen - uGroundView.xy) / uGroundView.z);
  vec2 cell = floor(mapPixel / 4.0);
  if (cell.y < 0.0 || cell.y >= uGroundCells.y) return vec4(0.0);
  cell.x = mod(cell.x, uGroundCells.x);
  vec4 data = texture2D(uGround, (cell + 0.5) / uGroundCells);
  float temperature = ${COVER_GLSL.temperature};
  float amplitude = ${COVER_GLSL.amplitude};
  float flags = ${COVER_GLSL.flags};
  float south = ${COVER_GLSL.south};
  float cover = ${COVER_GLSL.cover};
  float waterCell = ${COVER_GLSL.waterCell};
  float forest = ${COVER_GLSL.forest};
  float biome = floor(data.a * 255.0 + 0.5);
  float monthly = ${COVER_GLSL.monthly};
  float kind = 0.0;
  float keep = 1.0;
  if (waterCell < 0.5 && cover == 1.0) {
    kind = 1.0;
    if (forest > 0.5) keep = uForestSnow;
  } else if (waterCell > 0.5 && cover == 2.0) {
    kind = 2.0;
  } else if (waterCell > 0.5 && cover == 3.0) {
    kind = 3.0;
  }
  float phase = ${COVER_GLSL.phase};
  vec3 ramp = kind < 1.5 ? uSnowRamp : (kind < 2.5 ? uIceRamp : uSeaIceRamp);
  float most = kind > 0.5 ? ${COVER_GLSL.most} : 0.0;
  float coverage = 0.0;
  if (most > 0.0) {
    float row = cell.y + (kind < 1.5 ? 0.5 : uGroundCells.y + 0.5);
    vec2 at = vec2((cell.x + 0.5) / uGroundCells.x, row / (2.0 * uGroundCells.y));
    vec4 calendar = floor(texture2D(uGroundCalendars, at) * 255.0 + 0.5);
    float summer = ${COVER_GLSL.summer};
    float now = ${COVER_GLSL.now};
    float level = ${COVER_GLSL.level};
    coverage = (${COVER_GLSL.share}) * keep;
  }
  vec2 pixel = vec2(mod(mapPixel.x, uGroundCells.x * 4.0), mapPixel.y);
  float tone = coverage > bayer(pixel) ? 1.5 : 0.5;
  return vec4(texture2D(uGroundTones, vec2(tone / 2.0, (biome + 0.5) / uGroundBiomes)).rgb, 1.0);
}

void main(void) {
  float roleRed = texture2D(uTexture, vUV).r;
  float role = ${PALETTE_ADDRESS.role};
  if (role < 0.5) discard;
  float objectFlags = floor(vColor.b * 255.0 + 0.5);
  float ground = mod(floor(objectFlags / ${OBJECT_FLAG.ground.toFixed(1)}), 2.0);
  vec4 tone;
  if (ground > 0.5 && role > ${(SHADOW_ROLE_RANGE[0] - 0.5).toFixed(1)} && role < ${(SHADOW_ROLE_RANGE[1] + 0.5).toFixed(1)}) {
    tone = groundShadow(vScreen);
  } else {
    float slot = ${PALETTE_ADDRESS.slot};
    float column = ${PALETTE_ADDRESS.column};
    float row = ${PALETTE_ADDRESS.row};
    vec2 at = vec2(${PALETTE_ADDRESS.u}, ${PALETTE_ADDRESS.v});
    tone = texture2D(uPalettes, at);
  }
  // Prémultiplié : un rôle sans couleur ne se peint pas ; un noir translucide assombrit.
  if (tone.a < 0.002) discard;
  gl_FragColor = vec4(tone.rgb * tone.a, tone.a);
}
`;

/** Une texture de données, lue au plus proche, sans conversion de l'alpha au chargement. */
function dataSource(pixels: Uint8Array<ArrayBuffer>, width: number, height: number) {
  return new BufferImageSource({
    resource: pixels,
    width,
    height,
    scaleMode: 'nearest',
    alphaMode: 'premultiplied-alpha',
  });
}

/** L'atlas des rôles en texture : le rôle dans le rouge, l'alpha plein où il y a un pixel. */
export function roleSource(roles: Uint8Array, width: number, height: number): BufferImageSource {
  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < roles.length; index++) {
    const role = roles[index] ?? 0;
    if (role === 0) continue;
    pixels[index * 4] = role;
    pixels[index * 4 + 3] = 255;
  }
  return dataSource(pixels, width, height);
}

/**
 * Les palettes des apparences visibles, une place par apparence (lookCode), attribuée à sa
 * première vue et gardée pour le monde : les apparences possibles tiennent toutes dans la
 * texture (MAX_LOOKS, core/data/index.ts), qui double quand elle est pleine. Rien ne se
 * recolore deux fois, et une vue qui en montre beaucoup ne recolore rien à chaque image.
 */
export class PaletteTexture {
  private readonly slots = new Map<number, number>();
  private pixels: Uint8Array<ArrayBuffer>;
  /** Rangées de la texture, et sa source pour le GPU, refaite quand elle double. */
  rows: number;
  source: BufferImageSource;
  private dirty = false;
  /** Sources remplacées, que le shader lit encore jusqu'à ce qu'il suive (followPalettes). */
  private retired: BufferImageSource[] = [];
  /** Palettes écrites depuis la création, pour les essais. */
  written = 0;

  constructor(rows = FIRST_PALETTE_ROWS) {
    this.rows = rows;
    this.pixels = new Uint8Array(PALETTE_WIDTH * rows * 4);
    this.source = dataSource(this.pixels, PALETTE_WIDTH, rows);
  }

  /** Apparences rangées. */
  get count(): number {
    return this.slots.size;
  }

  /** Octets de la texture, en mémoire et sur le GPU. */
  get bytes(): number {
    return this.pixels.byteLength;
  }

  /**
   * La place de l'apparence `look`, rangée à sa première demande d'après `palette()` : les
   * humains (RGB, opaques) et les objets (RGBA, PALETTE_KEYS) partagent la texture.
   */
  slotOf(look: number, palette: () => HumanPalette | ObjectPalette): number {
    const known = this.slots.get(look);
    if (known !== undefined) return known;
    const slot = this.slots.size;
    if (Math.floor(slot / PALETTES_PER_ROW) >= this.rows) this.grow();
    this.slots.set(look, slot);
    this.write(slot, palette());
    return slot;
  }

  private write(slot: number, palette: HumanPalette | ObjectPalette): void {
    const { column, row } = paletteTexel(slot, 0);
    const start = (row * PALETTE_WIDTH + column) * 4;
    for (let role = 0; role < PALETTE_ROLES; role++) {
      const color: readonly number[] | undefined = palette[role];
      const at = start + role * 4;
      this.pixels[at] = color?.[0] ?? 0;
      this.pixels[at + 1] = color?.[1] ?? 0;
      this.pixels[at + 2] = color?.[2] ?? 0;
      // Un ton RGB est opaque ; un ton RGBA dit son alpha.
      this.pixels[at + 3] = color === undefined ? 0 : (color[3] ?? 255);
    }
    this.dirty = true;
    this.written++;
  }

  /** Double la texture, ses palettes gardées ; elle prend une nouvelle source. */
  private grow(): void {
    const rows = this.rows * 2;
    if (rows > MAX_PALETTE_ROWS) throw new RangeError('texture des palettes pleine');
    const pixels = new Uint8Array(PALETTE_WIDTH * rows * 4);
    pixels.set(this.pixels);
    this.retired.push(this.source);
    this.pixels = pixels;
    this.rows = rows;
    this.source = dataSource(pixels, PALETTE_WIDTH, rows);
    this.dirty = true;
  }

  /** Envoie au GPU les palettes écrites depuis la dernière image ; vrai s'il y en avait. */
  flush(): boolean {
    if (!this.dirty) return false;
    this.dirty = false;
    this.source.update();
    return true;
  }

  /** Couleur du rôle `role` de la place `slot`, telle que la lit le shader (essais). */
  colorAt(slot: number, role: number): readonly [number, number, number, number] {
    const { column, row } = paletteTexel(slot, role);
    const at = (row * PALETTE_WIDTH + column) * 4;
    return [
      this.pixels[at] ?? 0,
      this.pixels[at + 1] ?? 0,
      this.pixels[at + 2] ?? 0,
      this.pixels[at + 3] ?? 0,
    ];
  }

  /** Libère les sources remplacées, que le shader ne lit plus. */
  release(): void {
    for (const source of this.retired) source.destroy();
    this.retired = [];
  }

  /** Libère la texture : à faire une fois qu'aucun shader ne la lit plus. */
  destroy(): void {
    this.release();
    this.source.destroy();
    this.slots.clear();
  }
}

/**
 * Le sol que lit l'ombre « ground » : la texture des saisons de la carte et celle de ses
 * calendriers, les tons d'ombre, et les rampes des couvertures (mapShader.ts, coverUniforms).
 */
export interface GroundTextures {
  readonly data: BufferImageSource;
  readonly calendars: BufferImageSource;
  readonly tones: BufferImageSource;
  /** Cases du monde, et nombre de biomes (lignes des tons). */
  readonly columns: number;
  readonly rows: number;
  readonly biomes: number;
  readonly covers: CoverUniforms;
}

/** Une texture d'un texel, en attendant le premier monde : rien n'y couvre le sol. */
export function emptyGround(): GroundTextures {
  const texel = () => dataSource(new Uint8Array(4), 1, 1);
  const none = () => new Float32Array([0, 1, 0]);
  return {
    data: texel(),
    calendars: dataSource(new Uint8Array(8), 1, 2),
    tones: texel(),
    columns: 1,
    rows: 1,
    biomes: 1,
    covers: { snow: none(), ice: none(), seaIce: none(), forest: 1 },
  };
}

/** Réglages du sol : origine de la carte, échelle, monde, saison, couvertures. */
type GroundGroup = UniformGroup<{
  uGroundView: { value: Float32Array; type: 'vec4<f32>' };
  uGroundCells: { value: Float32Array; type: 'vec2<f32>' };
  uGroundBiomes: { value: number; type: 'f32' };
  uSeason: { value: number; type: 'f32' };
  uDay: { value: number; type: 'f32' };
  uSnowRamp: { value: Float32Array; type: 'vec3<f32>' };
  uIceRamp: { value: Float32Array; type: 'vec3<f32>' };
  uSeaIceRamp: { value: Float32Array; type: 'vec3<f32>' };
  uForestSnow: { value: number; type: 'f32' };
}>;

/** Le shader des humains, sur l'atlas des rôles `roles` et les palettes `palettes`. */
export function humanShader(
  roles: BufferImageSource,
  palettes: PaletteTexture,
  ground: GroundTextures = emptyGround(),
): Shader {
  return new Shader({
    glProgram: GlProgram.from({
      vertex: HUMAN_VERTEX,
      fragment: HUMAN_FRAGMENT,
      name: 'pixelciv-humans',
    }),
    resources: {
      // PixiJS y met la texture et les réglages du ParticleContainer.
      uTexture: roles,
      uSampler: new TextureStyle({ scaleMode: 'nearest' }),
      uniforms: {
        uTranslationMatrix: { value: new Matrix(), type: 'mat3x3<f32>' },
        uColor: { value: new Float32Array(4), type: 'vec4<f32>' },
        uRound: { value: 1, type: 'f32' },
        uResolution: { value: [0, 0], type: 'vec2<f32>' },
      },
      uPalettes: palettes.source,
      humans: new UniformGroup({ uPaletteRows: { value: palettes.rows, type: 'f32' } }),
      uGround: ground.data,
      uGroundCalendars: ground.calendars,
      uGroundTones: ground.tones,
      ground: new UniformGroup({
        uGroundView: { value: new Float32Array(4), type: 'vec4<f32>' },
        uGroundCells: { value: new Float32Array([ground.columns, ground.rows]), type: 'vec2<f32>' },
        uGroundBiomes: { value: ground.biomes, type: 'f32' },
        uSeason: { value: 0, type: 'f32' },
        uDay: { value: 0, type: 'f32' },
        uSnowRamp: { value: new Float32Array(ground.covers.snow), type: 'vec3<f32>' },
        uIceRamp: { value: new Float32Array(ground.covers.ice), type: 'vec3<f32>' },
        uSeaIceRamp: { value: new Float32Array(ground.covers.seaIce), type: 'vec3<f32>' },
        uForestSnow: { value: ground.covers.forest, type: 'f32' },
      }),
    },
  });
}

/** L'instant que montre le sol : la position de la carte, son échelle, la saison et le jour. */
export interface GroundView {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly season: number;
  readonly day: number;
}

/**
 * Le shader suit le sol : les textures et les rampes d'un monde nouveau, puis, à chaque image
 * refaite, l'origine de la carte et l'échelle (en pixels CSS), la saison et le jour.
 */
export function followGround(shader: Shader, ground: GroundTextures, view: GroundView): void {
  const resources = shader.resources as {
    uGround: BufferImageSource;
    uGroundCalendars: BufferImageSource;
    uGroundTones: BufferImageSource;
    ground: GroundGroup;
  };
  if (resources.uGround !== ground.data) shader.resources.uGround = ground.data;
  if (resources.uGroundCalendars !== ground.calendars) {
    shader.resources.uGroundCalendars = ground.calendars;
  }
  if (resources.uGroundTones !== ground.tones) shader.resources.uGroundTones = ground.tones;
  const uniforms = resources.ground.uniforms;
  const shown = uniforms.uGroundView;
  const cells = uniforms.uGroundCells;
  const { covers } = ground;
  const same = (a: Float32Array, b: Float32Array) => a.every((value, index) => value === b[index]);
  const changed =
    shown[0] !== Math.fround(view.x) ||
    shown[1] !== Math.fround(view.y) ||
    shown[2] !== Math.fround(view.scale) ||
    cells[0] !== ground.columns ||
    cells[1] !== ground.rows ||
    uniforms.uGroundBiomes !== ground.biomes ||
    uniforms.uSeason !== Math.fround(view.season) ||
    uniforms.uDay !== Math.fround(view.day) ||
    !same(uniforms.uSnowRamp, covers.snow) ||
    !same(uniforms.uIceRamp, covers.ice) ||
    !same(uniforms.uSeaIceRamp, covers.seaIce) ||
    uniforms.uForestSnow !== Math.fround(covers.forest);
  if (!changed) return;
  shown.set([view.x, view.y, view.scale, 0]);
  cells.set([ground.columns, ground.rows]);
  uniforms.uGroundBiomes = ground.biomes;
  uniforms.uSeason = Math.fround(view.season);
  uniforms.uDay = Math.fround(view.day);
  uniforms.uSnowRamp.set(covers.snow);
  uniforms.uIceRamp.set(covers.ice);
  uniforms.uSeaIceRamp.set(covers.seaIce);
  uniforms.uForestSnow = Math.fround(covers.forest);
  resources.ground.update();
}

/**
 * Le shader suit la texture des palettes quand elle double ou change : il lit la nouvelle
 * source, à son nombre de rangées, puis les sources qu'il ne lit plus se libèrent.
 */
export function followPalettes(shader: Shader, palettes: PaletteTexture): void {
  const resources = shader.resources as {
    uPalettes: BufferImageSource;
    humans: UniformGroup<{ uPaletteRows: { value: number; type: 'f32' } }>;
  };
  if (resources.uPalettes !== palettes.source) shader.resources.uPalettes = palettes.source;
  if (resources.humans.uniforms.uPaletteRows !== palettes.rows) {
    resources.humans.uniforms.uPaletteRows = palettes.rows;
    resources.humans.update();
  }
  palettes.release();
}
