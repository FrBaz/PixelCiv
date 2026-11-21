/**
 * Mer animée (tâche 2b.4 ; REN-10 ; ADR 0015) : la source unique du motif. Ses constantes,
 * sa texture de bruit, la réduction de sa phase, la table des tons et des seuils tirée de
 * data/biomes.json, le code GLSL que le shader de la carte y ajoute (src/render/mapShader.ts),
 * et le miroir TypeScript de ce code, qui décide comme lui de chaque pixel.
 *
 * Le motif ne dépend que du pixel du monde (x modulo la largeur, y) et du pas de l'onde, un
 * entier : il ignore les blocs, le zoom et la couture. Tout s'y décide en entiers et en
 * comparaisons, exacts en flottant, sauf le calme du gel, que le miroir calcule en flottants
 * de 32 bits, opération par opération, comme le shader.
 *
 * - Crêtes : un cadre glisse d'un pixel vers l'est et d'un vers le nord à chaque pas ; chaque
 *   bloc de WAVE_BLOCK pixels du cadre porte au plus une crête « \ », qui naît, grandit,
 *   décroît et s'éteint en CREST_LIFE pas sur CREST_CYCLE.
 * - Clapots : sur une grille fixe de blocs du monde, deux pixels sombres en « / », puis un
 *   seul, RIPPLE_LIFE pas sur RIPPLE_CYCLE.
 * - Tons : la crête éclaircit le pixel jusqu'au ton de crête de son biome, le clapot
 *   l'assombrit jusqu'à l'ombre, jamais l'inverse ; seuls des tons cuits de la palette du
 *   biome, que le shader reconnaît à la couleur cuite du pixel.
 * - Gel : sur les `calmDays` jours (data/seasons.json) qui précèdent la glace de la case, et sur
 *   ceux qui suivent son départ, d'après son calendrier (src/core/snow.ts ; ADR 0019, § 1), une
 *   part croissante, tramée, cesse de bouger ; tant que la glace tient, toute la case est
 *   immobile. Une mer qui ne gèle jamais bouge toute l'année.
 */
import type { Biome, Seasons } from '../core/data/schemas';
import { COLDEST_PHASE, DAYS_PER_UNIT, warmestDay, YEAR_DAYS } from '../core/snow';
import { bakedWaterTone, CREST_START, MAX_WAVE_BIOMES, WAVE_BLOCK } from '../core/waves';
import { glslFloat } from './glsl';

export { CREST_START, MAX_WAVE_BIOMES, WAVE_BLOCK } from '../core/waves';

/** Durée d'un pas de l'onde, en millisecondes de temps réel. */
export const WAVE_STEP_MS = 250;
/** Cycle d'une crête, et sa vie, en pas : elle s'éteint pendant les quatre derniers. */
export const CREST_CYCLE = 16;
export const CREST_LIFE = 12;
/** Cycle d'un clapot, et sa vie, en pas. */
export const RIPPLE_CYCLE = 64;
export const RIPPLE_LIFE = 2;
/** Place d'un clapot dans son bloc : x < RIPPLE_SPAN, 1 ≤ y ≤ RIPPLE_SPAN ; ses deux pixels y tiennent. */
export const RIPPLE_SPAN = 15;
/** Côté de la texture de bruit, en texels : un octet par bloc et par usage. */
export const WAVE_NOISE = 512;
/** Sel du hachage du bruit, et rangées où les crêtes et les clapots lisent le leur. */
export const WAVE_SALT = 77;
export const CREST_ROW = 128;
export const RIPPLE_ROW = 320;
/** Période du cadre des crêtes en y, en pixels : le bruit y boucle tous les WAVE_NOISE blocs. */
export const WAVE_PERIOD_Y = WAVE_BLOCK * WAVE_NOISE;

/** Reste positif de la division entière. */
const modulo = (value: number, divisor: number) => ((value % divisor) + divisor) % divisor;

/**
 * Phase de l'onde au pas `step` (entier, sans borne), réduite côté processeur pour que le
 * shader ne reçoive que de petits entiers, exacts en flottant : décalage du cadre en x,
 * modulo la largeur du monde en pixels, et en y, modulo WAVE_PERIOD_Y ; phases des crêtes et
 * des clapots. Le motif entier revient au bout de ppcm(largeur, WAVE_PERIOD_Y) pas.
 */
