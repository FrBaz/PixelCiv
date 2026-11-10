/**
 * Hydrologie (tâche 1.4, MON-04, MON-07, MON-11 ; C1, D1 à D3).
 *
 * Un seul niveau de la mer sert partout. N'est mer que l'eau reliée à l'océan mondial
 * (D1) : la plus grande masse d'eau, et toute autre assez vaste. Les autres bassins,
 * même sous le niveau de la mer, relèvent des lacs (D2).
 */
import { MONTH_CENTERS, monthlyTemperature } from '../core/seasons';
import type { WorldSize } from '../core/world';
import { components, neighborTable } from './grid';

/**
 * Océan mondial (D1) : parmi les cases sous le niveau de la mer, la plus grande masse
 * d'eau connexe, et toute autre qui couvre au moins `minShare` de la carte.
 */
export function findOcean(
  elevation: Float32Array,
  size: WorldSize,
  minShare: number,
  neighbors: Int32Array = neighborTable(size),
): Uint8Array {
  const count = size.width * size.height;
  const water = new Uint8Array(count);
  for (let index = 0; index < count; index++) water[index] = (elevation[index] ?? 0) < 0 ? 1 : 0;
  const { labels, sizes } = components(water, size, neighbors);
  let largest = 0;
  for (let label = 1; label < sizes.length; label++) {
    if ((sizes[label] ?? 0) > (sizes[largest] ?? 0)) largest = label;
  }
  const minimum = minShare * count;
  const ocean = new Uint8Array(count);
  for (let index = 0; index < count; index++) {
    const label = labels[index] ?? 0;
    if (label !== 0 && (label === largest || (sizes[label] ?? 0) >= minimum)) ocean[index] = 1;
  }
  return ocean;
}

/** Réglages de l'hydrologie (data/worldgen.json). */
export interface HydrologyConfig {
  /** Surface minimale d'un lac, en cases d'une carte Grand (D2). */
  readonly lakeMinArea: number;
  /** Profondeur minimale d'un lac, en mètres (D2), mesurée après le comblement. */
  readonly lakeMinDepth: number;
  /**
   * Part de leur profondeur que les sédiments comblent dans les dépressions, avant la
   * formation des lacs : seuls les bassins profonds restent des lacs, les autres
   * deviennent des plaines drainées.
   */
  readonly infill: number;
  /** Sous ce rapport de l'apport à l'évaporation, le bassin est un salar (D2). */
  readonly saltFlatRatio: number;
  /** Part du bassin couverte par un salar. */
  readonly saltFlatShare: number;
  /**
   * Évaporation d'un lac : millimètres par an et par degré au-dessus de −10 °C, et
   * minimum ; puis un facteur d'humidité (D2), qui la baisse sous un air humide : la
   * pluie locale en sert d'indice, rapportée à `reference` millimètres, avec la force
   * `strength`, entre `min` et `max`.
   */
  readonly lakeEvaporation: {
    readonly perDegree: number;
    readonly minimum: number;
    readonly humidity: {
      readonly reference: number;
      readonly strength: number;
      readonly min: number;
      readonly max: number;
    };
  };
  /** Débit d'une rivière, en millimètres par an et par case d'une carte Grand (D3). */
  readonly riverThreshold: number;
  /** Multiples du seuil où commencent la rivière et le fleuve (D3 : 4 et 16). */
  readonly riverClasses: readonly [number, number];
}

export interface HydrologyParams {
  /** Densité du réseau hydrographique : le seuil des rivières se divise par elle. */
  readonly rivers: number;
}

/** Sortes de lacs (D2). */
export const LAKE = { none: 0, fresh: 1, salt: 2, saltFlat: 3 } as const;
export type LakeKind = (typeof LAKE)[keyof typeof LAKE];

/** Classes de rivières (D3), 0 hors des rivières. */
export const RIVER = { none: 0, stream: 1, river: 2, major: 3 } as const;

