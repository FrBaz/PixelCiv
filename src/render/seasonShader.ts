/**
 * Couleurs de la saison sur la carte (tâche 2b.7 ; C1, D9 et D10 ; REN-09 et REN-10 ; ADR 0019,
 * § 2 et 3) : le code GLSL que les programmes des saisons ajoutent à celui de la carte, après la
 * couverture et l'onde, et avant les modes (ADR 0015, § 11).
 *
 * Sur un pixel de terre que rien ne couvre, l'état de la végétation de sa case (src/core/foliage.ts)
 * remplace le ton cuit par le ton de même rang de la palette de l'état (data/biomes.json,
 * `seasons.states`), ou de la lumière d'hiver (data/seasons.json, `light`), sous l'ombrage et la
 * teinte thermique de la cuisson : la formule de bake.ts, appliquée à une palette déclarée. Rien
 * ne se devine de la couleur du pixel :
 * - de près (une échelle de 1 ou plus), la carte d'identité des tons du bloc (bake.ts, IDENTITY)
 *   dit le rang du ton et la case qui le prête, dont la texture des saisons donne le biome, la
 *   température et l'hémisphère, et le calendrier de la végétation les dates ; chaque pixel passe
 *   à l'état quand sa part dépasse son seuil (leafThreshold), si bien qu'une transition se trame
 *   pixel à pixel, sans motif ;
 * - de loin, les mipmaps mêlent les tons : la case décide, à son seuil, et la moyenne cuite prend
 *   le rapport des tons moyens de l'état et de l'été du biome (statePalettes).
 *
 * Les expressions de SEASON_EXPR, que le code assemble, sont celles que les essais évaluent hors du
 * GPU (src/render/testing.ts, evaluateGlsl) contre le miroir (src/render/seasonMirror.ts) et
 * contre le calendrier du décor (foliageShares, leafThreshold) ; les dates et les réglages
 * arrivent par des textures et des uniformes, si bien que le programme ne dépend pas des données.
 */
import { FOLIAGE_UNIT } from '../core/foliage';
import { warmestDay, YEAR_DAYS } from '../core/snow';
import { CHUNK_PX, TINT } from './bake';
import { glslFloat } from './glsl';

const f = glslFloat;

/** Colonnes de la texture des tons des états : quatre états de trois rangs, puis cinq moyennes. */
export const STATE_COLUMNS = 17;
/** Colonne du ton moyen de l'été ; celles des états la suivent (automne, nu, sec, hiver). */
export const MEAN_COLUMN = 12;

/** Texels de la carte d'identité d'un bloc : quatre pixels d'une rangée de case par texel. */
export const IDENTITY_WIDTH = CHUNK_PX / 4;
export const IDENTITY_HEIGHT = CHUNK_PX;

/** x modulo m (`m` : un littéral entier, ou une expression positive), pour des entiers positifs. */
function imod(x: string, m: number | string): string {
  const modulus = typeof m === 'number' ? f(m) : m;
  return `(${x} - ${modulus} * floor((${x} + 0.5) / ${modulus}))`;
}

const U = f(Math.fround(FOLIAGE_UNIT));
const YEAR = f(YEAR_DAYS);

/** La part d'un état de date `date` (octet ; 255 : jamais) à la distance `leafDistance`. */
const share = (date: string) =>
  `${date} > 254.5 ? 0.0 : clamp((leafDistance - ${date} * ${U}) / uFoliageDays + 0.5, 0.0, 1.0)`;

/**
 * Les expressions des couleurs de la saison, écrites une fois. Variables : `pixel` le pixel du
 * bloc, `code` celui de la carte d'identité, `leafX` et `leafY` le point de seuil (le pixel du
 * monde, ou la case de loin), `leafPhase` le jour de phase de la case (src/core/snow.ts, phaseDay),
 * `cal` les quatre octets de son calendrier (automne, nu, sec, lumière), `sourceT` sa température
 * annuelle (°C), `sourceSouth` son hémisphère.
 */
