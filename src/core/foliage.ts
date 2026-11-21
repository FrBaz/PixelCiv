/**
 * Calendrier de la végétation (tâche 2b.7 ; C1, D9 et D10 ; REN-10 ; ADR 0019, § 2 et 3) : les
 * dates où chaque case vire à l'automne, se dénude ou entre en dormance, sèche, et prend la
 * lumière d'hiver. Une fonction pure du climat de la case, de sa latitude et des données, que la
 * carte (son shader) et le décor (src/gen/decor.ts, decorFoliage) lisent dans les mêmes octets :
 * le sol et l'arbre qui s'y dresse changent le même jour.
 *
 * Chaque case a FOLIAGE_BYTES octets, un par état : la date où l'état gagne la moitié de la case,
 * comptée en jours depuis son jour le plus chaud (la phase de src/core/snow.ts), de 0 à 180, en
 * FOLIAGE_UNIT jours ; NO_DATE s'il ne vient jamais.
 * - Bois nu et dormance (`bare`) : les jours où la température du mois passe sous `bareBelow`
 *   (data/decor.json, `foliage`) ; une fenêtre centrée sur le jour le plus froid, symétrique.
 * - Automne (`autumn`) : en refroidissant, quand le mois passe sous `autumnBelow` et déjà
 *   `autumnDrop` degrés sous le mois le plus chaud ; il finit avec le bois nu, par la même
 *   descente, si bien qu'il mène au bois nu ou s'éteint par une rampe, jamais d'un coup. Comme pour
 *   le décor de 2b.6, l'automne et le bois nu ne viennent que là où le mois le plus froid descend
 *   sous `bareBelow`.
 * - Saison sèche (`dry`) : une rampe de la pluie du mois, comme la neige l'est de la
 *   température. La pluie du mois rapportée à sa moyenne vaut 1 + r × c (r : rainSeasonality de
 *   la latitude ; c : le facteur de saison de la case, cos(2π phase / an)) ; la part sèche croît
 *   de 0 à 1 quand elle descend de `dryShare` à `dryShare − drySpan`. Son octet range r
 *   (DRY_SCALE), non une date : la part se lit de la saison du jour (dryShareOf). Elle varie donc
 *   sans à-coup d'une rangée à la suivante, là où une date tirait au bord de la zone sèche une
 *   ligne droite d'est en ouest (relecture de 2b.7, problème 3). Rien ne sèche au cœur de l'été,
 *   où la pluie du mois dépasse sa moyenne.
 * - Lumière d'hiver (`light`) : les jours dont le facteur de saison passe sous `factor` et dont
 *   le mois passe sous `below` et déjà `drop` degrés sous le mois le plus chaud (data/seasons.json,
 *   `light`) ; symétrique. Comme les autres états, elle suit le climat de la case, non sa
 *   latitude : son bord ne trace aucune ligne droite.
 *
 * Chaque état daté monte et descend en `minTransition` jours, centrés sur sa date : sa part de la
 * case, share(c, d) = borne((d − c) / transition + ½, 0, 1), où d est la distance au jour le plus
 * chaud, varie d'au plus 1 / transition par jour ; la saison sèche, de sa rampe, d'au plus
 * r × 2π / an / drySpan par jour. Rien ne change dans les `summerDays` jours centrés sur le jour
 * le plus chaud : au cœur de l'été, la carte est celle de ses tuiles.
 *
 * Déterminisme : les cosinus de dmath, tabulés aux jours entiers, sur les températures des couches
 * du monde, au dixième de degré, celles que lisait le décor de 2b.6 ; aucun tirage. Rien de cela
 * n'entre dans l'état de la simulation : la végétation ne se voit que sur la carte et le décor.
 */
import type { Decor, Seasons } from './data';
import { cos, TAU } from './dmath';
import { latitude, rainSeasonality } from './seasons';
import { COLDEST_PHASE, YEAR_DAYS } from './snow';
import type { WorldLayers, WorldSize } from './world';

/** Octets du calendrier de la végétation d'une case : automne, nu, sec, lumière. */
export const FOLIAGE_BYTES = 4;

