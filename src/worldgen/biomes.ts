/**
 * Biomes naturels (tâche 1.5, MON-08, MON-12, MON-13 ; C1, D4 à D6 et D13).
 *
 * Chaque case reçoit un des 32 biomes de data/biomes.json, dans cet ordre de priorité :
 * mer (selon sa profondeur), lac (selon son bilan hydrique), glacier (là où le mois le
 * plus chaud reste sous 0 °C), fleuve, côte (la seule rangée de terres au contact de la
 * mer), zone humide, puis terres (selon les mois le plus chaud et le plus froid, les
 * précipitations et l'altitude). Les règles de chaque étape sont des données
 * (data/worldgen.json) : la première qui convient l'emporte.
 */
import type { Catalog } from '../core/data/catalog';
import type { Biome } from '../core/data/schemas';
import {
  CLIMATE_VARIABLES,
  type ClassificationRule,
  type ClimateVariable,
  type Worldgen,
} from '../core/data/worldgen';
import type { Rng } from '../core/rng';
import type { WorldSize } from '../core/world';
import { extremeMonths, type Climate } from './climate';
import { distanceField, neighborTable } from './grid';
import { LAKE, RIVER, type Hydrology } from './hydrology';
import { NoiseLayer, type CylinderSampler } from './sampler';

/** Règle compilée : l'indice du biome et ses bornes, variable par variable. */
interface CompiledRule {
  readonly biome: number;
  readonly checks: readonly { variable: number; min: number; max: number }[];
}

function compile(rule: ClassificationRule, biomes: Catalog<Biome>): CompiledRule {
  const biome = biomes.indexOf(rule.biome);
  if (biome === undefined) throw new Error(`biome inconnu : ${rule.biome}`);
  const checks = Object.entries(rule.when ?? {}).map(([name, range]) => ({
    variable: CLIMATE_VARIABLES.indexOf(name as ClimateVariable),
    min: range[0] ?? Number.NEGATIVE_INFINITY,
    max: range[1] ?? Number.POSITIVE_INFINITY,
  }));
  return { biome, checks };
}

function matches(rule: CompiledRule, values: Float64Array): boolean {
  for (const check of rule.checks) {
    const value = values[check.variable] ?? 0;
    if (!(value >= check.min && value < check.max)) return false;
  }
  return true;
}

/** Biome de la première règle qui convient ; la dernière règle n'a pas de condition. */
function classify(rules: readonly CompiledRule[], values: Float64Array): number {
  for (const rule of rules) if (matches(rule, values)) return rule.biome;
  return rules.at(-1)?.biome ?? 0;
}

/** Rang de chaque valeur retenue parmi les valeurs retenues, de 0 à 1 ; NaN ailleurs. */
function ranks(values: Float64Array, keep: (index: number) => boolean): Float64Array {
  const selected: number[] = [];
  for (let index = 0; index < values.length; index++) if (keep(index)) selected.push(index);
  selected.sort((a, b) => (values[a] ?? 0) - (values[b] ?? 0) || a - b);
  const result = new Float64Array(values.length).fill(Number.NaN);
  const last = Math.max(1, selected.length - 1);
  // Des valeurs égales prennent le même rang : le premier de leur groupe.
  let start = 0;
  for (let position = 0; position < selected.length; position++) {
    const index = selected[position] ?? 0;
    if (position > 0 && values[selected[position - 1] ?? 0] !== values[index]) start = position;
    result[index] = start / last;
  }
  return result;
}

