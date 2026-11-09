/**
 * Génération d'un monde (phase 1, ADR 0009) : relief, climat, hydrologie, biomes,
 * ressources et flore, à partir d'une graine et des paramètres de l'écran de création.
 * Tout passe par les flux du générateur nommés d'après la graine : la même graine et
 * les mêmes paramètres donnent le même monde, sur tous les appareils (NF-09).
 *
 * La génération s'accepte à toute taille : les tailles de jeu sont celles de
 * WORLD_SIZES, l'aperçu de l'écran de création se contente d'une carte réduite, qui
 * montre les mêmes continents.
 */
import type { GameData } from '../core/data';
import type { ParameterName } from '../core/data/worldgen';
import { Rng } from '../core/rng';
import {
  emptyLayers,
  encodeDrainage,
  type GenerationStage,
  type WorldLayers,
  type WorldSize,
} from '../core/world';
import { classifyBiomes } from './biomes';
import { generateClimate } from './climate';
import { findOcean, generateHydrology, LAKE } from './hydrology';
import { generateRelief } from './relief';
import { placeResources } from './resources';
import { CylinderSampler } from './sampler';

/** Version du générateur : elle change quand un même monde ne se génère plus pareil. */
export const GENERATOR_VERSION = 1;

/** Ce que la génération demande : graine, taille et réglages. */
export type GenerationParams = {
  readonly seed: string;
  readonly size: WorldSize;
} & Readonly<Record<ParameterName, number>>;

/** Contenu dont la génération se sert. */
export type GenerationData = Pick<GameData, 'biomes' | 'altitudeLevels' | 'resources' | 'worldgen'>;

/** Génère un monde ; `onStage` est appelé au début de chaque étape. */
export function generateWorld(
  params: GenerationParams,
  data: GenerationData,
  onStage: (stage: GenerationStage) => void = () => undefined,
): WorldLayers {
  const { size } = params;
  const { worldgen } = data;
  const sampler = new CylinderSampler(size);
  const rng = new Rng(params.seed);

  onStage('relief');
  const relief = generateRelief(sampler, rng, params);
  const ocean = findOcean(relief, size, worldgen.ocean.minShare);

  onStage('climate');
  const climate = generateClimate(sampler, rng, relief, ocean, worldgen.climate, params);

  onStage('hydrology');
  const hydrology = generateHydrology(
    size,
    relief,
    ocean,
    climate.temperature,
    climate.precipitation,
    rng.stream('worldgen.hydrology'),
    worldgen.hydrology,
    params,
  );
  const { elevation } = hydrology;

  onStage('biomes');
  const { biome, river } = classifyBiomes(
    sampler,
    rng,
    elevation,
    climate,
    hydrology,
    worldgen,
    data.biomes,
  );

  onStage('resources');
  const resources = placeResources(sampler, rng, elevation, biome, data);

  // Couches compactes : entiers arrondis, bornés à leur type.
  const layers = emptyLayers(size);
  const count = size.width * size.height;
  for (let cell = 0; cell < count; cell++) {
    const meters = elevation[cell] ?? 0;
    const sea = ocean[cell] === 1;
    layers.elevation[cell] = sea
      ? -Math.min(32767, Math.max(1, Math.round(-meters)))
      : Math.max(-32768, Math.min(32767, Math.round(meters)));
    const lake = hydrology.lake[cell];
    if (sea) layers.waterDepth[cell] = Math.min(65535, Math.max(1, Math.round(-meters)));
    else if (lake === LAKE.fresh || lake === LAKE.salt) {
      const depth = (hydrology.lakeSurface[cell] ?? meters) - meters;
      layers.waterDepth[cell] = Math.min(65535, Math.max(1, Math.round(depth)));
    }
    layers.biome[cell] = biome[cell] ?? 0;
    layers.drainage[cell] = encodeDrainage(hydrology.direction[cell] ?? 8, river[cell] ?? 0);
    layers.temperature[cell] = Math.round((climate.temperature[cell] ?? 0) * 10);
    layers.amplitude[cell] = Math.min(255, Math.round((climate.amplitude[cell] ?? 0) * 10));
    layers.precipitation[cell] = Math.min(65535, Math.round(climate.precipitation[cell] ?? 0));
    layers.deposit[cell] = resources.deposit[cell] ?? 0;
    layers.trees[cell] = resources.trees[cell] ?? 0;
    layers.shrubs[cell] = resources.shrubs[cell] ?? 0;
  }
  return layers;
}