/** Aucune case aval : océan, ou cuvette d'un lac sans exutoire. */
export const NO_DIRECTION = 8;

export interface Hydrology {
  /** Océan mondial (D1). */
  readonly ocean: Uint8Array;
  /** Altitude remplie : les dépressions comblées, avec une pente minimale (m). */
  readonly filled: Float64Array;
  /** Case aval de chaque case, ou -1 ; et sa direction (0 à 7, NO_DIRECTION sinon). */
  readonly receiver: Int32Array;
  readonly direction: Uint8Array;
  /** Débit annuel accumulé, en millimètres par an et par case d'une carte Grand. */
  readonly flow: Float32Array;
  /** Lac de chaque case (LAKE), et altitude de sa surface (m, NaN hors des lacs). */
  readonly lake: Uint8Array;
  readonly lakeSurface: Float32Array;
  /** Classe de rivière de chaque case (RIVER). */
  readonly river: Uint8Array;
  /** Petites dépressions drainées, propices aux zones humides (D2, D5). */
  readonly smallDepression: Uint8Array;
  /** Altitude après comblement des dépressions par les sédiments (m). */
  readonly elevation: Float32Array;
}

/**
 * Pente minimale des zones comblées, en mètres par case (variante epsilon, D3), plus
 * autant par mètre de montée du relief d'origine.
 */
const EPSILON = 1e-5;
/**
 * Part de la pente minimale tirée au sort, case par case (de 0 à FILL_JITTER fois
 * EPSILON en plus) : le front du remplissage avance irrégulièrement, et les chenaux qui
 * le suivent à travers une cuvette ne filent pas en ligne droite.
 */
const FILL_JITTER = 2;
/**
 * Écart relatif de pente tiré au sort : chaque pente vers un voisin est multipliée par
 * un facteur de 0,5 à 1,5. L'eau descend toujours, mais sans filer tout droit.
 */
const SLOPE_JITTER = 1;
/** En deçà de cette profondeur de comblement (m), une case n'est pas dans une dépression. */
const DEPRESSION = 0.01;
/** Tours au plus du bilan des lacs : une chaîne de lacs se règle d'un maillon par tour. */
const MAX_BALANCE_PASSES = 32;

/**
 * Tas binaire de cases, ordonné par altitude remplie, puis par un tirage propre à
 * chaque case, puis par indice : l'ordre ne dépend que de la graine.
 */
class CellHeap {
  private readonly cells: Int32Array;
  private size = 0;
  private readonly key: Float64Array;
  private readonly tie: Uint32Array;

  constructor(capacity: number, key: Float64Array, tie: Uint32Array) {
    this.cells = new Int32Array(capacity);
    this.key = key;
    this.tie = tie;
  }

  get length(): number {
    return this.size;
  }

  private less(a: number, b: number): boolean {
    const ka = this.key[a] ?? 0;
    const kb = this.key[b] ?? 0;
    if (ka !== kb) return ka < kb;
    const ta = this.tie[a] ?? 0;
    const tb = this.tie[b] ?? 0;
    if (ta !== tb) return ta < tb;
    return a < b;
  }

  push(cell: number): void {
    const cells = this.cells;
    let position = this.size++;
    while (position > 0) {
      const parent = (position - 1) >> 1;
      const above = cells[parent] ?? 0;
      if (!this.less(cell, above)) break;
      cells[position] = above;
      position = parent;
    }
    cells[position] = cell;
  }

  pop(): number {
    const cells = this.cells;
    const top = cells[0];
    const last = cells[--this.size] ?? 0;
    let position = 0;
    const size = this.size;
    for (;;) {
      const left = 2 * position + 1;
      if (left >= size) break;
      const right = left + 1;
      let child = left;
      if (right < size && this.less(cells[right] ?? 0, cells[left] ?? 0)) child = right;
      const smallest = cells[child] ?? 0;
      if (!this.less(smallest, last)) break;
      cells[position] = smallest;
      position = child;
    }
    if (size > 0) cells[position] = last;
    return top;
  }
}

