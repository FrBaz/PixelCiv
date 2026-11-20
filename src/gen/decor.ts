/**
 * Pose et saisons du décor (tâche 2b.6 ; MON-10, REN-03, C1 D7 et D9 ; ADR 0017), en fonctions
 * pures : une graine, une case et des couches donnent toujours les mêmes objets, sur tous les
 * navigateurs (ADR 0003). Rien n'entre dans l'état de la simulation ; le rendu pose les objets
 * sur la carte (src/render/decor.ts), et les activités de 2b.8 pourront savoir, dans le worker,
 * où sont les arbres et les buissons.
 *
 * - Pose : au plus un arbre, un buisson et un rocher par case de terre, hors des lits des
 *   rivières et des fleuves. Un arbre s'y pose avec la probabilité de la densité de sa case
 *   (floraDensity), un buisson de même ; leur espèce se tire parmi celles du biome, selon leur
 *   poids ; un rocher se pose sur chaque gisement, à l'aspect de son minerai, et çà et là sur les
 *   biomes rocheux. L'occupation du sol de la case (C1 D7, phase 3) dit la part du décor naturel
 *   qu'elle garde.
 * - Tirages : quatorze par case, toujours les mêmes et dans le même ordre, d'un splitmix32 dont la
 *   graine mêle la clé du décor et l'indice de la case, x ramené dans le monde : la même case
 *   donne les mêmes objets dans chaque copie du monde, de part et d'autre de la couture.
 * - Saisons : l'état du feuillage (feuillé, automne, nu, sec) se tire du climat de la case au
 *   mois de l'instant ; la neige vient de la part de neige de la case, que fournit la même source
 *   que le shader de la carte (src/render/seasons.ts, snowShare).
 */
import type { Biome, Decor, Flora, LandUse, Phenology, Resource } from '../core/data';
import type { Catalog } from '../core/data/catalog';
import { floraDensity } from '../core/flora';
import { splitmix32, streamSeed } from '../core/rng';
import { seasonFactor } from '../core/seasons';
import { riverClass, type WorldLayers, type WorldSize } from '../core/world';

/** Sortes d'objets du décor. */
export const DECOR_KIND = { tree: 0, shrub: 1, rock: 2 } as const;
export type DecorKind = (typeof DECOR_KIND)[keyof typeof DECOR_KIND];

/** Une apparence d'objet : une espèce de la flore, la roche nue, ou le rocher d'un minerai. */
export interface DecorLook {
  readonly kind: DecorKind;
  /** Rang de l'espèce dans data/flora.json, −1 pour un rocher. */
  readonly flora: number;
  /** Rang du minerai dans data/resources.json, −1 hors d'un gisement. */
  readonly mineral: number;
  /** Ses grilles (assets/decor/<forme>-<variante>.txt), et ses grilles nues s'il en a. */
  readonly form: string;
  readonly bare: string | undefined;
  readonly phenology: Phenology;
}

/**
 * L'entrée de `entries` au rang `index`, ou rien pour un rang négatif : le −1 d'un rocher sans
 * espèce, ou d'une roche nue sans minerai, ne désigne aucune entrée (Array.at(−1) rendrait la
 * dernière).
 */
export function entryOf<T>(entries: readonly T[], index: number): T | undefined {
  return index < 0 ? undefined : entries[index];
}

/** Les apparences d'une sorte qu'un biome admet, et leurs poids cumulés. */
export interface WeightedLooks {
  readonly looks: readonly number[];
  readonly cumulative: readonly number[];
  readonly total: number;
}

/** Ce que la pose lit des données, compilé une fois (compileDecor). */
export interface DecorTable {
  readonly looks: readonly DecorLook[];
  /**
   * Par biome : ses arbres et ses buissons pondérés, sa chance de rocher épars et l'apparence de
   * ce rocher (−1 sans rocher épars), s'il est d'eau.
   */
  readonly trees: readonly WeightedLooks[];
  readonly shrubs: readonly WeightedLooks[];
  readonly rockChance: readonly number[];
  readonly rockLook: readonly number[];
  readonly water: readonly boolean[];
  /** Apparence du rocher de chaque minerai (indice de la couche deposit − 1), −1 sans rocher. */
  readonly depositLook: readonly number[];
  readonly place: Decor['place'];
}

/** Ce que compileDecor lit du contenu. */
export interface DecorData {
  readonly biomes: Catalog<Biome>;
  readonly flora: Catalog<Flora>;
  readonly resources: Catalog<Resource>;
  readonly decor: Decor;
}

