/**
 * Modes de carte (tâche 1.8 ; IHM-01) : la superposition de chaque mode, une couleur par
 * case, et sa légende.
 * - Relief : la couleur du niveau d'altitude (data/altitude-levels.json), ombrée.
 * - Biomes : la couleur de base de chaque biome, ombrée.
 * - Ressources : la carte pâlie, et la couleur de chaque gisement (data/resources.json).
 */
import { altitudeLevelIndex } from '../core/altitude';
import type { AltitudeLevel, Biome, Resource } from '../core/data/schemas';
import type { WorldLayers } from '../core/world';
import type { MessageKey } from '../i18n';
import { parseColor } from './bake';
import type { MapMode } from './map';

export interface ModeData {
  readonly biomes: readonly Biome[];
  readonly altitudeLevels: readonly AltitudeLevel[];
  readonly resources: readonly Resource[];
}

/** Superposition d'un mode : un texel RGBA par case, ligne par ligne. */
export function overlayTexels(
  mode: Exclude<MapMode, 'natural'>,
  layers: WorldLayers,
  data: ModeData,
): Uint8Array<ArrayBuffer> {
  const count = layers.biome.length;
  const texels = new Uint8Array(count * 4);
  const biomeColors = data.biomes.map((biome) => parseColor(biome.palette.base));
  const levelColors = data.altitudeLevels.map((level) => parseColor(level.color));
  const resourceColors = data.resources.map((resource) => parseColor(resource.color));
  for (let cell = 0; cell < count; cell++) {
    let color: readonly [number, number, number] | undefined;
    if (mode === 'biomes') color = biomeColors.at(layers.biome[cell] ?? 0);
    else if (mode === 'relief') {
      // Les lacs prennent la couleur de leur profondeur, mesurée depuis leur surface (D2).
      const depth = layers.waterDepth[cell] ?? 0;
      const elevation = layers.elevation[cell] ?? 0;
      const meters = depth > 0 ? -depth : Math.max(0, elevation);
      color = levelColors.at(altitudeLevelIndex(data.altitudeLevels, meters));
    } else {
      const deposit = layers.deposit[cell] ?? 0;
      color = deposit > 0 ? resourceColors.at(deposit - 1) : undefined;
    }
    if (color === undefined) continue;
    const offset = cell * 4;
    texels[offset] = color[0];
    texels[offset + 1] = color[1];
    texels[offset + 2] = color[2];
    texels[offset + 3] = 255;
  }
  return texels;
}

/** Une entrée de légende : une couleur et le nom de ce qu'elle désigne. */
export interface LegendEntry {
  readonly color: string;
  readonly label: MessageKey;
}

/**
 * Légende d'un mode : les niveaux d'altitude du plus haut au plus profond, les biomes
 * présents dans le monde, ou les minerais qu'il contient.
 */
export function legend(
  mode: Exclude<MapMode, 'natural'>,
  layers: WorldLayers,
  data: ModeData,
): LegendEntry[] {
  if (mode === 'relief') {
    return [...data.altitudeLevels]
      .reverse()
      .map((level) => ({ color: level.color, label: level.name as MessageKey }));
  }
  if (mode === 'biomes') {
    const present = new Set(layers.biome);
    return data.biomes
      .filter((_, index) => present.has(index))
      .map((biome) => ({ color: biome.palette.base, label: biome.name as MessageKey }));
  }
  const present = new Set(layers.deposit);
  return data.resources
    .filter((resource, index) => resource.deposit !== undefined && present.has(index + 1))
    .map((resource) => ({ color: resource.color, label: resource.name as MessageKey }));
}