export const SEASON_EXPR = {
  /** Le pixel du monde, x et y entiers, x dans [0, largeur du monde en pixels). */
  wx: 'uOrigin.x * 4.0 + pixel.x',
  wy: 'uOrigin.y * 4.0 + pixel.y',
  /** Le canal du texel de la carte d'identité : la colonne du pixel dans sa case. */
  lane: 'pixel.x - 4.0 * floor((pixel.x + 0.5) / 4.0)',
  /** Le rang du ton (0 ombre, 1 base, 2 lumière) et la case bilinéaire qui le prête (0 à 3). */
  rank: imod('code - 1.0', 3),
  lender: 'floor((code - 1.0 + 0.5) / 3.0)',
  /** La case bilinéaire au nord-ouest du pixel, puis la case qui prête le ton, x bouclé. */
  cornerX: 'floor((wx + 0.5) / 4.0 - 0.5)',
  cornerY: 'floor((wy + 0.5) / 4.0 - 0.5)',
  sourceX: imod(
    'cornerX + lender - 2.0 * floor((lender + 0.5) / 2.0) + uWorldCells.x',
    'uWorldCells.x',
  ),
  sourceY: 'clamp(cornerY + floor((lender + 0.5) / 2.0), 0.0, uWorldCells.y - 1.0)',
  /** Le jour de phase de la case qui prête le ton, selon son hémisphère. */
  leafPhase: `mod(uDay - (sourceSouth > 0.5 ? ${f(warmestDay(true))} : ${f(warmestDay(false))}), ${YEAR})`,
  /** Seuil du point (leafX, leafY) : src/core/foliage.ts, leafThreshold. */
  threshold: `(${imod(
    `${imod('leafX * 97.0 + leafY * 61.0', 251)} * ${imod('leafX * 31.0 + leafY * 173.0 + 7.0', 241)} + leafX + leafY * 3.0`,
    256,
  )} + 0.5) / 256.0`,
  /** Distance au jour le plus chaud, de 0 à la moitié de l'année. */
  leafDistance: `min(leafPhase, ${YEAR} - leafPhase)`,
  /** Les parts des états : src/core/foliage.ts, foliageShares. */
  bare: share('cal.y'),
  autumn: `cal.x > 254.5 ? 0.0 : (cal.y > 254.5 ? 0.0 : clamp(min((leafPhase - cal.x * ${U}) / uFoliageDays + 0.5, (${YEAR} - cal.y * ${U} - leafPhase) / uFoliageDays + 0.5), 0.0, 1.0))`,
  dry: share('cal.z'),
  light: `uLight < 0.5 ? 0.0 : (${share('cal.w')})`,
  /** L'état du point : 1 nu, 0 automne, 2 sec, 3 hiver, −1 l'été (foliageState). */
  state:
    'threshold < bare ? 1.0 : (threshold < autumn ? 0.0 : (threshold < dry ? 2.0 : (threshold < light ? 3.0 : -1.0)))',
  /** La teinte thermique de la cuisson (bake.ts, TINT), à la température annuelle `sourceT`. */
  warm: `clamp((sourceT - ${f(TINT.warmFrom)}) / ${f(TINT.warmSpan)}, 0.0, 1.0)`,
  cold: `clamp(-sourceT / ${f(TINT.coldSpan)}, 0.0, 1.0)`,
  tintRed: `1.0 + ${f(TINT.red)} * warm - ${f(TINT.red)} * cold`,
  tintGreen: `1.0 + ${f(TINT.green)} * warm`,
  tintBlue: `1.0 - ${f(TINT.blue)} * warm + ${f(TINT.blue)} * cold`,
} as const;

const E = SEASON_EXPR;

/** Les parts et l'état, d'après `cal`, `leafPhase`, `leafX` et `leafY`, en GLSL. */
const STATE_CODE = `        float leafDistance = ${E.leafDistance};
        float threshold = ${E.threshold};
        float bare = ${E.bare};
        float autumn = ${E.autumn};
        float dry = ${E.dry};
        float light = ${E.light};
        float state = ${E.state};`;