/** Les apparences et les règles de la pose, tirées du contenu. */
export function compileDecor(data: DecorData): DecorTable {
  const looks: DecorLook[] = data.flora.entries.map((entry, index) => ({
    kind: entry.kind === 'tree' ? DECOR_KIND.tree : DECOR_KIND.shrub,
    flora: index,
    mineral: -1,
    form: entry.look.form,
    bare: entry.look.bare,
    phenology: entry.look.phenology,
  }));
  const rock = (form: string, mineral: number): number => {
    looks.push({
      kind: DECOR_KIND.rock,
      flora: -1,
      mineral,
      form,
      bare: undefined,
      phenology: 'evergreen',
    });
    return looks.length - 1;
  };
  // Les rochers épars, une apparence par forme (data/decor.json, rocks), dans l'ordre des
  // biomes : une roche nue, sans minerai.
  const looseRocks = new Map<string, number>();
  const rockLook = data.biomes.entries.map((biome) => {
    const entry = Object.hasOwn(data.decor.rocks, biome.id)
      ? data.decor.rocks[biome.id]
      : undefined;
    if (entry === undefined) return -1;
    let look = looseRocks.get(entry.form);
    if (look === undefined) {
      look = rock(entry.form, -1);
      looseRocks.set(entry.form, look);
    }
    return look;
  });
  const depositLook = data.resources.entries.map((resource, index) => {
    const look = Object.hasOwn(data.decor.deposits, resource.id)
      ? data.decor.deposits[resource.id]
      : undefined;
    return look === undefined ? -1 : rock(look.form, index);
  });
  const weighted = (biome: Biome, kind: 'tree' | 'shrub'): WeightedLooks => {
    const chosen: number[] = [];
    const cumulative: number[] = [];
    let total = 0;
    for (const id of biome.flora.species) {
      const index = data.flora.indexOf(id);
      if (index === undefined || data.flora.entries.at(index)?.kind !== kind) continue;
      total += biome.flora.weights?.[id] ?? 1;
      chosen.push(index);
      cumulative.push(total);
    }
    return { looks: chosen, cumulative, total };
  };
  return {
    looks,
    trees: data.biomes.entries.map((biome) => weighted(biome, 'tree')),
    shrubs: data.biomes.entries.map((biome) => weighted(biome, 'shrub')),
    rockChance: data.biomes.entries.map((biome) =>
      Object.hasOwn(data.decor.rocks, biome.id) ? data.decor.rocks[biome.id].chance : 0,
    ),
    rockLook,
    water: data.biomes.entries.map((biome) => biome.family === 'water'),
    depositLook,
    place: data.decor.place,
  };
}

/** L'apparence que choisit un tirage `unit` de [0, 1) parmi des apparences pondérées. */
export function pickLook(choices: WeightedLooks, unit: number): number {
  const target = unit * choices.total;
  for (let index = 0; index < choices.looks.length; index++) {
    if (target < (choices.cumulative.at(index) ?? 0)) return choices.looks.at(index) ?? -1;
  }
  return choices.looks.at(-1) ?? -1;
}

/** Nom de la clé de graine du décor, comme celui d'un flux du générateur (src/core/rng.ts). */
export const DECOR_STREAM = 'gen.decor';

/** Clé de graine du décor d'un monde : le premier mot de l'état du flux DECOR_STREAM. */
export function decorKey(seed: string): number {
  return streamSeed(seed, DECOR_STREAM)[0];
}

/** Un monde, tel que la pose le lit. */
export interface DecorWorld {
  readonly size: WorldSize;
  readonly layers: WorldLayers;
  readonly biomes: readonly Biome[];
  readonly table: DecorTable;
  /** Clé de graine du décor (decorKey). */
  readonly key: number;
}

/** Un objet posé dans sa case. */
export interface Placed {
  /** Son apparence (DecorTable.looks). */
  look: number;
  /** Tirage de sa variante, de 0 à 255 : le rendu prend la variante ⌊variant × n / 256⌋ de n. */
  variant: number;
  /** Ses pieds dans la case, en part de son côté, de 0 (ouest, nord) à 1. */
  fx: number;
  fy: number;
}

/** Tirages de la pose d'une case, toujours dans cet ordre. */
const DRAWS = 14;
const TWO_POW_32 = 4294967296;
const drawn = new Float64Array(DRAWS);

/** Les tirages de la case `cell` (indice, x ramené dans le monde), chacun dans [0, 1). */
function cellDraws(key: number, cell: number): Float64Array {
  const next = splitmix32(splitmix32((key ^ cell) >>> 0)());
  for (let index = 0; index < DRAWS; index++) drawn[index] = next() / TWO_POW_32;
  return drawn;
}

/** Une place de l'étendue [low, high], au tirage `unit`. */
function within([low, high]: readonly [number, number], unit: number): number {
  return low + (high - low) * unit;
}

/**
 * Les objets de la case (x, y), x ramené dans le monde, dans `out` (trois places au moins), du
 * fond vers l'avant : l'arbre, puis le buisson, puis le rocher ; renvoie leur nombre.
 * `landUse` est l'occupation du sol de la case (data/decor.json, landUse ; « none » avant la
 * phase 3) : la part de chaque sorte qu'elle garde.
 */
