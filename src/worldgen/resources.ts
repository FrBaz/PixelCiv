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
  const water = (cell: number) => biomes.entries[biome[cell] ?? 0]?.family === 'water';

  // Famille d'altitude de chaque case, une fois pour toutes.
  const family = new Uint8Array(count);
  for (let cell = 0; cell < count; cell++) {
    const level = levels.at(altitudeLevelIndex(levels, elevation[cell] ?? 0));
    family[cell] = level === undefined ? 0 : ALTITUDE_FAMILIES.indexOf(level.family);
  }

  // Provinces de chaque minerai : les cases où son bruit dépasse le quantile voulu.
  const minerals = resources.entries.flatMap((resource, index) => {
    const deposit = resource.deposit;
    if (deposit === undefined) return [];
    const noise = sampler.fractal(new NoiseLayer(rng.stream(`worldgen.deposits.${resource.id}`)), {
      frequency: deposit.provinceFrequency,
      octaves: 3,
    });
    const families = new Uint8Array(ALTITUDE_FAMILIES.length);
    for (const name of deposit.altitudes) families[ALTITUDE_FAMILIES.indexOf(name)] = 1;
    const inBiomes = new Uint8Array(biomes.entries.length);
    for (const id of deposit.biomes ?? []) {
      const found = biomes.indexOf(id);
      if (found !== undefined) inBiomes[found] = 1;
    }
    return [
      {
        code: index + 1,
        probability: deposit.abundance / deposit.provinceShare,
        noise,
        threshold: quantile(noise, 1 - deposit.provinceShare),
        families,
        inBiomes,
      },
    ];
  });

  // Un tirage par case admise : un gisement au plus, choisi selon les probabilités.
  const random = rng.stream('worldgen.deposits');
  const deposit = new Uint8Array(count);
  const weights = new Float64Array(minerals.length);
  for (let cell = 0; cell < count; cell++) {
    if (water(cell)) continue;
    let total = 0;
    const cellFamily = family[cell] ?? 0;
    const cellBiome = biome[cell] ?? 0;
    for (let slot = 0; slot < minerals.length; slot++) {
      const mineral = minerals.at(slot);
      if (mineral === undefined) continue;
      const admitted = mineral.families[cellFamily] === 1 || mineral.inBiomes[cellBiome] === 1;
      const weight =
        admitted && (mineral.noise[cell] ?? 0) > mineral.threshold ? mineral.probability : 0;
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
        deposit[cell] = minerals[slot]?.code ?? 0;
        break;
      }
    }
  }

  // Flore : densités du biome, modulées.
  const treeNoise = sampler.fractal(
    new NoiseLayer(rng.stream('worldgen.flora.trees')),
    FLORA_NOISE,
  );
  const shrubNoise = sampler.fractal(
    new NoiseLayer(rng.stream('worldgen.flora.shrubs')),
    FLORA_NOISE,
  );
  const trees = new Uint8Array(count);
  const shrubs = new Uint8Array(count);
  const density = (base: number, noise: number) =>
    Math.round(255 * Math.min(1, Math.max(0, base * (1 + FLORA_VARIATION * noise))));
  for (let cell = 0; cell < count; cell++) {
    const flora = biomes.entries.at(biome[cell] ?? 0)?.flora;
    if (flora === undefined) continue;
    trees[cell] = density(flora.trees, treeNoise[cell] ?? 0);
    shrubs[cell] = density(flora.shrubs, shrubNoise[cell] ?? 0);
  }
  return { deposit, trees, shrubs };
}
