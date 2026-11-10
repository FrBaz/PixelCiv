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
import { generateRelief, reliefSettings } from './relief';
import { placeResources } from './resources';
import { CylinderSampler } from './sampler';

/** Version du générateur : elle change quand un même monde ne se génère plus pareil. */
export const GENERATOR_VERSION = 2;

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
  const relief = generateRelief(
    sampler,
    rng,
    params,
    reliefSettings(worldgen, data.altitudeLevels.entries),
  );
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
    climate.amplitude,
  );

  // Valeurs du monde stocké, arrondies et bornées à leur type avant le classement : les
  // biomes et les gisements se décident sur ce que le monde garde, qui respecte donc ses
  // propres règles. Les cuvettes comblées et la surface des lacs ont leur altitude, et
  // leur température suit le gradient de 6,5 °C par 1 000 m.
  const count = size.width * size.height;
  const elevation = new Float32Array(count);
  const temperature = new Float32Array(count);
  const amplitude = new Float32Array(count);
  const precipitation = new Float32Array(count);
  const { lapseRate } = worldgen.climate;
  for (let cell = 0; cell < count; cell++) {
    const meters = hydrology.elevation[cell] ?? 0;
    const sea = ocean[cell] === 1;
    const lake = hydrology.lake[cell] ?? LAKE.none;
    const water = lake === LAKE.fresh || lake === LAKE.salt;
    // Au plus -1 en mer, négatif au fond d'un lac ou d'un salar, au moins 0 sur les terres.
    elevation[cell] = sea
      ? -Math.min(32767, Math.max(1, Math.round(-meters)))
      : lake === LAKE.none
        ? Math.min(32767, Math.max(0, Math.round(meters)))
        : Math.max(-32768, Math.min(32767, Math.round(meters)));
    const surface = sea ? 0 : water ? (hydrology.lakeSurface[cell] ?? meters) : meters;
    const lift = sea ? 0 : Math.max(0, surface) - Math.max(0, relief[cell] ?? 0);
    const celsius = (climate.temperature[cell] ?? 0) - (lapseRate * lift) / 1000;
    temperature[cell] = Math.max(-3276.8, Math.min(3276.7, Math.round(celsius * 10) / 10));
    amplitude[cell] = Math.min(25.5, Math.round((climate.amplitude[cell] ?? 0) * 10) / 10);
    precipitation[cell] = Math.min(65535, Math.round(climate.precipitation[cell] ?? 0));
  }
  const stored = { ...climate, temperature, amplitude, precipitation };

  onStage('biomes');
  const { biome, river } = classifyBiomes(
    sampler,
    rng,
    elevation,
    stored,
    hydrology,
    worldgen,
    data.biomes,
  );

  onStage('resources');
  const resources = placeResources(sampler, rng, elevation, biome, data);

  // Couches compactes.
  const layers = emptyLayers(size);
  for (let cell = 0; cell < count; cell++) {
    const meters = elevation[cell] ?? 0;
    const sea = ocean[cell] === 1;
    layers.elevation[cell] = meters;
    const lake = hydrology.lake[cell];
    // Un lac salé gelé toute l'année est sous la calotte : il n'a plus d'eau libre.
    const open = data.biomes.entries.at(biome[cell] ?? 0)?.family === 'water';
    if (sea) layers.waterDepth[cell] = Math.min(65535, Math.max(1, -meters));
    else if (open && (lake === LAKE.fresh || lake === LAKE.salt)) {
      const depth = (hydrology.lakeSurface[cell] ?? meters) - meters;
      layers.waterDepth[cell] = Math.min(65535, Math.max(1, Math.round(depth)));
    }
    layers.biome[cell] = biome[cell] ?? 0;
    layers.drainage[cell] = encodeDrainage(hydrology.direction[cell] ?? 8, river[cell] ?? 0);
    layers.temperature[cell] = Math.round((temperature[cell] ?? 0) * 10);
    layers.amplitude[cell] = Math.round((amplitude[cell] ?? 0) * 10);
    layers.precipitation[cell] = precipitation[cell] ?? 0;
    layers.deposit[cell] = resources.deposit[cell] ?? 0;
    layers.trees[cell] = resources.trees[cell] ?? 0;
    layers.shrubs[cell] = resources.shrubs[cell] ?? 0;
  }
  return layers;
}
