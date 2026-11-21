/**
 * Shader des blocs de carte (tâches 1.7, 1.8 et 2b.7 ; C1, D9 et D10 ; REN-10 ; ADR 0010 et
 * 0019).
 *
 * Il lit le bloc cuit, la texture de données des saisons à la case du pixel, et ses calendriers de
 * la neige et de la glace (src/core/snow.ts) : la neige couvre les terres, la glace l'eau douce
 * (lacs et rivières), la banquise la mer côtière, chacune à la part que compose son calendrier
 * avec sa rampe (data/seasons.json), au jour continu de l'instant affiché. La couverture remplace
 * le pixel par la palette de saison du biome, choisie selon l'ombrage du pixel : jamais de
 * couleur hors palette (D10). Une couverture partielle se trame (matrice de Bayer), au pixel de
 * près, à la case de loin, pour rester stable au défilement. Les ruisseaux, marqués par la
 * cuisson, ne paraissent que de près. Rien ne se recuit : la part ne suit que les uniformes du
 * jour.
 *
 * En précision haute, textures comprises : en moyenne précision (16 bits sur bien des
 * téléphones), les pixels au-delà de 2 048 et les bits de données se liraient mal.
 *
 * Les modes de carte (relief, biomes, ressources) remplacent la couleur par celle d'une
 * texture de superposition, une valeur par case, en gardant l'ombrage du relief. En
 * relief, les rivières (pixels d'eau d'une case marquée par l'alpha 128) restent bleues.
 *
 * Écrit en GLSL ES 1.0 : PixiJS y ajoute ce qu'il faut pour WebGL 1 et 2.
 *
 * Les rampes, la part de neige des forêts et le calme de la mer viennent de data/seasons.json, par
 * des uniformes : le programme ne dépend pas des données. La simulation lit les mêmes rampes et
 * les mêmes calendriers, par la même composition (src/sim/cover.ts) : la pêche gèle comme la
 * carte.
 *
 * La mer animée (tâche 2b.4, ADR 0015) a son propre programme, `MAP_FRAGMENT_WAVES` : le même,
 * augmenté du code de src/render/waves.ts, inséré avant main() et après la couverture. La
 * carte ne le donne qu'aux blocs où l'onde se voit ; partout ailleurs, `MAP_FRAGMENT` suffit.
 * Les couleurs de la saison (second temps de 2b.7) s'inséreront aux mêmes ancres, après l'onde
 * (SEASON_ANCHORS).
 */
import type { Seasons } from '../core/data/schemas';
import type { CoverRamp } from '../core/seasons';
import { COLDEST_PHASE, DAYS_PER_UNIT, warmestDay, YEAR_DAYS } from '../core/snow';
import { glslFloat } from './glsl';
import { WAVE_GLSL } from './waves';

export { glslFloat } from './glsl';

const f = glslFloat;

/**
 * Les uniformes des couvertures, tirés de data/seasons.json : les rampes de la neige, de la glace
 * d'eau douce et de la banquise (début, étendue, part pleine), et la part de neige des forêts. Le
 * shader de la carte et celui des objets (l'ombre « ground ») les reçoivent tels quels.
 */
export interface CoverUniforms {
  readonly snow: Float32Array<ArrayBuffer>;
  readonly ice: Float32Array<ArrayBuffer>;
  readonly seaIce: Float32Array<ArrayBuffer>;
  readonly forest: number;
}

export function coverUniforms(seasons: Seasons): CoverUniforms {
  const ramp = ({ onset, span, full }: CoverRamp) => new Float32Array([onset, span, full]);
  return {
    snow: ramp(seasons.snow.ramp),
    ice: ramp(seasons.freshIce.ramp),
    seaIce: ramp(seasons.seaIce.ramp),
    forest: seasons.snow.forest,
  };
}