/**
 * Comble les dépressions depuis l'océan seul (priority flood, variante epsilon) : chaque
 * case reçoit au moins l'altitude de la case d'où l'eau l'atteint, plus une pente
 * minimale. Renvoie l'altitude remplie et, pour chaque case, la case voisine plus basse
 * par laquelle l'eau la quitte sur la surface remplie.
 */
function priorityFlood(
  elevation: Float32Array,
  ocean: Uint8Array,
  neighbors: Int32Array,
  tie: Uint32Array,
): { filled: Float64Array; parent: Int32Array } {
  const count = elevation.length;
  const filled = new Float64Array(count);
  const parent = new Int32Array(count).fill(-1);
  const visited = new Uint8Array(count);
  const heap = new CellHeap(count, filled, tie);
  for (let index = 0; index < count; index++) {
    filled[index] = elevation[index] ?? 0;
    if (!ocean[index]) continue;
    visited[index] = 1;
    // Seules les cases d'océan qui touchent une autre case lancent le remplissage.
    for (let direction = 0; direction < 8; direction++) {
      const other = neighbors[index * 8 + direction] ?? -1;
      if (other >= 0 && !ocean[other]) {
        heap.push(index);
        break;
      }
    }
  }
  // Sans océan, la plus basse des cases tient lieu d'exutoire.
  if (heap.length === 0 && count > 0) {
    let lowest = 0;
    for (let index = 1; index < count; index++) {
      if ((elevation[index] ?? 0) < (elevation[lowest] ?? 0)) lowest = index;
    }
    visited[lowest] = 1;
    heap.push(lowest);
  }
  const popped = new Uint8Array(count);
  while (heap.length > 0) {
    const cell = heap.pop();
    popped[cell] = 1;
    // Au moment de traiter la case, tous ses voisins plus bas qu'elle sont traités : elle
    // s'écoule vers le plus bas d'entre eux sur le relief d'origine, pourvu que son
    // altitude remplie soit plus basse. Sur une zone comblée, l'eau suit ainsi les vallées
    // enfouies, au lieu de filer droit vers l'exutoire.
    if (!ocean[cell]) {
      let best = parent[cell] ?? -1;
      const level = filled[cell] ?? 0;
      for (let direction = 0; direction < 8; direction++) {
        const other = neighbors[cell * 8 + direction] ?? -1;
        if (other < 0 || !popped[other] || other === best || (filled[other] ?? 0) >= level)
          continue;
        const lower =
          best < 0 ||
          (elevation[other] ?? 0) < (elevation[best] ?? 0) ||
          ((elevation[other] ?? 0) === (elevation[best] ?? 0) &&
            (tie[other] ?? 0) < (tie[best] ?? 0));
        if (lower) best = other;
      }
      parent[cell] = best;
    }
    const base = filled[cell] ?? 0;
    const here = elevation[cell] ?? 0;
    for (let direction = 0; direction < 8; direction++) {
      const other = neighbors[cell * 8 + direction] ?? -1;
      if (other < 0 || visited[other]) continue;
      visited[other] = 1;
      // Pente minimale : EPSILON, plus un supplément quand la case est plus haute sur le
      // relief d'origine. Le remplissage avance plus vite le long des vallées enfouies, et
      // le chemin de l'eau à travers une zone comblée les suit, au lieu de filer droit.
      const climb = Math.max(0, (elevation[other] ?? 0) - here);
      // Un tirage propre à la case, décorrélé de celui qui départage le tas.
      const draw = (Math.imul(tie[other] ?? 0, 0x9e3779b1) >>> 0) / 4294967296;
      filled[other] = Math.max(
        filled[other] ?? 0,
        base + EPSILON * (1 + climb + FILL_JITTER * draw),
      );
      parent[other] = cell;
      heap.push(other);
    }
  }
  return { filled, parent };
}