export function cellObjects(
  world: DecorWorld,
  x: number,
  y: number,
  landUse: LandUse,
  out: readonly Placed[],
): number {
  const { width, height } = world.size;
  if (y < 0 || y >= height) return 0;
  const cell = y * width + (((x % width) + width) % width);
  const { layers, table } = world;
  const biomeIndex = layers.biome[cell];
  const biome = world.biomes.at(biomeIndex);
  if (biome === undefined || table.water.at(biomeIndex) !== false) return 0;
  // Rien dans le lit d'une rivière ou d'un fleuve, qui coule au milieu de la case.
  if (riverClass(layers.drainage[cell]) >= 2) return 0;
  const t = cellDraws(world.key, cell);
  const { jitter, shrub, rock } = table.place;
  const centered = (unit: number) => 0.5 + (unit * 2 - 1) * jitter;
  const slot = (index: number): Placed => {
    const placed = out.at(index);
    if (placed === undefined) throw new RangeError('cellObjects : trois places au moins');
    return placed;
  };
  let count = 0;
  let treeX = -1;
  const trees = table.trees.at(biomeIndex);
  const treeChance = floraDensity(layers.trees[cell], biome.flora.trees) * landUse.trees;
  if (trees !== undefined && trees.looks.length > 0 && t[0] < treeChance) {
    const placed = slot(count++);
    placed.look = pickLook(trees, t[1]);
    placed.variant = Math.floor(t[2] * 256);
    placed.fx = centered(t[3]);
    placed.fy = centered(t[4]);
    treeX = placed.fx;
  }
  const shrubs = table.shrubs.at(biomeIndex);
  const shrubChance = floraDensity(layers.shrubs[cell], biome.flora.shrubs) * landUse.shrubs;
  if (shrubs !== undefined && shrubs.looks.length > 0 && t[5] < shrubChance) {
    const placed = slot(count++);
    placed.look = pickLook(shrubs, t[6]);
    placed.variant = Math.floor(t[7] * 256);
    if (treeX >= 0) {
      // À côté de l'arbre, et devant lui.
      const side = treeX > 0.5 ? -1 : 1;
      placed.fx = Math.min(0.9, Math.max(0.1, treeX + side * within(shrub.side, t[8])));
      placed.fy = within(shrub.depth, t[9]);
    } else {
      placed.fx = centered(t[8]);
      placed.fy = centered(t[9]);
    }
  }
  const deposit = layers.deposit[cell];
  let rockLook = deposit > 0 ? (table.depositLook.at(deposit - 1) ?? -1) : -1;
  if (rockLook >= 0 && t[10] >= landUse.rocks) rockLook = -1;
  else if (rockLook < 0 && t[10] < (table.rockChance.at(biomeIndex) ?? 0) * landUse.rocks) {
    rockLook = table.rockLook.at(biomeIndex) ?? -1;
  }
  if (rockLook >= 0) {
    const placed = slot(count++);
    placed.look = rockLook;
    placed.variant = Math.floor(t[11] * 256);
    // Du côté opposé à l'arbre.
    placed.fx = treeX < 0 ? centered(t[12]) : treeX > 0.5 ? 0.5 - rock.side : 0.5 + rock.side;
    placed.fy = within(rock.depth, t[13]);
  }
  return count;
}

/** Variante d'un objet parmi `count`, d'après son tirage (Placed.variant). */
export function variantOf(variant: number, count: number): number {
  return Math.min(count - 1, Math.max(0, (variant * count) >> 8));
}

/** États du feuillage d'un objet. */
export const DECOR_STATE = { summer: 0, autumn: 1, bare: 2, dry: 3 } as const;
export type DecorState = (typeof DECOR_STATE)[keyof typeof DECOR_STATE];

/** Ce qu'un instant donne à toutes les cases : le facteur de saison au nord, et sa tendance. */
export interface SeasonMoment {
  /** Mois continu, de 0 au début de janvier à 12. */
  readonly month: number;
  /** seasonFactor(mois) : 1 à la mi-juillet, −1 à la mi-janvier, au nord. */
  readonly factor: number;
  /** Le mois refroidit-il au nord, au sud ? */
  readonly coolingNorth: boolean;
  readonly coolingSouth: boolean;
}

/** Le moment de la saison du mois continu `month`, calculé une fois pour toute une collecte. */
export function seasonMoment(month: number): SeasonMoment {
  const factor = seasonFactor(month);
  const later = seasonFactor(month + 0.05);
  return { month, factor, coolingNorth: later < factor, coolingSouth: later > factor };
}