/**
 * La couverture d'une case, écrite une fois en expressions GLSL : le shader de la carte les
 * assemble (MAP_FRAGMENT), celui des humains et des objets aussi, pour l'ombre « ground »
 * (humanShader.ts), et les essais les évaluent hors du GPU contre la part de neige que lit le
 * décor (render/seasons.ts, snowShareOn) et la pêche (src/sim/cover.ts) : un arbre s'enneige et
 * la pêche gèle d'après ce que montre la carte. `data` est le texel de la case dans la texture des
 * saisons, normalisé comme le lit le GPU ; `uSeason` le facteur de saison du mois, `uDay` le jour
 * continu de l'année ; `ramp` la rampe de la couverture du pixel (début, étendue, part pleine) et
 * `calendar` les quatre octets de son calendrier (src/core/snow.ts, calendarLevel, composeCover).
 */
export const COVER_GLSL = {
  temperature: 'data.r * 255.0 / 2.0 - 64.0',
  amplitude: 'data.g * 255.0 / 8.0',
  flags: 'floor(data.b * 255.0 + 0.5)',
  south: 'mod(flags, 2.0)',
  cover: 'mod(floor(flags / 16.0), 4.0)',
  waterCell: 'mod(floor(flags / 64.0), 2.0)',
  forest: 'floor(flags / 128.0)',
  monthly: 'temperature + amplitude * uSeason * (south > 0.5 ? -1.0 : 1.0)',
  /** Jours depuis le jour le plus chaud de la case (src/core/snow.ts, phaseDay). */
  phase: `mod(uDay - (south > 0.5 ? ${f(warmestDay(true))} : ${f(warmestDay(false))}), ${f(YEAR_DAYS)})`,
  /** La rampe au mois le plus froid, au plus chaud (le plancher de l'été) et au jour. */
  most: 'clamp((ramp.x - (temperature - amplitude)) / ramp.y, 0.0, 1.0) * ramp.z',
  summer: 'clamp((ramp.x - (temperature + amplitude)) / ramp.y, 0.0, 1.0) * ramp.z',
  now: 'clamp((ramp.x - monthly) / ramp.y, 0.0, 1.0) * ramp.z',
  /** Le niveau du calendrier : sa montée au refroidissement, sa descente au réchauffement. */
  level: `clamp(phase < ${f(COLDEST_PHASE)} ? (phase - calendar.x * ${f(DAYS_PER_UNIT)}) / calendar.z : (calendar.y * ${f(DAYS_PER_UNIT)} - phase) / calendar.w, 0.0, 1.0)`,
  /** La part couverte : jamais plus tôt que la rampe à l'automne, jamais moins au printemps. */
  share: `phase < ${f(COLDEST_PHASE)} ? max(summer, min(now, most * level)) : max(now, most * level)`,
} as const;

/** La matrice de Bayer 4 × 4 de la trame des couvertures, en GLSL (crédits : CREDITS.md). */
export const BAYER_GLSL = `float bayer2(vec2 q) {
  return mod(2.0 * q.x + 3.0 * q.y, 4.0);
}

/** Seuil de la matrice de Bayer 4 × 4 au point entier p, dans (0, 1). */
float bayer(vec2 p) {
  vec2 a = mod(p, 2.0);
  vec2 b = mod(floor(p / 2.0), 2.0);
  return (4.0 * bayer2(a) + bayer2(b) + 0.5) / 16.0;
}`;

export const MAP_VERTEX = /* glsl */ `
in vec2 aPosition;
in vec2 aUV;
out vec2 vUV;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
}
`;