/**
 * Plus forte pente de `surface` depuis la case `index`, vers un voisin strictement plus
 * bas, diagonales comptées √2 ; -1 si aucun voisin n'est plus bas. Un léger tirage propre
 * à chaque voisin départage les pentes voisines : sur un versant régulier, l'eau ne file
 * pas tout droit sur des dizaines de cases.
 */
function steepest(
  index: number,
  surface: ArrayLike<number>,
  neighbors: Int32Array,
  tie: Uint32Array,
): number {
  const level = surface[index] ?? 0;
  let best = -1;
  let steepestSlope = 0;
  for (let d = 0; d < 8; d++) {
    const other = neighbors[index * 8 + d] ?? -1;
    if (other < 0) continue;
    const drop = level - (surface[other] ?? 0);
    if (drop <= 0) continue;
    const jitter = 1 + SLOPE_JITTER * ((tie[other] ?? 0) / 4294967296 - 0.5);
    const slope = (drop / (d % 2 === 0 ? 1 : Math.SQRT2)) * jitter;
    if (slope > steepestSlope) {
      steepestSlope = slope;
      best = other;
    }
  }
  return best;
}

/**
 * Case aval de chaque case.
 *
 * Hors des dépressions, l'eau suit la plus forte pente de l'altitude remplie. Dans une
 * dépression comblée, elle descend le relief enfoui jusqu'à un fond, puis gagne
 * l'exutoire par un chenal : le chemin du remplissage, depuis chaque fond. Pas de
 * tronçon rectiligne à travers les cuvettes (D3), et pas de boucle : hors des chenaux,
 * chaque pas descend le relief ; un chenal descend l'altitude remplie et ne revient pas
 * dans sa dépression.
 */
function receivers(
  elevation: Float32Array,
  ocean: Uint8Array,
  filled: Float64Array,
  parent: Int32Array,
  neighbors: Int32Array,
  tie: Uint32Array,
): { receiver: Int32Array; direction: Uint8Array } {
  const count = elevation.length;
  const inDepression = (index: number) =>
    !ocean[index] && (filled[index] ?? 0) - (elevation[index] ?? 0) > DEPRESSION;
  // Chenaux : depuis chaque fond d'une dépression, le chemin du remplissage jusqu'au bord.
  const channel = new Uint8Array(count);
  for (let index = 0; index < count; index++) {
    if (!inDepression(index) || steepest(index, elevation, neighbors, tie) >= 0) continue;
    let cell = index;
    while (cell >= 0 && inDepression(cell) && !channel[cell]) {
      channel[cell] = 1;
      cell = parent[cell] ?? -1;
    }
  }
  const receiver = new Int32Array(count).fill(-1);
  const direction = new Uint8Array(count).fill(NO_DIRECTION);
  for (let index = 0; index < count; index++) {
    if (ocean[index]) continue;
    let best: number;
    if (channel[index]) best = parent[index] ?? -1;
    else if (inDepression(index)) best = steepest(index, elevation, neighbors, tie);
    else best = steepest(index, filled, neighbors, tie);
    // Sans voisin plus bas (bord des pôles), l'eau suit le chemin du remplissage.
    if (best < 0) best = parent[index] ?? -1;
    receiver[index] = best;
    if (best >= 0) {
      for (let d = 0; d < 8; d++) {
        if (neighbors[index * 8 + d] === best) {
          direction[index] = d;
          break;
        }
      }
    }
  }
  return { receiver, direction };
}

/**
 * Ruissellement annuel (mm) : la pluie moins l'évapotranspiration réelle, par la formule
 * de Turc et Pike, ET = P / √(1 + (P / ETP)²). L'évapotranspiration potentielle croît
 * avec la température. Un désert ne ruisselle presque pas ; un climat froid et humide
 * ruisselle presque toute sa pluie.
 */
export function runoff(precipitation: number, temperature: number): number {
  const potential = Math.max(
    POTENTIAL_EVAPORATION.minimum,
    POTENTIAL_EVAPORATION.perDegree * (temperature + 5),
  );
  const ratio = precipitation / potential;
  return precipitation - precipitation / Math.sqrt(1 + ratio * ratio);
}