/** Rang de chaque état dans les octets d'une case. */
export const FOLIAGE_SLOTS = { autumn: 0, bare: 1, dry: 2, light: 3 } as const;
export type FoliageSlot = keyof typeof FOLIAGE_SLOTS;

/** L'octet d'un état qui ne vient jamais. */
export const NO_DATE = 255;

/** Jours d'une unité des dates : la demi-année en 254 unités. */
export const FOLIAGE_UNIT = COLDEST_PHASE / 254;

/** Ce que le calendrier de la végétation lit des données. */
export interface FoliageRules {
  readonly foliage: Decor['foliage'];
  readonly seasons: Pick<Seasons, 'minTransition' | 'summerDays' | 'light'>;
}

/** Cosinus des jours entiers de phase, de 0 à COLDEST_PHASE : décroissants, de 1 à −1. */
const COSINES = Float64Array.from({ length: COLDEST_PHASE + 1 }, (_, day) =>
  cos((TAU * day) / YEAR_DAYS),
);

/**
 * Le jour d de [0, COLDEST_PHASE] où cos(2π d / an) descend à `value`, entre deux jours entiers
 * interpolé : 0 si `value` vaut 1 ou plus (la condition tient dès le jour le plus chaud), NaN s'il
 * reste au-dessus (−1 ou moins : elle ne tient jamais).
 */
function crossing(value: number): number {
  if (value >= 1) return 0;
  if (!(value > -1)) return Number.NaN;
  // COSINES[low] ≥ value > COSINES[high].
  let low = 0;
  let high = COLDEST_PHASE;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if ((COSINES[middle] ?? -1) >= value) low = middle;
    else high = middle;
  }
  const above = COSINES[low] ?? 1;
  const below = COSINES[high] ?? -1;
  return low + (above - value) / (above - below);
}

/**
 * Le jour où la température d'une case de température annuelle `annual` et de demi-amplitude
 * `amplitude` passe sous `threshold` en refroidissant, ou NaN si elle n'y passe jamais.
 */
function below(annual: number, amplitude: number, threshold: number): number {
  if (amplitude <= 0) return annual < threshold ? 0 : Number.NaN;
  return crossing((threshold - annual) / amplitude);
}

/** La date la plus précoce d'un état : il ne touche pas les `summerDays` jours de l'été. */
function earliest(rules: FoliageRules): number {
  const { summerDays, minTransition } = rules.seasons;
  return Math.ceil((summerDays + minTransition) / 2 / FOLIAGE_UNIT);
}

/** L'octet de la date `day` (NaN : jamais), au plus tôt `first`. */
function dateByte(day: number, first: number): number {
  if (Number.isNaN(day) || day > COLDEST_PHASE) return NO_DATE;
  return Math.min(254, Math.max(first, Math.round(day / FOLIAGE_UNIT)));
}

/**
 * Les octets de l'automne et du bois nu d'une case de température annuelle `annual` et de
 * demi-amplitude `swing` (°C, au dixième de degré des couches du monde), en poids faible
 * l'automne.
 */
export function coldDates(annual: number, swing: number, rules: FoliageRules): number {
  const { bareBelow, autumnBelow, autumnDrop } = rules.foliage;
  const first = earliest(rules);
  const bare = dateByte(below(annual, swing, bareBelow), first);
  if (bare === NO_DATE) return NO_DATE | (NO_DATE << 8);
  // L'automne : sous autumnBelow, et autumnDrop degrés sous le mois le plus chaud, en refroidissant.
  const cool = below(annual, swing, autumnBelow);
  const drop = swing > 0 ? crossing(1 - autumnDrop / swing) : Number.NaN;
  const autumn = dateByte(Math.max(cool, drop), first);
  return autumn | (bare << 8);
}

/** Unités de l'octet de la saison sèche par unité de force de la saison des pluies. */
export const DRY_SCALE = 250;

/** Ce que la saison sèche lit des données : sa rampe de la pluie du mois (data/decor.json). */
export type DryRule = Pick<Decor['foliage'], 'dryShare' | 'drySpan'>;

/**
 * L'octet de la saison sèche à `rain` de force de la saison des pluies (rainSeasonality) : r en
 * DRY_SCALE, ou NO_DATE si la pluie du mois ne descend jamais sous `dryShare` de sa moyenne.
 */