export const MAP_FRAGMENT = /* glsl */ `precision highp float;
precision highp sampler2D;

in vec2 vUV;
out vec4 finalColor;

uniform sampler2D uChunk;
uniform sampler2D uData;
uniform sampler2D uPalettes;
uniform sampler2D uOverlay;

/** Origine du bloc, en cases. */
uniform vec2 uOrigin;
/** Taille du monde, en cases ; nombre de biomes ; indice du biome « rivière ». */
uniform vec2 uWorldCells;
uniform float uBiomes;
uniform float uRiver;
/** Indice d'un biome à neige, dont la palette sert aux terres posées sur l'eau. */
uniform float uSnow;
/** cos(2π (mois − 6,5) / 12), le mois courant étant continu (C1, D8). */
uniform float uSeason;
/** Jour continu de l'année, 30 × le mois : la phase des calendriers (src/core/snow.ts). */
uniform float uDay;
/** Calendriers de la neige (lignes 0 à H − 1) et de la glace (H à 2H − 1), un texel par case. */
uniform sampler2D uCalendars;
/** Rampes de la neige, de la glace d'eau douce et de la banquise : début, étendue, part pleine. */
uniform vec3 uSnowRamp;
uniform vec3 uIceRamp;
uniform vec3 uSeaIceRamp;
/** Part de la neige qu'une forêt garde : les arbres dépassent. */
uniform float uForestSnow;
/** Mode de carte : 0 naturel, 1 couleur par case, 2 ressources. */
uniform float uMode;
/** Couleur des rivières et des ruisseaux. */
uniform vec3 uRiverColor;
/** 1 : trame au pixel, et bits des pixels lisibles (niveau 0) ; 0 : de loin, à la case. */
uniform float uFine;
/** 1 : ruisseaux visibles (de près). */
uniform float uStreams;

${BAYER_GLSL}

void main() {
  vec4 texel = texture(uChunk, vUV);
  vec2 pixel = floor(vUV * 256.0);
  vec2 cell = uOrigin + floor(pixel / 4.0);
  vec2 cellUv = (cell + 0.5) / uWorldCells;
  vec4 data = texture(uData, cellUv);

  float temperature = ${COVER_GLSL.temperature};
  float amplitude = ${COVER_GLSL.amplitude};
  float flags = ${COVER_GLSL.flags};
  float south = ${COVER_GLSL.south};
  float cover = ${COVER_GLSL.cover};
  float waterCell = ${COVER_GLSL.waterCell};
  float forest = ${COVER_GLSL.forest};
  float biome = floor(data.a * 255.0 + 0.5);
  float monthly = ${COVER_GLSL.monthly};

  // Au plus près, chaque pixel dit s'il est de terre (bit faible du rouge) et s'il porte
  // un ruisseau (bit faible du vert) ; de loin, la moyenne des mipmaps brouille ces bits,
  // et la case décide. L'alpha porte l'ombrage, que la moyenne respecte.
  float land = 1.0 - waterCell;
  float stream = 0.0;
  if (uFine > 0.5) {
    land = mod(floor(texel.r * 255.0 + 0.5), 2.0);
    stream = mod(floor(texel.g * 255.0 + 0.5), 2.0) * uStreams;
  }
  float shade = texel.a + 0.5;
  vec3 color = texel.rgb;
  bool water = land < 0.5 || stream > 0.5;
  if (stream > 0.5) color = uRiverColor;

  // Couverture du jour (C1, D9 ; ADR 0019) : neige, glace d'eau douce, banquise, à inertie.
  // kind : 1 la neige, 2 la glace d'eau douce, 3 la banquise, 0 rien.
  float kind = 0.0;
  float keep = 1.0;
  if (!water && cover == 1.0) {
    // Les arbres dépassent : les forêts gardent moins de neige.
    kind = 1.0;
    if (forest > 0.5) keep = uForestSnow;
  } else if (!water && (waterCell > 0.5 || cover != 0.0)) {
    // Une terre posée sur l'eau, ou la rive d'un fleuve : la neige y tombe aussi.
    kind = 1.0;
    biome = uSnow;
  } else if (water && waterCell < 0.5) {
    // Une rivière ou un ruisseau dans une case de terre : la glace des rivières.
    kind = 2.0;
    biome = uRiver;
  } else if (water && cover == 2.0) {
    kind = 2.0;
  } else if (water && cover == 3.0) {
    kind = 3.0;
  }
  float phase = ${COVER_GLSL.phase};
  vec3 ramp = kind < 1.5 ? uSnowRamp : (kind < 2.5 ? uIceRamp : uSeaIceRamp);
  float most = kind > 0.5 ? ${COVER_GLSL.most} : 0.0;
  float now = 0.0;
  vec4 calendar = vec4(0.0, 0.0, 1.0, 1.0);
  float coverage = 0.0;
  if (most > 0.0) {
    // Le calendrier de la case : celui de sa neige, ou celui de la glace de son eau.
    float row = cell.y + (kind < 1.5 ? 0.5 : uWorldCells.y + 0.5);
    calendar = floor(texture(uCalendars, vec2(cellUv.x, row / (2.0 * uWorldCells.y))) * 255.0 + 0.5);
    float summer = ${COVER_GLSL.summer};
    now = ${COVER_GLSL.now};
    float level = ${COVER_GLSL.level};
    coverage = (${COVER_GLSL.share}) * keep;
  }
  vec2 dither = uFine > 0.5 ? pixel + uOrigin * 4.0 : cell;
  if (coverage > bayer(dither)) {
    float tone = shade < 0.88 ? 0.5 : (shade > 1.12 ? 2.5 : 1.5);
    color = texture(uPalettes, vec2(tone / 3.0, (biome + 0.5) / uBiomes)).rgb;
  }

  if (uMode > 0.5) {
    vec4 overlay = texture(uOverlay, cellUv);
    if (uMode < 1.5) {
      color = overlay.rgb * shade;
      // En relief, les rivières et les ruisseaux visibles restent bleus.
      if (water && waterCell < 0.5 && overlay.a < 0.75) color = uRiverColor;
    } else {
      float grey = dot(color, vec3(0.3, 0.59, 0.11));
      color = mix(vec3(grey), color, 0.35) * 0.8;
      // Un gisement en plein ; une ressource du milieu teinte la carte pâlie (RES-05).
      if (overlay.a > 0.75) color = overlay.rgb;
      else if (overlay.a > 0.25) color = mix(color, overlay.rgb, 0.7);
    }
  }
  finalColor = vec4(color, 1.0);
}
`;