/** Évapotranspiration potentielle (mm par an) : par degré au-dessus de −5 °C, et minimum. */
const POTENTIAL_EVAPORATION = { perDegree: 50, minimum: 100 };

/**
 * Évaporation annuelle d'une case de lac (mm) : elle croît avec la température et baisse
 * avec l'humidité de l'air, dont la pluie locale donne l'indice (D2).
 */
export function lakeEvaporation(
  config: HydrologyConfig,
  temperature: number,
  precipitation: number,
  amplitude = 0,
): number {
  const { perDegree, minimum, humidity } = config.lakeEvaporation;
  // Un lac gelé n'évapore pas : le minimum ne vaut que pour la part de l'année au-dessus
  // de 0 °C. Une cuvette polaire, toujours gelée, reste ainsi un lac d'eau douce.
  const base = Math.max(
    minimum * thawedShare(temperature, amplitude),
    perDegree * (temperature + 10),
  );
  const dryness = 1 + humidity.strength * (1 - precipitation / humidity.reference);
  return base * Math.min(humidity.max, Math.max(humidity.min, dryness));
}

/**
 * Part de l'année où la température dépasse 0 °C, pour une moyenne `annual` et une
 * demi-amplitude `amplitude` (D8) : la part des douze mois, pris en leur milieu, au-dessus
 * de 0 °C.
 */
export function thawedShare(annual: number, amplitude: number): number {
  let thawed = 0;
  for (const month of MONTH_CENTERS) {
    if (monthlyTemperature(annual, amplitude, false, month) > 0) thawed++;
  }
  return thawed / 12;
}

interface Basin {
  readonly cells: number[];
  readonly maxDepth: number;
  /** Évaporation de tout le bassin, rempli jusqu'à son exutoire. */
  readonly evaporation: number;
  significant: boolean;
  kind: LakeKind;
  inflow: number;
}