/** Ouverture morphologique par un carré de 2 × 2 : efface les cases isolées (D5). */
function opening(mask: Uint8Array, size: WorldSize): Uint8Array {
  const { width, height } = size;
  const at = (x: number, y: number) => y * width + ((x + width) % width);
  const eroded = new Uint8Array(mask.length);
  for (let y = 0; y + 1 < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[at(x, y)] && mask[at(x + 1, y)] && mask[at(x, y + 1)] && mask[at(x + 1, y + 1)]) {
        eroded[at(x, y)] = 1;
      }
    }
  }
  const result = new Uint8Array(mask.length);
  for (let y = 0; y + 1 < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!eroded[at(x, y)]) continue;
      result[at(x, y)] = 1;
      result[at(x + 1, y)] = 1;
      result[at(x, y + 1)] = 1;
      result[at(x + 1, y + 1)] = 1;
    }
  }
  return result;
}

export interface BiomeLayers {
  /** Biome de chaque case : indice dans data/biomes.json. */
  readonly biome: Uint8Array;
  /** Classes de rivières, sans celles des glaciers : une calotte n'a pas de rivière. */
  readonly river: Uint8Array;
}

/** Biome de chaque case. */
export function classifyBiomes(
  sampler: CylinderSampler,
  rng: Rng,
  elevation: Float32Array,
  climate: Climate,
  hydrology: Hydrology,
  worldgen: Worldgen,
  biomes: Catalog<Biome>,
): BiomeLayers {
  const size: WorldSize = { width: sampler.width, height: sampler.height };
  const count = size.width * size.height;
  const neighbors = neighborTable(size);
  const { classification, aridity, coasts, wetlands } = worldgen;
  const oceanRules = classification.ocean.map((rule) => compile(rule, biomes));
  const coastRules = classification.coast.map((rule) => compile(rule, biomes));
  const wetlandRules = classification.wetland.map((rule) => compile(rule, biomes));
  const landRules = classification.land.map((rule) => compile(rule, biomes));
  const glacierRule = compile(classification.glacier, biomes);
  const index = (id: string) => {
    const found = biomes.indexOf(id);
    if (found === undefined) throw new Error(`biome inconnu : ${id}`);
    return found;
  };
  const lakeBiomes: Readonly<Record<number, number>> = {
    [LAKE.fresh]: index(classification.lakes.fresh),
    [LAKE.salt]: index(classification.lakes.salt),
    [LAKE.saltFlat]: index(classification.lakes.saltFlat),
  };
  const riverBiome = index(classification.river);
  const { ocean, lake } = hydrology;
  const land = (cell: number) => !ocean[cell] && lake[cell] === LAKE.none;

  // Côtes : les terres qui touchent la mer, en 8-connexité (D4).
  const coastal = new Uint8Array(count);
  for (let cell = 0; cell < count; cell++) {
    if (!land(cell)) continue;
    for (let d = 0; d < 8; d++) {
      const other = neighbors[cell * 8 + d] ?? -1;
      if (other >= 0 && ocean[other]) {
        coastal[cell] = 1;
        break;
      }
    }
  }

  // Pente : plus forte descente vers un voisin (m par case), rangée parmi les terres.
  const slopeValue = new Float64Array(count);
  for (let cell = 0; cell < count; cell++) {
    const here = elevation[cell] ?? 0;
    let steepest = 0;
    for (let d = 0; d < 8; d++) {
      const other = neighbors[cell * 8 + d] ?? -1;
      if (other < 0) continue;
      const drop =
        Math.abs(here - Math.max(0, elevation[other] ?? 0)) / (d % 2 === 0 ? 1 : Math.SQRT2);
      steepest = Math.max(steepest, drop);
    }
    slopeValue[cell] = steepest;
  }
  const slope = ranks(slopeValue, land);

  // Relief côtier : altitude la plus haute dans un rayon de quelques cases, rangée parmi
  // les côtes (D4 : falaise au-delà du 88e centile, côte rocheuse au-delà du 70e).
  const { width, height } = size;
  const radius = coasts.reliefRadius;
  const reliefValue = new Float64Array(count);
  for (let cell = 0; cell < count; cell++) {
    if (!coastal[cell]) continue;
    const x = cell % width;
    const y = (cell - x) / width;
    let highest = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      const row = y + dy;
      if (row < 0 || row >= height) continue;
      for (let dx = -radius; dx <= radius; dx++) {
        highest = Math.max(highest, elevation[row * width + ((x + dx + width) % width)] ?? 0);
      }
    }
    reliefValue[cell] = highest;
  }
  const relief = ranks(reliefValue, (cell) => coastal[cell] === 1);

  // Zones humides (D5) : terres plates, basses et humides, près d'une eau ou dans une
  // petite cuvette drainée, découpées en taches par un bruit, sans case isolée.
  const water = new Uint8Array(count);
  for (let cell = 0; cell < count; cell++) {
    water[cell] =
      ocean[cell] || lake[cell] === LAKE.fresh || lake[cell] === LAKE.salt || hydrology.river[cell]
        ? 1
        : 0;
  }
  const waterDistance = distanceField(water, size, neighbors);
  const nearWater = (wetlands.waterDistance * size.width) / 1024;
  const patches = sampler.fractal(new NoiseLayer(rng.stream('worldgen.wetlands')), {
    frequency: wetlands.patchFrequency,
    octaves: 3,
  });
  const candidate = new Uint8Array(count);
  for (let cell = 0; cell < count; cell++) {
    if (!land(cell) || coastal[cell] || hydrology.river[cell] === RIVER.major) continue;
    const close = (waterDistance[cell] ?? 0) <= nearWater || hydrology.smallDepression[cell] === 1;
    if (
      close &&
      (slope[cell] ?? 1) <= wetlands.maxSlope &&
      (elevation[cell] ?? 0) <= wetlands.maxAltitude &&
      (climate.precipitation[cell] ?? 0) >= wetlands.minPrecipitation &&
      ((patches[cell] ?? 0) + 1) / 2 > wetlands.patchThreshold
    ) {
      candidate[cell] = 1;
    }
  }
  const wetland = opening(candidate, size);

  // Classement.
  const biome = new Uint8Array(count);
  const river = Uint8Array.from(hydrology.river);
  const values = new Float64Array(CLIMATE_VARIABLES.length);
  const variable = (name: ClimateVariable) => CLIMATE_VARIABLES.indexOf(name);
  const slots = {
    temperature: variable('temperature'),
    warmest: variable('warmest'),
    coldest: variable('coldest'),
    precipitation: variable('precipitation'),
    aridity: variable('aridity'),
    altitude: variable('altitude'),
    relief: variable('relief'),
    slope: variable('slope'),
  };
  for (let cell = 0; cell < count; cell++) {
    const temperature = climate.temperature[cell] ?? 0;
    const { warmest, coldest } = extremeMonths(temperature, climate.amplitude[cell] ?? 0);
    const precipitation = climate.precipitation[cell] ?? 0;
    values[slots.temperature] = temperature;
    values[slots.warmest] = warmest;
    values[slots.coldest] = coldest;
    values[slots.precipitation] = precipitation;
    values[slots.aridity] =
      precipitation / Math.max(aridity.minimum, aridity.base + aridity.perDegree * temperature);
    values[slots.altitude] = elevation[cell] ?? 0;
    values[slots.relief] = relief[cell] ?? Number.NaN;
    values[slots.slope] = slope[cell] ?? Number.NaN;
    if (ocean[cell]) {
      biome[cell] = classify(oceanRules, values);
      continue;
    }
    const lakeKind = lake[cell] ?? LAKE.none;
    if (lakeKind !== LAKE.none) {
      biome[cell] = lakeBiomes[lakeKind] ?? 0;
      continue;
    }
    if (matches(glacierRule, values)) {
      biome[cell] = glacierRule.biome;
      river[cell] = RIVER.none;
    } else if (river[cell] === RIVER.major) biome[cell] = riverBiome;
    else if (coastal[cell]) biome[cell] = classify(coastRules, values);
    else if (wetland[cell]) biome[cell] = classify(wetlandRules, values);
    else biome[cell] = classify(landRules, values);
  }
  return { biome, river };
}