export const SEASON_GLSL = {
  header: /* glsl */ `// Couleurs de la saison (tâche 2b.7, ADR 0019) : écrit par src/render/seasonShader.ts, dont
// src/render/seasonMirror.ts tient le miroir.
/** Carte d'identité des tons du bloc, quatre pixels d'une rangée de case par texel. */
uniform sampler2D uIdentity;
/** Calendrier de la végétation de chaque case, ses états sans palette effacés (255). */
uniform sampler2D uFoliage;
/** Tons des états de chaque biome (automne, nu, sec, hiver) par rang, puis les tons moyens. */
uniform sampler2D uStates;
/** Durée d'une transition, en jours ; la lumière d'hiver se montre-t-elle (0 ou 1) ? */
uniform float uFoliageDays;
uniform float uLight;

`,
  main: /* glsl */ `  // Couleurs de la saison (ADR 0019, § 2 et 3) : un pixel de terre que rien ne couvre prend le
  // ton de même rang de l'état de sa végétation, ou de la lumière d'hiver, sous l'ombrage cuit.
  if (!water && !(coverage > bayer(dither))) {
    if (uFine > 0.5) {
      // De près : la carte d'identité dit le rang du ton et la case qui le prête.
      vec4 identity = texture(uIdentity, vec2((floor(pixel.x / 4.0) + 0.5) / ${f(IDENTITY_WIDTH)}, (pixel.y + 0.5) / ${f(IDENTITY_HEIGHT)}));
      float lane = ${E.lane};
      float code = floor((lane < 0.5 ? identity.r : (lane < 1.5 ? identity.g : (lane < 2.5 ? identity.b : identity.a))) * 255.0 + 0.5);
      if (code > 0.5) {
        float wx = ${E.wx};
        float wy = ${E.wy};
        float rank = ${E.rank};
        float lender = ${E.lender};
        float cornerX = ${E.cornerX};
        float cornerY = ${E.cornerY};
        float sourceX = ${E.sourceX};
        float sourceY = ${E.sourceY};
        vec2 source = vec2(sourceX, sourceY);
        vec2 sourceUv = (source + 0.5) / uWorldCells;
        vec4 sourceData = source == cell ? data : texture(uData, sourceUv);
        float sourceSouth = mod(floor(sourceData.b * 255.0 + 0.5), 2.0);
        float leafPhase = ${E.leafPhase};
        vec4 cal = floor(texture(uFoliage, sourceUv) * 255.0 + 0.5);
        float leafX = wx;
        float leafY = wy;
${STATE_CODE}
        if (state > -0.5) {
          float sourceBiome = floor(sourceData.a * 255.0 + 0.5);
          vec3 tone = texture(uStates, vec2((state * 3.0 + rank + 0.5) / ${f(STATE_COLUMNS)}, (sourceBiome + 0.5) / uBiomes)).rgb;
          float sourceT = sourceData.r * 255.0 / 2.0 - 64.0;
          float warm = ${E.warm};
          float cold = ${E.cold};
          color = tone * shade * vec3(${E.tintRed}, ${E.tintGreen}, ${E.tintBlue});
        }
      }
    } else {
      // De loin : la case décide, à son seuil, et la moyenne cuite prend le rapport des tons
      // moyens de l'état et de l'été de son biome.
      vec4 cal = floor(texture(uFoliage, cellUv) * 255.0 + 0.5);
      float leafPhase = phase;
      float leafX = cell.x;
      float leafY = cell.y;
${STATE_CODE}
      if (state > -0.5) {
        // Le biome de la case, et non celui de sa couverture (une rive prend la neige d'un autre).
        float row = (floor(data.a * 255.0 + 0.5) + 0.5) / uBiomes;
        vec3 mean = texture(uStates, vec2((${f(MEAN_COLUMN + 1)} + state + 0.5) / ${f(STATE_COLUMNS)}, row)).rgb;
        vec3 summer = texture(uStates, vec2(${f(MEAN_COLUMN + 0.5)} / ${f(STATE_COLUMNS)}, row)).rgb;
        color = texel.rgb * mean / max(summer, vec3(${f(1 / 255)}));
      }
    }
  }
`,
} as const;