export function wavePhase(
  step: number,
  worldPx: number,
): readonly [number, number, number, number] {
  return [
    modulo(step, worldPx),
    modulo(step, WAVE_PERIOD_Y),
    modulo(step, CREST_CYCLE),
    modulo(step, RIPPLE_CYCLE),
  ];
}

/** Hachage entier d'un texel, dans [0, 2^32) : celui de la cuisson (src/render/bake.ts). */
function hash(x: number, y: number, salt: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(salt, 1013904223);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Bruit fixe de l'onde : quatre octets indépendants par texel, WAVE_NOISE × WAVE_NOISE texels. */
export function waveNoise(): Uint8Array<ArrayBuffer> {
  const texels = new Uint8Array(WAVE_NOISE * WAVE_NOISE * 4);
  for (let y = 0; y < WAVE_NOISE; y++) {
    for (let x = 0; x < WAVE_NOISE; x++) {
      const h = hash(x, y, WAVE_SALT);
      const offset = (y * WAVE_NOISE + x) * 4;
      texels[offset] = h & 255;
      texels[offset + 1] = (h >>> 8) & 255;
      texels[offset + 2] = (h >>> 16) & 255;
      texels[offset + 3] = (h >>> 24) & 255;
    }
  }
  return texels;
}

/** Ce que la table retient d'un biome animé. */
export interface WaveBiome {
  readonly id: string;
  /** Ombre, base et lumière, tels que la cuisson les écrit (bakedWaterTone). */
  readonly tones: readonly [number, number, number];
  /** Seuils sur 256 : un bloc porte une crête, un clapot, si son octet est en dessous. */
  readonly crestThreshold: number;
  readonly rippleThreshold: number;
  readonly length: number;
  readonly thickness: number;
  /** Ton de la crête : 1 la base, 2 la lumière. */
  readonly crestTone: number;
}

/** Table de l'onde : les biomes animés, et les uniformes du shader qui en découlent. */
export interface WaveTable {
  readonly biomes: readonly WaveBiome[];
  /** Trois tons par biome, en octets (rouge, vert, bleu), MAX_WAVE_BIOMES places. */
  readonly tones: Float32Array<ArrayBuffer>;
  /** Crêtes de chaque biome : seuil, longueur, épaisseur, ton. */
  readonly crests: Float32Array<ArrayBuffer>;
  /** Clapots de chaque biome : seuil, puis trois places libres. */
  readonly ripples: Float32Array<ArrayBuffer>;
}

/**
 * Table des biomes animés de `biomes` (ceux qui ont une entrée `waves`), à la force `force`,
 * de 0 à 1, qui multiplie leurs parts : sous 1, des crêtes et des clapots disparaissent, sans
 * qu'aucun n'apparaisse ailleurs. Lève une erreur si le ton cuit d'une eau animée se retrouve
 * dans une autre eau, ce que le schéma des données refuse déjà.
 */
export function waveTable(biomes: readonly Biome[], force: number): WaveTable {
  const owners = new Map<number, Biome>();
  for (const biome of biomes) {
    if (biome.family !== 'water') continue;
    const { shadow, base, light } = biome.palette;
    for (const tone of new Set([shadow, base, light].map(bakedWaterTone))) {
      const owner = owners.get(tone);
      if (owner !== undefined && (owner.waves !== undefined || biome.waves !== undefined)) {
        throw new Error(
          `${owner.id} et ${biome.id} partagent un ton cuit : la mer animée les confondrait`,
        );
      }
      owners.set(tone, biome);
    }
  }
  const strength = Math.min(1, Math.max(0, force));
  const threshold = (share: number) => Math.round(256 * share * strength);
  const animated = biomes.flatMap((biome): WaveBiome[] => {
    const { waves } = biome;
    if (waves === undefined) return [];
    const { shadow, base, light } = biome.palette;
    return [
      {
        id: biome.id,
        tones: [bakedWaterTone(shadow), bakedWaterTone(base), bakedWaterTone(light)],
        crestThreshold: threshold(waves.crest.share),
        rippleThreshold: threshold(waves.ripple.share),
        length: waves.crest.length,
        thickness: waves.crest.thickness,
        crestTone: waves.crest.tone === 'light' ? 2 : 1,
      },
    ];
  });
  if (animated.length > MAX_WAVE_BIOMES) {
    throw new Error(`${String(animated.length)} biomes animés, ${String(MAX_WAVE_BIOMES)} au plus`);
  }
  const tones = new Float32Array(MAX_WAVE_BIOMES * 9);
  const crests = new Float32Array(MAX_WAVE_BIOMES * 4);
  const ripples = new Float32Array(MAX_WAVE_BIOMES * 4);
  animated.forEach((biome, index) => {
    biome.tones.forEach((tone, rank) => {
      tones.set([tone >>> 16, (tone >>> 8) & 255, tone & 255], (index * 3 + rank) * 3);
    });
    crests.set([biome.crestThreshold, biome.length, biome.thickness, biome.crestTone], index * 4);
    ripples[index * 4] = biome.rippleThreshold;
  });
  return { biomes: animated, tones, crests, ripples };
}

/** Tons cuits des biomes animés : un pixel d'eau de l'un d'eux peut bouger. */
export function seaTones(table: WaveTable): number[] {
  return table.biomes.flatMap((biome) => biome.tones);
}

/** Côté d'une tuile du masque de la mer d'un bloc cuit, en pixels de carte. */
export const SEA_TILE = 16;

/**
 * Masque de la mer animée d'un bloc cuit `pixels` (RGBA), de `size` pixels de côté : un octet
 * par tuile de SEA_TILE pixels, ligne par ligne, à 1 si la tuile a un pixel d'eau aux tons de
 * `tones`. L'onde ne change rien hors de ces tuiles : la carte dessine sans elle un bloc dont
 * la partie visible n'en touche aucune (src/render/map.ts).
 */
export function seaMask(
  pixels: Uint8Array,
  tones: readonly number[],
  size: number,
): Uint8Array<ArrayBuffer> {
  const tiles = Math.ceil(size / SEA_TILE);
  const mask = new Uint8Array(tiles * tiles);
  const wanted = new Set(tones);
  for (let y = 0; y < size; y++) {
    const row = Math.floor(y / SEA_TILE) * tiles;
    for (let x = 0; x < size; x++) {
      const tile = row + Math.floor(x / SEA_TILE);
      if (mask[tile] === 1) continue;
      const offset = (y * size + x) * 4;
      const red = pixels[offset] ?? 1;
      if ((red & 1) === 1) continue;
      const tone = (red << 16) | ((pixels[offset + 1] ?? 0) << 8) | (pixels[offset + 2] ?? 0);
      if (wanted.has(tone)) mask[tile] = 1;
    }
  }
  return mask;
}

/**
 * Le masque `mask` d'un bloc de `size` pixels de côté (seaMask) a-t-il une tuile de mer qui
 * touche le rectangle [left, right[ × [top, bottom[, en pixels du bloc ?
 */
export function seaInRect(
  mask: Uint8Array,
  size: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): boolean {
  if (right <= left || bottom <= top) return false;
  const tiles = Math.ceil(size / SEA_TILE);
  const tile = (pixel: number) => Math.min(tiles - 1, Math.max(0, Math.floor(pixel / SEA_TILE)));
  const [first, last] = [tile(left), tile(right - 1)];
  for (let row = tile(top); row <= tile(bottom - 1); row++) {
    for (let column = first; column <= last; column++) {
      if (mask[row * tiles + column] === 1) return true;
    }
  }
  return false;
}

// ————————————————————————————————————————————————————————————————————————————————
// Le code GLSL, inséré dans le shader de la carte (MAP_FRAGMENT_WAVES).

const f = glslFloat;
const BLOCK = f(WAVE_BLOCK);
const NOISE = f(WAVE_NOISE);

/**
 * Calme du gel, en GLSL, d'après les variables de la couverture du pixel (mapShader.ts,
 * COVER_GLSL : phase, now, calendar) : entier tant que la rampe couvre, ou dans l'intervalle du
 * calendrier, de son début à sa fin (au moins jusqu'au jour le plus froid, où la montée est
 * pleine) ; décroissant sur `uCalmDays` jours de part et d'autre, l'année bouclée.
 */
const CALM_START = `calendar.x * ${f(DAYS_PER_UNIT)}`;
const CALM_END = `max(calendar.y * ${f(DAYS_PER_UNIT)}, ${f(COLDEST_PHASE)})`;
export const CALM_GLSL = {
  distance: `phase < ${CALM_START} ? min(${CALM_START} - phase, phase + ${f(YEAR_DAYS)} - ${CALM_END}) : (phase > ${CALM_END} ? min(phase - ${CALM_END}, ${CALM_START} + ${f(YEAR_DAYS)} - phase) : 0.0)`,
  calm: 'now > 0.0 ? 1.0 : clamp(1.0 - distance / uCalmDays, 0.0, 1.0)',
} as const;

/**
 * Le code de l'onde : `header`, ses uniformes et ses fonctions, avant main() ; `main`, la
 * décision du pixel, après la couverture et avant les modes de carte. Toute recoloration de
 * saison à venir (lumière de saison, tâche 2b.7) vient après l'onde, et traite sa sortie comme
 * un pixel cuit : c'est un ton cuit du même biome.
 */
export const WAVE_GLSL = {
  header: /* glsl */ `// Mer animée (tâche 2b.4, ADR 0015) : écrit par src/render/waves.ts, qui en tient le miroir.
uniform sampler2D uWaveNoise;
/** Phase de l'onde, réduite côté processeur : décalage du cadre en x (modulo la largeur du
 * monde en pixels) et en y (modulo ${String(WAVE_PERIOD_Y)}), phases des crêtes (modulo ${String(CREST_CYCLE)}) et des clapots (modulo ${String(RIPPLE_CYCLE)}). */
uniform vec4 uWavePhase;
/** Largeur du monde, en pixels de carte ; nombre de biomes animés. */
uniform float uWorldPx;
uniform float uWaveCount;
/** Ombre, base et lumière de chaque biome animé, en octets ; ses crêtes (seuil, longueur,
 * épaisseur, ton) ; ses clapots (seuil). */
uniform vec3 uWaveTones[${String(MAX_WAVE_BIOMES * 3)}];
uniform vec4 uWaveCrests[${String(MAX_WAVE_BIOMES)}];
uniform vec4 uWaveRipples[${String(MAX_WAVE_BIOMES)}];
/** Jours où la mer se calme avant la glace, et après elle (data/seasons.json). */
uniform float uCalmDays;

/** x modulo m, pour des entiers positifs, exact même quand m n'est pas une puissance de deux. */
float imod(float x, float m) {
  return x - m * floor((x + 0.5) / m);
}

/** Octets du bruit au texel entier t, bouclé sur ${String(WAVE_NOISE)}. */
vec4 waveNoise(vec2 t) {
  return floor(texture(uWaveNoise, (mod(t, ${NOISE}) + 0.5) / ${NOISE}) * 255.0 + 0.5);
}

/** Le pixel l de son bloc est-il sur la crête partie de start, de longueur len, qui descend
 * du nord-ouest au sud-est ? La seconde ligne d'une crête épaisse court un pixel à l'est. */
bool onCrest(vec2 l, vec2 start, float len, float thickness) {
  float d = l.x - start.x;
  float dy = l.y - start.y;
  if (dy == d && d >= 0.0 && d < len) return true;
  float east = d - 1.0;
  return thickness > 1.5 && dy == east && east >= 0.0 && east < len;
}

/** Crête du biome de réglages c au pixel du monde p : une au plus par bloc du cadre qui
 * glisse ; elle vit ${String(CREST_LIFE)} pas sur ${String(CREST_CYCLE)}, grandit puis décroît. */
bool crest(vec2 p, vec4 c) {
  vec2 q = vec2(imod(p.x - uWavePhase.x + uWorldPx, uWorldPx), p.y + uWavePhase.y);
  vec2 b = floor(q / ${BLOCK});
  vec2 l = q - ${BLOCK} * b;
  vec4 h = waveNoise(vec2(b.x, b.y + ${f(CREST_ROW)}));
  if (h.r >= c.x) return false;
  float tau = imod(uWavePhase.z + floor(h.g / ${f(256 / CREST_CYCLE)}), ${f(CREST_CYCLE)});
  if (tau >= ${f(CREST_LIFE)}) return false;
  float len = min(min(c.y, tau + 1.0), ${f(CREST_LIFE)} - tau);
  vec2 start = floor(vec2(h.b * ${f(CREST_START.x)}, h.a * ${f(CREST_START.y)}) / 256.0);
  return onCrest(l, start, len, c.z);
}

/** Clapot du biome de seuil r.x au pixel du monde p, sur la grille fixe des blocs : deux
 * pixels en « / » au premier pas, un au second, ${String(RIPPLE_LIFE)} pas sur ${String(RIPPLE_CYCLE)}. */
bool ripple(vec2 p, vec4 r) {
  vec2 b = floor(p / ${BLOCK});
  vec2 l = p - ${BLOCK} * b;
  vec4 h = waveNoise(vec2(b.x, b.y + ${f(RIPPLE_ROW)}));
  if (h.r >= r.x) return false;
  float tau = imod(uWavePhase.w + floor(h.g / ${f(256 / RIPPLE_CYCLE)}), ${f(RIPPLE_CYCLE)});
  if (tau >= ${f(RIPPLE_LIFE)}) return false;
  vec2 at = vec2(floor(h.b * ${f(RIPPLE_SPAN)} / 256.0), 1.0 + floor(h.a * ${f(RIPPLE_SPAN)} / 256.0));
  if (l == at) return true;
  return tau < 0.5 && l == at + vec2(1.0, -1.0);
}

/** Couleur du pixel d'eau libre de couleur cuite baked, au pixel du monde p : le biome se
 * reconnaît à son ton ; la crête l'éclaircit, sinon le clapot l'assombrit. */
vec3 waveColor(vec3 baked, vec2 p, vec3 color) {
  vec3 bytes = floor(baked * 255.0 + 0.5);
  vec3 result = color;
  for (int i = 0; i < ${String(MAX_WAVE_BIOMES)}; i++) {
    if (float(i) >= uWaveCount) break;
    vec3 shadow = uWaveTones[i * 3];
    vec3 base = uWaveTones[i * 3 + 1];
    vec3 light = uWaveTones[i * 3 + 2];
    float tone = bytes == shadow ? 0.0 : (bytes == base ? 1.0 : (bytes == light ? 2.0 : -1.0));
    if (tone < 0.0) continue;
    vec4 c = uWaveCrests[i];
    float next = tone;
    if (crest(p, c)) next = max(tone, c.w);
    else if (ripple(p, uWaveRipples[i])) next = 0.0;
    if (next != tone) result = (next < 0.5 ? shadow : (next < 1.5 ? base : light)) / 255.0;
    break;
  }
  return result;
}

`,
  main: /* glsl */ `  // Mer animée (tâche 2b.4, ADR 0015), de près et en mode naturel, sur un pixel d'eau libre :
  // ni terre, ni ruisseau, ni couvert. Le gel la calme avant la glace, d'après le calendrier de la
  // glace qui s'applique au pixel : celle des rivières dans une case de terre ou de lac, la
  // banquise dans la mer côtière (ADR 0019, § 1). Une recoloration de saison viendrait après.
  float waveDither = bayer(dither);
  if (uFine > 0.5 && uMode < 0.5 && land < 0.5 && stream < 0.5 && coverage <= waveDither) {
    float calm = 0.0;
    if (kind > 1.5 && most > 0.0) {
      float distance = ${CALM_GLSL.distance};
      calm = ${CALM_GLSL.calm};
    }
    if (calm < waveDither) color = waveColor(texel.rgb, dither, color);
  }

`,
} as const;

// ————————————————————————————————————————————————————————————————————————————————
// Le miroir : la décision du shader pour un pixel, en TypeScript.

/** Octets du bruit au texel (column, row), bouclé. */
function noiseAt(noise: Uint8Array, column: number, row: number): number {
  return ((modulo(row, WAVE_NOISE) * WAVE_NOISE + modulo(column, WAVE_NOISE)) * 4) >>> 0;
}

/** Ce que voit le miroir : la table, le bruit, la phase et la largeur du monde. */
export interface WaveFrame {
  readonly table: WaveTable;
  readonly noise: Uint8Array;
  readonly phase: readonly [number, number, number, number];
  /** Largeur du monde, en pixels de carte. */
  readonly worldPx: number;
}

/**
 * Le pixel du monde (x, y), x dans [0, worldPx[, est-il sur une crête de réglages `biome` ?
 * Une crête au plus par bloc du cadre, qui ne sort jamais de son bloc.
 */
export function crestAt(frame: WaveFrame, biome: WaveBiome, x: number, y: number): boolean {
  const [phaseX, phaseY, phaseCrest] = frame.phase;
  const qx = modulo(x - phaseX, frame.worldPx);
  const qy = y + phaseY;
  const bx = Math.floor(qx / WAVE_BLOCK);
  const by = Math.floor(qy / WAVE_BLOCK);
  const at = noiseAt(frame.noise, bx, by + CREST_ROW);
  const noise = frame.noise;
  if ((noise[at] ?? 0) >= biome.crestThreshold) return false;
  const tau = modulo(
    phaseCrest + Math.floor((noise[at + 1] ?? 0) / (256 / CREST_CYCLE)),
    CREST_CYCLE,
  );
  if (tau >= CREST_LIFE) return false;
  const length = Math.min(biome.length, tau + 1, CREST_LIFE - tau);
  const startX = Math.floor(((noise[at + 2] ?? 0) * CREST_START.x) / 256);
  const startY = Math.floor(((noise[at + 3] ?? 0) * CREST_START.y) / 256);
  const d = qx - WAVE_BLOCK * bx - startX;
  const dy = qy - WAVE_BLOCK * by - startY;
  if (dy === d && d >= 0 && d < length) return true;
  const east = d - 1;
  return biome.thickness > 1 && dy === east && east >= 0 && east < length;
}

/** Le pixel du monde (x, y) porte-t-il un clapot de réglages `biome` ? */
export function rippleAt(frame: WaveFrame, biome: WaveBiome, x: number, y: number): boolean {
  // Le shader lit le pixel du monde, x dans [0, largeur[ : la grille se raccorde à la couture.
  x = modulo(x, frame.worldPx);
  const bx = Math.floor(x / WAVE_BLOCK);
  const by = Math.floor(y / WAVE_BLOCK);
  const at = noiseAt(frame.noise, bx, by + RIPPLE_ROW);
  const noise = frame.noise;
  if ((noise[at] ?? 0) >= biome.rippleThreshold) return false;
  const tau = modulo(
    frame.phase[3] + Math.floor((noise[at + 1] ?? 0) / (256 / RIPPLE_CYCLE)),
    RIPPLE_CYCLE,
  );
  if (tau >= RIPPLE_LIFE) return false;
  const rx = Math.floor(((noise[at + 2] ?? 0) * RIPPLE_SPAN) / 256);
  const ry = 1 + Math.floor(((noise[at + 3] ?? 0) * RIPPLE_SPAN) / 256);
  const lx = x - WAVE_BLOCK * bx;
  const ly = y - WAVE_BLOCK * by;
  if (lx === rx && ly === ry) return true;
  return tau === 0 && lx === rx + 1 && ly === ry - 1;
}

const f32 = Math.fround;

/** Octet d'une texture normalisée, tel que le shader le lit puis le multiplie par 255. */
function unormBytes(byte: number): number {
  return f32(f32(byte / 255) * 255);
}

/** Ce que le miroir lit d'un pixel : sa couleur cuite, le texel de sa case et son calendrier. */
export interface WavePixel {
  /** Rouge, vert et bleu cuits. */
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  /** Texel de la case dans la texture des saisons (src/render/seasons.ts) : R, G et B. */
  readonly temperature: number;
  readonly amplitude: number;
  readonly flags: number;
  /** Les quatre octets du calendrier de la glace de la case (src/core/snow.ts). */
  readonly calendar: ArrayLike<number>;
}

/**
 * Température du mois de la case d'un pixel, en flottants de 32 bits, opération par opération
 * comme le shader ; `season` est l'uniforme uSeason, tel que le shader le reçoit (Math.fround
 * de seasonFactor).
 */
export function monthly32(pixel: WavePixel, season: number): number {
  const temperature = f32(f32(unormBytes(pixel.temperature) / 2) - 64);
  const amplitude = f32(unormBytes(pixel.amplitude) / 8);
  const sign = (pixel.flags & 1) === 1 ? -1 : 1;
  return f32(temperature + f32(f32(amplitude * season) * sign));
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Une rampe telle que le shader la reçoit, en flottants de 32 bits : début, étendue, part pleine. */
export type Ramp32 = readonly [number, number, number];

/** Les uniformes de la couverture de l'eau, tels que le shader les reçoit (coverUniforms). */
export interface WaveCovers {
  readonly ice: Ramp32;
  readonly seaIce: Ramp32;
  readonly calmDays: number;
}

/** Les uniformes de la couverture de l'eau, tirés de data/seasons.json. */
export function waveCovers(seasons: Seasons): WaveCovers {
  const ramp = ({ onset, span, full }: Seasons['freshIce']['ramp']): Ramp32 => [
    f32(onset),
    f32(span),
    f32(full),
  ];
  return {
    ice: ramp(seasons.freshIce.ramp),
    seaIce: ramp(seasons.seaIce.ramp),
    calmDays: f32(seasons.calmDays),
  };
}

/** Part d'une rampe à la température `celsius`, en flottants de 32 bits, comme le shader. */
export function ramp32(ramp: Ramp32, celsius: number): number {
  return f32(clamp01(f32(f32(ramp[0] - celsius) / ramp[1])) * ramp[2]);
}

/** Ce que le shader calcule de la couverture de l'eau d'un pixel (mapShader.ts, COVER_GLSL). */
export interface WaterCover {
  /** La rampe couvre-t-elle jamais la case, et au jour ? */
  readonly most: number;
  readonly now: number;
  /** Jour de phase, part couverte, et calme du gel (0 bouge, 1 immobile). */
  readonly phase: number;
  readonly coverage: number;
  readonly calm: number;
}

/**
 * La couverture de l'eau d'un pixel de rampe `ramp`, au facteur de saison `season` et au jour
 * `day` (les uniformes uSeason et uDay), en flottants de 32 bits, opération par opération comme
 * le shader : COVER_GLSL (most, summer, now, level, share) puis CALM_GLSL.
 */
export function waterCover32(
  pixel: WavePixel,
  ramp: Ramp32,
  season: number,
  day: number,
  calmDays: number,
): WaterCover {
  const temperature = f32(f32(unormBytes(pixel.temperature) / 2) - 64);
  const amplitude = f32(unormBytes(pixel.amplitude) / 8);
  const monthly = monthly32(pixel, season);
  const south = (pixel.flags & 1) === 1;
  const offset = f32(day - warmestDay(south));
  const phase = f32(offset - f32(YEAR_DAYS * Math.floor(f32(offset / YEAR_DAYS))));
  const most = ramp32(ramp, f32(temperature - amplitude));
  if (most <= 0) return { most, now: 0, phase, coverage: 0, calm: 0 };
  const summer = ramp32(ramp, f32(temperature + amplitude));
  const now = ramp32(ramp, monthly);
  const [b0 = 0, b1 = 0, b2 = 1, b3 = 1] = Array.from(pixel.calendar);
  const unit = f32(DAYS_PER_UNIT);
  const level = clamp01(
    phase < COLDEST_PHASE
      ? f32(f32(phase - f32(b0 * unit)) / b2)
      : f32(f32(f32(b1 * unit) - phase) / b3),
  );
  const coverage =
    phase < COLDEST_PHASE
      ? Math.max(summer, Math.min(now, f32(most * level)))
      : Math.max(now, f32(most * level));
  const start = f32(b0 * unit);
  const end = Math.max(f32(b1 * unit), COLDEST_PHASE);
  const distance =
    phase < start
      ? Math.min(f32(start - phase), f32(f32(phase + YEAR_DAYS) - end))
      : phase > end
        ? Math.min(f32(phase - end), f32(f32(start + YEAR_DAYS) - phase))
        : 0;
  const calm = now > 0 ? 1 : clamp01(f32(1 - f32(distance / calmDays)));
  return { most, now, phase, coverage, calm };
}

/** Seuil de la matrice de Bayer 4 × 4 au pixel entier (x, y), comme le shader. */
export function bayer(x: number, y: number): number {
  const level = (qx: number, qy: number) => (2 * qx + 3 * qy) % 4;
  const a = level(modulo(x, 2), modulo(y, 2));
  const b = level(modulo(Math.floor(x / 2), 2), modulo(Math.floor(y / 2), 2));
  return (4 * a + b + 0.5) / 16;
}

/**
 * Réglages de l'image : uSeason et uDay (flottants 32 bits), échelle 1 ou plus, mode naturel,
 * ruisseaux ; et les uniformes de la couverture de l'eau (waveCovers).
 */
export interface WaveView {
  readonly season: number;
  readonly day: number;
  readonly fine: boolean;
  readonly natural: boolean;
  readonly streams: boolean;
  readonly covers: WaveCovers;
}

/** Ce qui retient un pixel de bouger, selon le shader. */
export type WaveStill = 'view' | 'land' | 'stream' | 'covered' | 'calm';

/** La rampe de la glace qui s'applique à un pixel d'eau, ou rien (haute mer, océan). */
export function waterRamp(pixel: WavePixel, covers: WaveCovers): Ramp32 | undefined {
  const cover = (pixel.flags >> 4) & 3;
  const waterCell = (pixel.flags >> 6) & 1;
  // Comme le shader : la glace des rivières dans une case de terre, puis celle des lacs, puis
  // la banquise ; la haute mer et l'océan ne gèlent pas.
  if (waterCell === 0 || cover === 2) return covers.ice;
  return cover === 3 ? covers.seaIce : undefined;
}

/**
 * Le pixel du monde (x, y) peut-il bouger ? Sinon, ce qui l'en retient : la vue (sous
 * l'échelle 1, hors du mode naturel), la terre, le ruisseau, la couverture (glace, banquise),
 * ou le calme qui précède la glace et suit son départ. La décision du shader, en flottants de
 * 32 bits.
 */
export function waveStill(
  view: WaveView,
  x: number,
  y: number,
  pixel: WavePixel,
): WaveStill | undefined {
  if (!view.fine || !view.natural) return 'view';
  if ((pixel.red & 1) === 1) return 'land';
  if (view.streams && (pixel.green & 1) === 1) return 'stream';
  const ramp = waterRamp(pixel, view.covers);
  if (ramp === undefined) return undefined;
  const water = waterCover32(pixel, ramp, view.season, view.day, view.covers.calmDays);
  const threshold = bayer(x, y);
  if (water.coverage > threshold) return 'covered';
  if (water.most <= 0) return undefined;
  return water.calm < threshold ? undefined : 'calm';
}

/**
 * Le ton que l'onde donne au pixel du monde (x, y), en 0xrrggbb, ou undefined s'il garde sa
 * couleur : la décision du shader, pas à pas. S'il ne peut pas bouger (waveStill), ou si
 * aucun biome animé n'a son ton, rien ne change ; sinon la crête l'éclaircit jusqu'à son ton
 * de crête, ou, à défaut, le clapot l'assombrit jusqu'à l'ombre.
 */
export function wavePixel(
  frame: WaveFrame,
  view: WaveView,
  x: number,
  y: number,
  pixel: WavePixel,
): number | undefined {
  const column = modulo(x, frame.worldPx);
  if (waveStill(view, column, y, pixel) !== undefined) return undefined;
  const color = (pixel.red << 16) | (pixel.green << 8) | pixel.blue;
  for (const biome of frame.table.biomes) {
    const tone = biome.tones.indexOf(color);
    if (tone < 0) continue;
    let next = tone;
    if (crestAt(frame, biome, column, y)) next = Math.max(tone, biome.crestTone);
    else if (rippleAt(frame, biome, column, y)) next = 0;
    return next === tone ? undefined : biome.tones[next];
  }
  return undefined;
}
