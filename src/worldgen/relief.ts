/**
 * Relief (tâche 1.2, MON-03, MON-05, MON-14 ; C1, D11 et D12).
 *
 * La hauteur brute additionne un bruit fractal à trois échelles (continents, régions,
 * détail) et des chaînes de montagnes : un bruit de crêtes, que module un champ de très
 * basse fréquence (où se dressent les chaînes), et qu'abaisse par endroits un bruit de
 * cols. Elle devient ensuite une altitude en mètres, par la correspondance de D11 :
 *
 *   terres : altitude = 7 000 m × hn^1,6,   hn = (h − mer) / échelle des terres
 *   mers   : profondeur = 5 500 m × dn^1,4, dn = (mer − h) / échelle des mers
 *
 * Le niveau de la mer est le quantile qui laisse émergée la part des terres demandée,
 * relevé ou abaissé par le paramètre « niveau de la mer ». L'échelle des terres place
 * au-dessus de la moyenne montagne (1 800 m) une part des terres qui croît avec le
 * paramètre « relief » : 4,5 % par défaut, dans la cible de C1 (3 à 6 %).
 */
import { pow } from '../core/dmath';
import type { Rng } from '../core/rng';
import { latitude } from './climate';
import { quantile, smoothstep } from './grid';
import { NoiseLayer, type CylinderSampler, type Fractal } from './sampler';

export interface ReliefParams {
  /** Part des terres émergées visée, dans [0, 1]. */
  readonly landShare: number;
  /** Montée (positive) ou baisse (négative) des eaux, dans [-1, 1]. */
  readonly seaLevel: number;
  /** De plat (0) à montagneux (1). */
  readonly relief: number;
}

/** Les trois échelles du bruit fractal, et leurs poids. */
const CONTINENTS: Fractal = { frequency: 2.2, octaves: 4, gain: 0.5 };
const REGIONS: Fractal = { frequency: 9, octaves: 4, gain: 0.5 };
const DETAIL: Fractal = { frequency: 40, octaves: 4, gain: 0.55 };
const WEIGHTS = { continents: 0.66, regions: 0.24, detail: 0.1 };

/**
 * Chaînes de montagnes. Leurs crêtes suivent les lignes où s'annule un bruit de basse
 * fréquence (CHAINS) : de longues courbes, à l'image des chaînes réelles. Un champ de
 * très basse fréquence (RANGES) choisit celles qui se dressent, un bruit de crêtes plus
 * fin (SPURS) y ajoute contreforts et vallées, et un dernier bruit (PASSES) les abaisse
 * par endroits : les cols.
 */
const CHAINS: Fractal = { frequency: 3.5, octaves: 3, gain: 0.45 };
const RANGES: Fractal = { frequency: 2, octaves: 2 };
const SPURS: Fractal = { frequency: 14, octaves: 3, gain: 0.5 };
const PASSES: Fractal = { frequency: 18, octaves: 2 };
/** Demi-largeur d'une chaîne, piémonts compris, en valeur du bruit des chaînes. */
const CHAIN_WIDTH = 0.22;
/** Part du détail gardée en plaine : de quoi infléchir les rivières sans heurter le relief. */
const LOWLAND_DETAIL = 0.9;
/** Détail supplémentaire en montagne : ravins et contreforts, à l'échelle des cases. */
const MOUNTAIN_DETAIL = 3;
/** Hauteur des crêtes, au relief par défaut, en unités de hauteur brute. */
const RIDGE_HEIGHT = 0.55;

/** Abaissement du fond vers les pôles, à partir de la latitude POLAR_SINK_FROM. */
const POLAR_SINK_FROM = 0.75;
const POLAR_SINK = 0.15;

/** Décalage du niveau de la mer à ±1, en unités de hauteur brute. */
const SEA_SHIFT = 0.05;

/** Correspondance de D11 : altitude et profondeur maximales, exposants. */
export const MAX_ALTITUDE = 7000;
export const MAX_DEPTH = 5500;
const ALTITUDE_EXPONENT = 1.6;
const DEPTH_EXPONENT = 1.4;

/** Altitude de la moyenne montagne (D11), et hn correspondant. */
const MID_MOUNTAIN = 1800;
/** Profondeur médiane des mers visée : celle des grands fonds. */
const MEDIAN_DEPTH = 3500;

/** Part des terres au-dessus de la moyenne montagne, selon le paramètre « relief ». */
export function mountainShare(relief: number): number {
  return 0.005 + 0.08 * relief;
}

/**
 * Comprime doucement les valeurs au-delà de `knee` vers 1 : les plus hauts sommets
 * gardent leur forme au lieu de s'aplatir en plateau à la valeur maximale.
 */
function soften(value: number, knee: number): number {
  if (value <= knee) return value;
  const excess = (value - knee) / (1 - knee);
  return knee + (1 - knee) * (excess / (1 + excess));
}

