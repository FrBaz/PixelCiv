/**
 * Ressources et flore (tâche 1.6, RES-01, RES-03, RES-05 ; MON-10).
 *
 * - Gisements : chaque minerai de data/resources.json se trouve sur certains étages
 *   d'altitude ou certains biomes, et se regroupe en provinces, que dessine un bruit
 *   propre au minerai. Une case porte au plus un gisement.
 * - Ressources du milieu (poisson, bois, gibier, roseaux, tourbe, sel des salars…) : elles
 *   viennent du biome, qui les déclare dans data/biomes.json, et ne demandent pas de couche.
 * - Flore : densités d'arbres et de buissons, celles du biome, que module un bruit.
 */
import { altitudeLevelIndex } from '../core/altitude';
import type { Catalog } from '../core/data/catalog';
import {
  ALTITUDE_FAMILIES,
  type AltitudeLevel,
  type Biome,
  type Resource,
} from '../core/data/schemas';
import type { Rng } from '../core/rng';
import { quantile } from './grid';
import { NoiseLayer, type CylinderSampler } from './sampler';

export interface ResourceLayers {
  /** Gisement de chaque case : indice + 1 dans data/resources.json, 0 sans gisement. */
  readonly deposit: Uint8Array;
  /** Densités d'arbres et de buissons, de 0 à 255. */
  readonly trees: Uint8Array;
  readonly shrubs: Uint8Array;
}

export interface ResourceData {
  readonly biomes: Catalog<Biome>;
  readonly altitudeLevels: Catalog<AltitudeLevel>;
  readonly resources: Catalog<Resource>;
}

/** Bruit des densités de la flore : des bosquets et des clairières. */
const FLORA_NOISE = { frequency: 24, octaves: 3 };
/** Écart des densités autour de celles du biome, en part (±). */
const FLORA_VARIATION = 0.35;

export function placeResources(
  sampler: CylinderSampler,
  rng: Rng,
  elevation: Float32Array,
  biome: Uint8Array,
  data: ResourceData,
): ResourceLayers {
  const count = sampler.width * sampler.height;
  const { biomes, altitudeLevels, resources } = data;
  const levels = altitudeLevels.entries;
  const water = (cell: number) => biomes.entries.at(biome[cell] ?? 0)?.family === 'water';

  // Famille d'altitude de chaque case, une fois pour toutes.
  const family = new Uint8Array(count);
  for (let cell = 0; cell < count; cell++) {
    const level = levels.at(altitudeLevelIndex(levels, elevation[cell] ?? 0));
    family[cell] = level === undefined ? 0 : ALTITUDE_FAMILIES.indexOf(level.family);
  }

  // Provinces de chaque minerai : parmi les cases qui l'admettent, celles où son bruit
  // dépasse le quantile voulu. Le bruit ne se calcule que sur ces cases ; il vaut NaN
  // ailleurs, où toute comparaison échoue.
  const { width } = sampler;
  const minerals = resources.entries.flatMap((resource, index) => {
    const deposit = resource.deposit;
    if (deposit === undefined) return [];
    const families = new Uint8Array(ALTITUDE_FAMILIES.length);
    for (const name of deposit.altitudes) families[ALTITUDE_FAMILIES.indexOf(name)] = 1;
    const inBiomes = new Uint8Array(biomes.entries.length);
    for (const id of deposit.biomes ?? []) {
      const found = biomes.indexOf(id);
      if (found !== undefined) inBiomes[found] = 1;
    }
    const layer = new NoiseLayer(rng.stream(`worldgen.deposits.${resource.id}`));
    const province = { frequency: deposit.provinceFrequency, octaves: 3 };
    const noise = new Float32Array(count).fill(Number.NaN);
    for (let cell = 0; cell < count; cell++) {
      if (water(cell)) continue;
      if (families[family[cell] ?? 0] !== 1 && inBiomes[biome[cell] ?? 0] !== 1) continue;
      const x = cell % width;
      noise[cell] = sampler.fractalAt(layer, province, x, (cell - x) / width);
    }
    const admitted = (cell: number) => !Number.isNaN(noise[cell] ?? Number.NaN);
    const threshold = quantile(noise, 1 - deposit.provinceShare, admitted);
    return [
      { code: index + 1, probability: deposit.abundance / deposit.provinceShare, noise, threshold },
    ];
  });

  // Un tirage par case admise : un gisement au plus, choisi selon les probabilités.
  const random = rng.stream('worldgen.deposits');
  const deposit = new Uint8Array(count);
  const weights = new Float64Array(minerals.length);
  for (let cell = 0; cell < count; cell++) {
    if (water(cell)) continue;
    let total = 0;
    for (let slot = 0; slot < minerals.length; slot++) {
      const mineral = minerals.at(slot);
      if (mineral === undefined) continue;
      const weight =
        (mineral.noise[cell] ?? Number.NaN) > mineral.threshold ? mineral.probability : 0;
      weights[slot] = weight;
      total += weight;
    }
    if (total <= 0) continue;
    const draw = random.nextFloat();
    if (draw >= Math.min(1, total)) continue;
    // Le tirage, rapporté au total, choisit le minerai.
    let target = (draw / Math.min(1, total)) * total;
    for (let slot = 0; slot < minerals.length; slot++) {
      target -= weights[slot] ?? 0;
      if (target < 0) {
        deposit[cell] = minerals.at(slot)?.code ?? 0;
        break;
      }
    }
  }

  // Flore : densités du biome, modulées par un bruit, calculé là où le biome en a.
  const treeLayer = new NoiseLayer(rng.stream('worldgen.flora.trees'));
  const shrubLayer = new NoiseLayer(rng.stream('worldgen.flora.shrubs'));
  const trees = new Uint8Array(count);
  const shrubs = new Uint8Array(count);
  const density = (base: number, layer: NoiseLayer, cell: number) => {
    if (base <= 0) return 0;
    const x = cell % width;
    const noise = sampler.fractalAt(layer, FLORA_NOISE, x, (cell - x) / width);
    return Math.round(255 * Math.min(1, Math.max(0, base * (1 + FLORA_VARIATION * noise))));
  };
  for (let cell = 0; cell < count; cell++) {
    const flora = biomes.entries.at(biome[cell] ?? 0)?.flora;
    if (flora === undefined) continue;
    trees[cell] = density(flora.trees, treeLayer, cell);
    shrubs[cell] = density(flora.shrubs, shrubLayer, cell);
  }
  return { deposit, trees, shrubs };
}
