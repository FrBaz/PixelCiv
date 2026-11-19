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
 */
import { BufferImageSource, GlProgram, Matrix, Shader, TextureStyle, UniformGroup } from 'pixi.js';
import { PALETTE_ROLES } from '../core/data/humans';
import type { HumanPalette } from './humans';

/** Apparences par rangée de la texture des palettes, et sa largeur en texels. */
export const PALETTES_PER_ROW = 8;
export const PALETTE_WIDTH = PALETTES_PER_ROW * PALETTE_ROLES;
/** Rangées au départ ; la texture double quand elle est pleine, jusqu'à MAX_PALETTE_ROWS. */
export const FIRST_PALETTE_ROWS = 16;
export const MAX_PALETTE_ROWS = 2048;

/**
 * Couleur de particule qui désigne la place `slot` de la texture des palettes : son octet bas
 * dans le rouge, son octet haut dans le vert, l'alpha plein. PixiJS la range telle quelle dans
 * l'attribut de couleur (quatre octets non signés, normalisés), que le shader relit.
 */
export function slotColor(slot: number): number {
  return 0xff000000 + (slot & 0xffff);
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

vec2 roundPixels(vec2 position, vec2 targetSize) {
  return (floor(((position * 0.5 + 0.5) * targetSize) + 0.5) / targetSize) * 2.0 - 1.0;
}

void main(void) {
  gl_Position = vec4((uTranslationMatrix * vec3(aVertex + aPosition, 1.0)).xy, 0.0, 1.0);
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

uniform sampler2D uTexture;
uniform sampler2D uPalettes;
uniform float uPaletteRows;

void main(void) {
  float roleRed = texture2D(uTexture, vUV).r;
  float role = ${PALETTE_ADDRESS.role};
  if (role < 0.5) discard;
  float slot = ${PALETTE_ADDRESS.slot};
  float column = ${PALETTE_ADDRESS.column};
  float row = ${PALETTE_ADDRESS.row};
  vec2 at = vec2(${PALETTE_ADDRESS.u}, ${PALETTE_ADDRESS.v});
  gl_FragColor = vec4(texture2D(uPalettes, at).rgb, 1.0);
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

  /** La place de l'apparence `look`, rangée à sa première demande d'après `palette()`. */
  slotOf(look: number, palette: () => HumanPalette): number {
    const known = this.slots.get(look);
    if (known !== undefined) return known;
    const slot = this.slots.size;
    if (Math.floor(slot / PALETTES_PER_ROW) >= this.rows) this.grow();
    this.slots.set(look, slot);
    this.write(slot, palette());
    return slot;
  }

  private write(slot: number, palette: HumanPalette): void {
    const { column, row } = paletteTexel(slot, 0);
    const start = (row * PALETTE_WIDTH + column) * 4;
    for (let role = 0; role < PALETTE_ROLES; role++) {
      const color = palette[role];
      const at = start + role * 4;
      this.pixels[at] = color?.[0] ?? 0;
      this.pixels[at + 1] = color?.[1] ?? 0;
      this.pixels[at + 2] = color?.[2] ?? 0;
      this.pixels[at + 3] = color === undefined ? 0 : 255;
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

/** Le shader des humains, sur l'atlas des rôles `roles` et les palettes `palettes`. */
export function humanShader(roles: BufferImageSource, palettes: PaletteTexture): Shader {
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
    },
  });
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