/** Insère `code` juste avant `anchor`, qui doit paraître une fois et une seule dans `source`. */
function insertBefore(source: string, anchor: string, code: string): string {
  const at = source.indexOf(anchor);
  if (at < 0 || source.includes(anchor, at + 1)) {
    throw new Error(`point d'insertion introuvable ou ambigu : ${anchor}`);
  }
  return source.slice(0, at) + code + source.slice(at);
}

/** Points d'insertion du code de l'onde : avant main(), et entre la couverture et les modes. */
export const WAVE_ANCHORS = { header: 'void main() {', main: '  if (uMode > 0.5) {' } as const;

/**
 * Points d'insertion du code des couleurs de la saison (second temps de 2b.7, ADR 0019, § 3) :
 * les mêmes que l'onde, insérés après elle (insertBefore sur MAP_FRAGMENT_WAVES), si bien qu'ils
 * viennent après la couverture et l'onde, et avant les modes de carte (ADR 0015, § 11). Le code
 * des saisons y lit les variables de la couverture (kind, phase, ramp, most, now, calendar).
 */
export const SEASON_ANCHORS = WAVE_ANCHORS;

/** Insère `code` juste avant `anchor` de `source` (une fois et une seule). */
export const insertCode = (source: string, anchor: string, code: string): string =>
  insertBefore(source, anchor, code);

/** Programme des blocs où la mer animée se voit : MAP_FRAGMENT et le code de l'onde. */
export const MAP_FRAGMENT_WAVES = insertBefore(
  insertBefore(MAP_FRAGMENT, WAVE_ANCHORS.header, WAVE_GLSL.header),
  WAVE_ANCHORS.main,
  WAVE_GLSL.main,
);