/** Hauteur brute : bruit à trois échelles et chaînes de montagnes. */
export function rawHeight(sampler: CylinderSampler, rng: Rng, relief: number): Float32Array {
  const layer = (name: string) => new NoiseLayer(rng.stream(`worldgen.relief.${name}`));
  const continents = sampler.fractal(layer('continents'), CONTINENTS);
  const regions = sampler.fractal(layer('regions'), REGIONS);
  const detail = sampler.fractal(layer('detail'), DETAIL);
  const chains = sampler.fractal(layer('chains'), CHAINS);
  const ranges = sampler.fractal(layer('ranges'), RANGES);
  const spurs = sampler.ridged(layer('spurs'), SPURS);
  const passes = sampler.fractal(layer('passes'), PASSES);
  const ridgeHeight = RIDGE_HEIGHT * (0.2 + 1.6 * relief);
  const height = new Float32Array(continents.length);
  const { width } = sampler;
  for (let index = 0; index < height.length; index++) {
    // Vers les pôles, le fond s'abaisse un peu : des mers polaires plutôt que des calottes
    // sans fin, et des rivières qui gagnent la mer au lieu de longer le bord de la carte.
    const polar = smoothstep(
      POLAR_SINK_FROM,
      1,
      latitude(Math.floor(index / width), sampler.height),
    );
    const continent = continents[index] ?? 0;
    // Profil en travers d'une chaîne : une crête étroite sur un socle de piémonts deux
    // fois et demie plus large, nuls à CHAIN_WIDTH de la ligne de crête.
    const distance = Math.abs(chains[index] ?? 0);
    const sharp = Math.max(0, 1 - distance / (0.4 * CHAIN_WIDTH));
    const broad = Math.max(0, 1 - distance / CHAIN_WIDTH);
    const crest =
      (0.55 * sharp * sharp + 0.45 * broad * Math.sqrt(broad)) * (0.6 + 0.4 * (spurs[index] ?? 0));
    const active = smoothstep(-0.1, 0.3, ranges[index] ?? 0);
    const land = smoothstep(-0.25, 0.1, continent);
    const pass = 0.3 + 0.7 * smoothstep(-0.5, -0.15, passes[index] ?? 0);
    const mountain = crest * active * land * pass;
    // Le détail s'accentue en montagne et sur les hautes terres, et s'efface en plaine.
    const rugged = Math.max(mountain * 2, smoothstep(0, 0.45, regions[index] ?? 0));
    height[index] =
      WEIGHTS.continents * continent +
      WEIGHTS.regions * (regions[index] ?? 0) +
      WEIGHTS.detail *
        (LOWLAND_DETAIL + (1 - LOWLAND_DETAIL) * Math.min(1, rugged) + MOUNTAIN_DETAIL * mountain) *
        (detail[index] ?? 0) +
      ridgeHeight * mountain -
      POLAR_SINK * polar;
  }
  return height;
}

/** Niveau de la mer en hauteur brute. */
export function seaThreshold(height: Float32Array, params: ReliefParams): number {
  return quantile(height, 1 - params.landShare) + params.seaLevel * SEA_SHIFT;
}

/**
 * Altitude en mètres, négative sous la mer, à partir de la hauteur brute (D11). Une
 * case émergée a une altitude positive ou nulle, une case de mer une profondeur d'au
 * moins un mètre.
 */
export function toElevation(height: Float32Array, sea: number, relief: number): Float32Array {
  // Échelle des terres : la part voulue des terres dépasse la moyenne montagne.
  const midHn = pow(MID_MOUNTAIN / MAX_ALTITUDE, 1 / ALTITUDE_EXPONENT);
  const landTop = quantile(
    height,
    1 - mountainShare(relief),
    (index) => (height[index] ?? 0) > sea,
  );
  const landScale = Math.max(1e-6, (landTop - sea) / midHn);
  // Échelle des mers : la profondeur médiane est celle des grands fonds.
  const medianDn = pow(MEDIAN_DEPTH / MAX_DEPTH, 1 / DEPTH_EXPONENT);
  const seaMedian = quantile(height, 0.5, (index) => (height[index] ?? 0) <= sea);
  const seaScale = Math.max(1e-6, (sea - seaMedian) / medianDn);
  const elevation = new Float32Array(height.length);
  for (let index = 0; index < height.length; index++) {
    const value = height[index] ?? 0;
    if (value > sea) {
      const hn = soften((value - sea) / landScale, 0.7);
      elevation[index] = MAX_ALTITUDE * pow(hn, ALTITUDE_EXPONENT);
    } else {
      const dn = soften((sea - value) / seaScale, 0.85);
      elevation[index] = -Math.max(1, MAX_DEPTH * pow(dn, DEPTH_EXPONENT));
    }
  }
  return elevation;
}

/** Relief complet : altitude en mètres de chaque case. */
export function generateRelief(
  sampler: CylinderSampler,
  rng: Rng,
  params: ReliefParams,
): Float32Array {
  const height = rawHeight(sampler, rng, params.relief);
  const sea = seaThreshold(height, params);
  return toElevation(height, sea, params.relief);
}