/** Hydrologie complète : océan, écoulement, lacs et rivières. */
export function generateHydrology(
  size: WorldSize,
  raw: Float32Array,
  ocean: Uint8Array,
  temperature: Float32Array,
  precipitation: Float32Array,
  random: { nextUint32(): number },
  config: HydrologyConfig,
  params: HydrologyParams,
  amplitude?: Float32Array,
  neighbors: Int32Array = neighborTable(size),
): Hydrology {
  const count = size.width * size.height;
  // Les surfaces et les débits se comptent en cases d'une carte Grand.
  const scale = 1024 / size.width;
  const cellArea = scale * scale;
  const tie = new Uint32Array(count);
  for (let index = 0; index < count; index++) tie[index] = random.nextUint32();
  // Exutoires : l'océan, et le bord des pôles, où l'eau quitte la carte (sous la calotte
  // ou dans la mer polaire) au lieu d'en longer le bord tout droit.
  const outlet = Uint8Array.from(ocean);
  for (let x = 0; x < size.width; x++) {
    outlet[x] = 1;
    outlet[(size.height - 1) * size.width + x] = 1;
  }
  const { filled, parent } = priorityFlood(raw, outlet, neighbors, tie);
  // Les sédiments comblent une part de chaque dépression. L'altitude remplie ne change
  // pas, ni donc l'ordre du remplissage : il suffit de relever le fond.
  const elevation = new Float32Array(raw);
  for (let index = 0; index < count; index++) {
    const value = raw[index] ?? 0;
    const depth = (filled[index] ?? 0) - value;
    if (!ocean[index] && depth > DEPRESSION) elevation[index] = value + config.infill * depth;
  }
  const { receiver, direction } = receivers(elevation, outlet, filled, parent, neighbors, tie);

  // Bassins : composantes des cases comblées de plus de DEPRESSION.
  const depression = new Uint8Array(count);
  for (let index = 0; index < count; index++) {
    if (!outlet[index] && (filled[index] ?? 0) - (elevation[index] ?? 0) > DEPRESSION)
      depression[index] = 1;
  }
  const { labels, sizes } = components(depression, size, neighbors);
  const basins: Basin[] = [];
  const members: number[][] = sizes.map(() => []);
  for (let index = 0; index < count; index++) {
    const label = labels[index] ?? 0;
    if (label !== 0) members[label]?.push(index);
  }
  for (let label = 1; label < sizes.length; label++) {
    const cells = members[label] ?? [];
    let maxDepth = 0;
    let evaporation = 0;
    for (const index of cells) {
      maxDepth = Math.max(maxDepth, (filled[index] ?? 0) - (elevation[index] ?? 0));
      evaporation += lakeEvaporation(
        config,
        temperature[index] ?? 0,
        precipitation[index] ?? 0,
        amplitude?.[index] ?? 0,
      );
    }
    const significant =
      cells.length * cellArea >= config.lakeMinArea && maxDepth >= config.lakeMinDepth;
    basins.push({
      cells,
      maxDepth,
      evaporation: evaporation * cellArea,
      significant,
      kind: significant ? LAKE.fresh : LAKE.none,
      inflow: 0,
    });
  }

  // Ruissellement de chaque case, en mm par an et par case Grand.
  const water = new Float64Array(count);
  for (let index = 0; index < count; index++) {
    if (!ocean[index]) {
      water[index] = runoff(precipitation[index] ?? 0, temperature[index] ?? 0) * cellArea;
    }
  }

  // Accumulation, de l'amont vers l'aval. Un lac salé ou un salar garde tout ce qui lui
  // parvient ; un lac d'eau douce perd son évaporation. Le type et l'apport d'un lac
  // dépendent des lacs en amont : on recommence jusqu'à ce que types et apports ne
  // bougent plus (D2), une chaîne de lacs se réglant d'un maillon par tour.
  for (let pass = 0; pass < MAX_BALANCE_PASSES; pass++) {
    const inflow = new Float64Array(basins.length + 1);
    accumulate(receiver, water, labels, basins, inflow);
    let changed = false;
    for (const [offset, basin] of basins.entries()) {
      const next = inflow[offset + 1] ?? 0;
      if (Math.abs(next - basin.inflow) > 1e-6 * Math.max(1, Math.abs(next))) changed = true;
      basin.inflow = next;
      if (!basin.significant) continue;
      const ratio = basin.inflow / basin.evaporation;
      const kind =
        ratio >= 1 ? LAKE.fresh : ratio >= config.saltFlatRatio ? LAKE.salt : LAKE.saltFlat;
      if (kind !== basin.kind) {
        basin.kind = kind;
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Lacs : un lac d'eau douce remplit son bassin jusqu'à l'exutoire ; un lac salé n'en
  // remplit que la partie basse, celle que son apport entretient ; un salar couvre le fond.
  const lake = new Uint8Array(count);
  const lakeSurface = new Float32Array(count).fill(Number.NaN);
  const smallDepression = new Uint8Array(count);
  const level = new Float64Array(count);
  for (const [offset, basin] of basins.entries()) {
    if (!basin.significant) {
      for (const index of basin.cells) smallDepression[index] = 1;
      continue;
    }
    let chosen = basin.cells;
    let surface = Number.NEGATIVE_INFINITY;
    if (basin.kind !== LAKE.fresh) {
      const ratio = basin.inflow / basin.evaporation;
      const share = basin.kind === LAKE.salt ? ratio : config.saltFlatShare;
      const minimum = Math.ceil(config.lakeMinArea / cellArea);
      const keep = Math.min(
        basin.cells.length,
        Math.max(minimum, Math.round(share * basin.cells.length)),
      );
      const part = lowestPart(
        basin.cells,
        offset + 1,
        keep,
        labels,
        elevation,
        neighbors,
        tie,
        level,
      );
      chosen = part.cells;
      surface = part.surface;
    } else {
      for (const index of chosen) surface = Math.max(surface, filled[index] ?? 0);
    }
    for (const index of chosen) {
      lake[index] = basin.kind;
      if (basin.kind !== LAKE.saltFlat) lakeSurface[index] = surface;
    }
  }

  // Un bassin sans exutoire (lac salé, salar) garde son eau : elle y descend vers le lac,
  // au lieu de gagner le bord par le chemin du remplissage.
  const local = new Int32Array(count).fill(-1);
  for (const basin of basins) {
    if (basin.significant && basin.kind !== LAKE.fresh) {
      routeToLake(basin.cells, lake, elevation, neighbors, tie, local, receiver, direction);
    }
  }
  const final = accumulate(receiver, water, labels, basins);

  // Rivières (D3) : au-delà du seuil, ruisseau, rivière, puis fleuve.
  const threshold = config.riverThreshold / params.rivers;
  const [riverFrom, majorFrom] = config.riverClasses;
  const river = new Uint8Array(count);
  const result = new Float32Array(count);
  for (let index = 0; index < count; index++) {
    const value = final[index] ?? 0;
    result[index] = value;
    if (ocean[index] || lake[index] !== LAKE.none) continue;
    if (value >= majorFrom * threshold) river[index] = RIVER.major;
    else if (value >= riverFrom * threshold) river[index] = RIVER.river;
    else if (value >= threshold) river[index] = RIVER.stream;
  }
  return {
    ocean,
    filled,
    receiver,
    direction,
    flow: result,
    lake,
    lakeSurface,
    river,
    smallDepression,
    elevation,
  };
}

/**
 * Refait l'écoulement d'un bassin sans exutoire comme celui du reste de la carte, son lac
 * (ou son salar) tenant lieu de mer : un remplissage parti du lac, avec la pente minimale
 * et le choix des vallées enfouies de `priorityFlood`, puis la plus forte pente, à travers
 * les cuvettes internes par leurs chenaux (`receivers`). L'eau descend ainsi les vallées
 * du bassin jusqu'au lac, sans filer en ligne droite. Le calcul se fait sur les seules
 * cases du bassin ; `local` sert de table de travail, remise à -1 après usage.
 */
function routeToLake(
  cells: readonly number[],
  lake: Uint8Array,
  elevation: Float32Array,
  neighbors: Int32Array,
  tie: Uint32Array,
  local: Int32Array,
  receiver: Int32Array,
  direction: Uint8Array,
): void {
  const count = cells.length;
  cells.forEach((cell, index) => {
    local[cell] = index;
  });
  const subElevation = new Float32Array(count);
  const subOutlet = new Uint8Array(count);
  const subTie = new Uint32Array(count);
  const subNeighbors = new Int32Array(count * 8).fill(-1);
  cells.forEach((cell, index) => {
    subElevation[index] = elevation[cell] ?? 0;
    subOutlet[index] = lake[cell] !== LAKE.none ? 1 : 0;
    subTie[index] = tie[cell] ?? 0;
    for (let d = 0; d < 8; d++) {
      const other = neighbors[cell * 8 + d] ?? -1;
      subNeighbors[index * 8 + d] = other >= 0 ? (local[other] ?? -1) : -1;
    }
  });
  const { filled, parent } = priorityFlood(subElevation, subOutlet, subNeighbors, subTie);
  const routed = receivers(subElevation, subOutlet, filled, parent, subNeighbors, subTie);
  cells.forEach((cell, index) => {
    const next = routed.receiver[index] ?? -1;
    receiver[cell] = next >= 0 ? (cells[next] ?? -1) : -1;
    direction[cell] = routed.direction[index] ?? NO_DIRECTION;
  });
  for (const cell of cells) local[cell] = -1;
}

/**
 * Débits : chaque case reçoit son ruissellement et tout ce qui coule de l'amont, dans
 * l'ordre de l'écoulement (tri topologique de Kahn, par indice croissant à égalité). Un
 * lac d'eau douce perd son évaporation à son exutoire ; un lac salé et un salar, puits de
 * leur bassin, ne laissent rien repartir.
 */
function accumulate(
  receiver: Int32Array,
  runoff: Float64Array,
  labels: Int32Array,
  basins: readonly Basin[],
  inflow?: Float64Array,
): Float64Array {
  const count = receiver.length;
  const flow = Float64Array.from(runoff);
  const pending = new Int32Array(count);
  for (let index = 0; index < count; index++) {
    const target = receiver[index] ?? -1;
    if (target >= 0) pending[target] = (pending[target] ?? 0) + 1;
  }
  const queue = new Int32Array(count);
  let head = 0;
  let tail = 0;
  for (let index = 0; index < count; index++) if (pending[index] === 0) queue[tail++] = index;
  while (head < tail) {
    const cell = queue[head++] ?? 0;
    const target = receiver[cell] ?? -1;
    if (target < 0) continue;
    let passing = flow[cell] ?? 0;
    const label = labels[cell] ?? 0;
    if (label !== 0 && labels[target] !== label) {
      // Sortie d'un bassin : tout son apport passe par ses sorties.
      if (inflow !== undefined) inflow[label] = (inflow[label] ?? 0) + passing;
      const basin = basins[label - 1];
      if (basin.significant) {
        if (basin.kind === LAKE.fresh) {
          passing *= Math.max(0, 1 - basin.evaporation / Math.max(basin.inflow, 1e-9));
        } else {
          passing = 0;
        }
      }
    }
    flow[target] = (flow[target] ?? 0) + passing;
    pending[target] = (pending[target] ?? 0) - 1;
    if (pending[target] === 0) queue[tail++] = target;
  }
  return flow;
}

/**
 * Partie basse d'un bassin, en vraie nappe d'eau : un remplissage parti de sa case la
 * plus basse range les cases par le niveau d'eau qui les atteint (l'altitude la plus
 * haute du chemin le plus bas). Un lac à un niveau couvre toutes les cases que ce
 * niveau atteint : au-delà d'un seuil, la cuvette suivante se remplit d'un coup. La
 * partie basse est donc faite de niveaux entiers, au plus près de `keep` cases ; aucune
 * case sèche voisine n'est plus basse que sa surface, qui est renvoyée avec elle.
 */
function lowestPart(
  cells: readonly number[],
  label: number,
  keep: number,
  labels: Int32Array,
  elevation: Float32Array,
  neighbors: Int32Array,
  tie: Uint32Array,
  level: Float64Array,
): { cells: number[]; surface: number } {
  let lowest = cells[0] ?? 0;
  for (const index of cells) {
    const value = elevation[index] ?? 0;
    const best = elevation[lowest] ?? 0;
    if (value < best || (value === best && index < lowest)) lowest = index;
  }
  const heap = new CellHeap(cells.length, level, tie);
  const reached = new Set<number>([lowest]);
  level[lowest] = elevation[lowest] ?? 0;
  heap.push(lowest);
  const order: number[] = [];
  while (heap.length > 0) {
    const cell = heap.pop();
    order.push(cell);
    const here = level[cell] ?? 0;
    for (let d = 0; d < 8; d++) {
      const other = neighbors[cell * 8 + d] ?? -1;
      if (other < 0 || labels[other] !== label || reached.has(other)) continue;
      reached.add(other);
      level[other] = Math.max(elevation[other] ?? 0, here);
      heap.push(other);
    }
  }
  // Niveaux entiers : on s'arrête au bout d'un niveau, celui qui approche le mieux `keep`.
  let taken = 0;
  let surface = level[lowest] ?? 0;
  while (taken < order.length) {
    const value = level[order[taken] ?? 0] ?? 0;
    let end = taken;
    while (end < order.length && level[order[end] ?? 0] === value) end++;
    if (taken > 0 && end > keep && end - keep > keep - taken) break;
    taken = end;
    surface = value;
    if (taken >= keep) break;
  }
  return { cells: order.slice(0, taken), surface };
}