export function dryCode(rain: number, rules: Pick<FoliageRules, 'foliage'>): number {
  const code = Math.min(254, Math.round(rain * DRY_SCALE));
  return rules.foliage.dryShare - 1 + code / DRY_SCALE > 0 ? code : NO_DATE;
}

/**
 * La part sèche d'une case d'octet `code` (dryCode) au facteur de saison `factor` de son
 * hémisphère (le cosinus de sa phase) : la rampe de la pluie du mois. Le shader de la carte
 * calcule la même (seasonShader.ts, SEASON_EXPR.dry).
 */
export function dryShareOf(code: number, factor: number, dry: DryRule): number {
  if (code === NO_DATE) return 0;
  const rain = 1 + (code / DRY_SCALE) * factor;
  return Math.min(1, Math.max(0, (dry.dryShare - rain) / dry.drySpan));
}

/**
 * La distance au jour le plus chaud où la part sèche d'octet `code` passe `level` (de 0 à 1) en
 * refroidissant : la saison sèche la tient au-delà, jusqu'à la distance symétrique ; Infinity si
 * elle ne l'atteint jamais.
 */
export function dryDistance(code: number, level: number, dry: DryRule): number {
  if (code === NO_DATE) return Number.POSITIVE_INFINITY;
  const factor = (dry.dryShare - level * dry.drySpan - 1) / (code / DRY_SCALE);
  const day = crossing(factor);
  return Number.isNaN(day) ? Number.POSITIVE_INFINITY : day;
}

/**
 * L'octet de la lumière d'hiver d'une case de température annuelle `annual` et de demi-amplitude
 * `swing` (°C) : les jours de la moitié froide de l'année, où le facteur de saison passe sous
 * `factor`, dont le mois passe sous `below` et déjà `drop` degrés sous le mois le plus chaud ;
 * jamais si le mois n'y descend pas.
 */
export function lightDate(annual: number, swing: number, rules: FoliageRules): number {
  const { below: threshold, drop, factor } = rules.seasons.light;
  const dropped = swing > 0 ? crossing(1 - drop / swing) : Number.NaN;
  return dateByte(
    Math.max(crossing(factor), below(annual, swing, threshold), dropped),
    earliest(rules),
  );
}

/**
 * Le calendrier de la végétation de chaque case d'un monde, FOLIAGE_BYTES octets par case : une
 * fonction du seul climat (température, amplitude, latitude) et des données, que rien ne change en
 * cours de partie. Les cases d'un même climat partagent leur calcul.
 */
export function worldFoliage(
  size: WorldSize,
  layers: WorldLayers,
  rules: FoliageRules,
): Uint8Array<ArrayBuffer> {
  const { width, height } = size;
  const bytes = new Uint8Array(width * height * FOLIAGE_BYTES);
  // Les octets de l'automne, du bois nu et de la lumière de chaque climat.
  const colds = new Map<number, number>();
  for (let y = 0; y < height; y++) {
    const dry = dryCode(rainSeasonality(latitude(y, height)), rules);
    for (let x = 0; x < width; x++) {
      const cell = y * width + x;
      const temperature = layers.temperature[cell] ?? 0;
      const amplitude = layers.amplitude[cell] ?? 0;
      const key = temperature * 65536 + amplitude;
      let cold = colds.get(key);
      if (cold === undefined) {
        const annual = temperature / 10;
        const swing = amplitude / 10;
        cold = coldDates(annual, swing, rules) | (lightDate(annual, swing, rules) << 16);
        colds.set(key, cold);
      }
      const at = cell * FOLIAGE_BYTES;
      bytes[at] = cold & 255;
      bytes[at + 1] = (cold >>> 8) & 255;
      bytes[at + 2] = dry;
      bytes[at + 3] = cold >>> 16;
    }
  }
  return bytes;
}

/** Part d'un état de date `date` (un octet) à la distance `distance` du jour le plus chaud. */
export function stateShare(date: number, distance: number, transition: number): number {
  if (date === NO_DATE) return 0;
  return Math.min(1, Math.max(0, (distance - date * FOLIAGE_UNIT) / transition + 0.5));
}