/** Ce que le feuillage d'une case connaît de son climat, à un moment de la saison. */
export interface FoliageClimate {
  /** Température du mois, et celles du mois le plus froid et du mois le plus chaud, en °C. */
  readonly monthly: number;
  readonly coldest: number;
  readonly warmest: number;
  /** Le mois refroidit-il dans l'hémisphère de la case ? */
  readonly cooling: boolean;
  /** Pluie du mois, en part de la moyenne annuelle. */
  readonly rain: number;
}

/**
 * Le climat du feuillage d'une case de température annuelle `annual` et de demi-amplitude
 * `amplitude` (°C), au sud ou non, à `rain` de force de la saison des pluies (rainSeasonality de
 * sa latitude), au moment `moment` : les formules de src/core/seasons.ts (C1, D8).
 */
export function foliageClimate(
  annual: number,
  amplitude: number,
  south: boolean,
  rain: number,
  moment: SeasonMoment,
): FoliageClimate {
  const sign = south ? -1 : 1;
  return {
    monthly: annual + amplitude * moment.factor * sign,
    coldest: annual - amplitude,
    warmest: annual + amplitude,
    cooling: south ? moment.coolingSouth : moment.coolingNorth,
    rain: 1 + rain * moment.factor * sign,
  };
}

/** L'état de saison d'un objet : son feuillage, et s'il est enneigé. */
export interface DecorSeason {
  readonly state: DecorState;
  readonly snowy: boolean;
}

/**
 * Point d'entrée des saisons du décor (ADR 0017, § 5), que 2b.7 enrichira : l'état d'un objet
 * de saisons `phenology`, sur une case de part de neige `snow` (de 0 à 1, celle que montre la
 * carte : src/render/seasons.ts, snowShare) et de climat `climate`, selon les seuils de
 * data/decor.json.
 * - Enneigé quand la part de neige atteint `snow.share`.
 * - Caduc : nu sous `bareBelow` ; en automne quand le mois refroidit, sous `autumnBelow`, et
 *   déjà `autumnDrop` au moins sous le mois le plus chaud (la feuille ne jaunit pas au pic de
 *   l'été, même là où l'été reste frais) ; feuillé sinon. Il garde ses feuilles toute l'année là
 *   où le mois le plus froid reste au-dessus de `bareBelow`.
 * - Sec : ses tons secs quand la pluie du mois tombe sous `dryShare` de la moyenne.
 * - Persistant : toujours feuillé.
 */
export function decorSeason(
  snow: number,
  phenology: Phenology,
  climate: FoliageClimate,
  rules: Pick<Decor, 'snow' | 'foliage'>,
): DecorSeason {
  const code = decorSeasonCode(
    snow,
    phenology,
    climate.monthly,
    climate.coldest,
    climate.warmest,
    climate.cooling,
    climate.rain,
    rules,
  );
  return { state: (code & 3) as DecorState, snowy: code >= 4 };
}

/**
 * decorSeason sans objet : le même état, codé `état + 4 × enneigé`, d'après les seules valeurs du
 * climat de la case au moment voulu (FoliageClimate). Le rendu l'appelle pour chaque objet de la
 * vue, à chaque jour : rien ne s'y alloue.
 */
export function decorSeasonCode(
  snow: number,
  phenology: Phenology,
  monthly: number,
  coldest: number,
  warmest: number,
  cooling: boolean,
  rain: number,
  rules: Pick<Decor, 'snow' | 'foliage'>,
): number {
  const snowy = snow > 0 && snow >= rules.snow.share ? 4 : 0;
  const { bareBelow, autumnBelow, autumnDrop, dryShare } = rules.foliage;
  if (phenology === 'deciduous' && coldest < bareBelow) {
    if (monthly < bareBelow) return DECOR_STATE.bare + snowy;
    if (cooling && monthly < autumnBelow && monthly <= warmest - autumnDrop) {
      return DECOR_STATE.autumn + snowy;
    }
  } else if (phenology === 'dry' && rain < dryShare) {
    return DECOR_STATE.dry + snowy;
  }
  return DECOR_STATE.summer + snowy;
}

/**
 * Le fruit se montre-t-il au mois continu `month`, sur une case du sud ou non ? Ses mois sont
 * ceux du nord ; le sud les vit six mois plus tard.
 */
export function fruiting(months: readonly number[], month: number, south: boolean): boolean {
  const local = Math.floor(month + (south ? 6 : 0)) % 12;
  return months.includes(local);
}

/** Les mois d'un fruit en masque, un bit par mois du nord (fruitingMask). */
export function monthMask(months: readonly number[]): number {
  return months.reduce((mask, month) => mask | (1 << month), 0);
}

/** fruiting, d'après le masque de ses mois (monthMask) : sans tableau, pour chaque objet. */
export function fruitingMask(mask: number, month: number, south: boolean): boolean {
  const local = Math.floor(month + (south ? 6 : 0)) % 12;
  return ((mask >> local) & 1) === 1;
}