/** Les parts des états d'une case, au jour de phase `phase` (src/core/snow.ts, phaseDay). */
export interface FoliageShares {
  readonly autumn: number;
  readonly bare: number;
  readonly dry: number;
  readonly light: number;
}

/**
 * Les parts des états de la case dont le calendrier est rangé aux octets [at, at + FOLIAGE_BYTES)
 * de `bytes`, au jour de phase `phase` : chaque état daté monte et descend autour de ses dates ;
 * l'automne monte à la sienne, en refroidissant, et descend avec le bois nu ; la saison sèche
 * suit sa rampe (`dry`). Le shader de la carte calcule les mêmes (mapShader.ts, SEASON_GLSL).
 */
export function foliageShares(
  bytes: ArrayLike<number>,
  at: number,
  phase: number,
  transition: number,
  dry: DryRule,
): FoliageShares {
  const distance = Math.min(phase, YEAR_DAYS - phase);
  const autumnDate = bytes[at] ?? NO_DATE;
  const bareDate = bytes[at + 1] ?? NO_DATE;
  const bare = stateShare(bareDate, distance, transition);
  let autumn = 0;
  if (autumnDate !== NO_DATE && bareDate !== NO_DATE) {
    const rise = (phase - autumnDate * FOLIAGE_UNIT) / transition + 0.5;
    const fall = (YEAR_DAYS - bareDate * FOLIAGE_UNIT - phase) / transition + 0.5;
    autumn = Math.min(1, Math.max(0, Math.min(rise, fall)));
  }
  return {
    autumn,
    bare,
    dry: dryShareOf(bytes[at + 2] ?? NO_DATE, cos((TAU * phase) / YEAR_DAYS), dry),
    light: stateShare(bytes[at + 3] ?? NO_DATE, distance, transition),
  };
}

/**
 * L'état d'un point de seuil `threshold` (de 0 à 1) : le bois nu s'il passe sous sa part, sinon
 * l'automne, sinon la saison sèche, sinon la lumière d'hiver (`light` : si elle se montre), sinon
 * l'été (rang −1). `states` : les états que prend la végétation du point.
 */
export const FOLIAGE_STATE = { summer: -1, autumn: 0, bare: 1, dry: 2, light: 3 } as const;
export type FoliageState = (typeof FOLIAGE_STATE)[keyof typeof FOLIAGE_STATE];

export function foliageState(
  shares: FoliageShares,
  states: { readonly autumn: boolean; readonly bare: boolean; readonly dry: boolean },
  threshold: number,
  light: boolean,
): FoliageState {
  if (states.bare && threshold < shares.bare) return FOLIAGE_STATE.bare;
  if (states.autumn && threshold < shares.autumn) return FOLIAGE_STATE.autumn;
  if (states.dry && threshold < shares.dry) return FOLIAGE_STATE.dry;
  if (light && threshold < shares.light) return FOLIAGE_STATE.light;
  return FOLIAGE_STATE.summer;
}

/**
 * Seuil du pixel (x, y) du monde, de 0 à 1 : un hachage sans motif, calculé en entiers, que le
 * shader de la carte calcule de même en flottants exacts (SEASON_GLSL.threshold) : chaque pixel
 * passe à l'état quand sa part dépasse son seuil. `x` et `y` sont positifs, x pris modulo la
 * largeur du monde en pixels.
 */
export function leafHash(x: number, y: number): number {
  return (((x * 97 + y * 61) % 251) * ((x * 31 + y * 173 + 7) % 241) + x + y * 3) % 256;
}

export function leafThreshold(x: number, y: number): number {
  return (leafHash(x, y) + 0.5) / 256;
}

/**
 * Le seuil médian des 16 pixels de la case (cx, cy) de 4 × 4 pixels : la moyenne de son 8e et de
 * son 9e seuils. Un état qui couvre la majorité des pixels de la case (9 au moins) couvre ce
 * seuil, si bien qu'un objet du décor qui le prend pour le sien suit la majorité de son sol.
 */
export function cellMedianThreshold(cx: number, cy: number): number {
  const values: number[] = [];
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) values.push(leafThreshold(cx * 4 + i, cy * 4 + j));
  }
  values.sort((a, b) => a - b);
  return ((values[7] ?? 0.5) + (values[8] ?? 0.5)) / 2;
}
