/**
 * Modes de carte (tâche 1.8 ; IHM-01) : la superposition de chaque mode, une couleur par
 * case, et sa légende.
 * - Relief : la couleur du niveau d'altitude (data/altitude-levels.json), ombrée, et les
 *   rivières en bleu.
 * - Biomes : la couleur de base de chaque biome, ombrée.
 * - Ressources : la carte pâlie, la couleur de chaque gisement (data/resources.json), et
 *   celle des ressources du milieu humide ou salé que portent les biomes (RES-05).
 */
import { altitudeLevelIndex } from '../core/altitude';
import type { AltitudeLevel, Biome, Resource } from '../core/data/schemas';
import type { WorldLayers } from '../core/world';
import type { MessageKey } from '../i18n';
import { parseColor } from './bake';
import type { MapMode } from './map';

/** Alpha de superposition d'une case dont les pixels d'eau sont des rivières. */
export const RIVER_CELL = 128;

/**
 * Alpha d'une ressource du milieu : elle teinte la carte pâlie, là où un gisement (alpha
 * 255) la couvre en plein.
 */
export const BIOME_RESOURCE = 128;

/**
 * Ressources du milieu montrées sur chaque biome (RES-05) : celles qu'il porte et que
 * data/resources.json marque `overlay`, par indice dans data/resources.json.
 */
function biomeResources(data: ModeData): number[][] {
  return data.biomes.map((biome) =>
    biome.resources.flatMap((id) => {
      const index = data.resources.findIndex((resource) => resource.id === id);
      return index >= 0 && data.resources[index]?.overlay === true ? [index] : [];
    }),
  );
}

export interface ModeData {
  readonly biomes: readonly Biome[];
  readonly altitudeLevels: readonly AltitudeLevel[];
  readonly resources: readonly Resource[];
}

/**
 * Superposition d'un mode : un texel RGBA par case, ligne par ligne, d'un monde large de
 * `width` cases.
 */
export function overlayTexels(
  mode: Exclude<MapMode, 'natural'>,
  layers: WorldLayers,
  data: ModeData,
  width: number,
): Uint8Array<ArrayBuffer> {
  const count = layers.biome.length;
  const texels = new Uint8Array(count * 4);
  const biomeColors = data.biomes.map((biome) => parseColor(biome.palette.base));
  const levelColors = data.altitudeLevels.map((level) => parseColor(level.color));
  const resourceColors = data.resources.map((resource) => parseColor(resource.color));
  const shown = biomeResources(data);
  for (let cell = 0; cell < count; cell++) {
    let color: readonly [number, number, number] | undefined;
    let alpha = 255;
    if (mode === 'biomes') color = biomeColors.at(layers.biome[cell] ?? 0);
    else if (mode === 'relief') {
      // Les lacs prennent la couleur de leur profondeur, mesurée depuis leur surface (D2).
      const depth = layers.waterDepth[cell] ?? 0;
      const elevation = layers.elevation[cell] ?? 0;
      const meters = depth > 0 ? -depth : Math.max(0, elevation);
      color = levelColors.at(altitudeLevelIndex(data.altitudeLevels, meters));
      // Hors de la mer et des lacs, les pixels d'eau sont des rivières, que le shader peint
      // en bleu (alpha 128).
      if (depth === 0) alpha = RIVER_CELL;
    } else {
      const deposit = layers.deposit[cell] ?? 0;
      const local = shown[layers.biome[cell] ?? 0] ?? [];
      if (deposit > 0) color = resourceColors.at(deposit - 1);
      else if (local.length > 0) {
        // Plusieurs ressources du milieu alternent par carrés de 2 × 2 cases.
        const x = cell % width;
        const y = (cell - x) / width;
        const pick = (Math.floor(x / 2) + Math.floor(y / 2)) % local.length;
        color = resourceColors.at(local[pick] ?? 0);
        alpha = BIOME_RESOURCE;
      }
    }
    if (color === undefined) continue;
    const offset = cell * 4;
    texels[offset] = color[0];
    texels[offset + 1] = color[1];
    texels[offset + 2] = color[2];
    texels[offset + 3] = alpha;
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
 * présents dans le monde, ou les ressources qu'il montre, gisements et milieux.
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
  const shown = biomeResources(data);
  for (const biome of new Set(layers.biome)) {
    for (const index of shown[biome] ?? []) present.add(index + 1);
  }
  return data.resources
    .filter((_, index) => present.has(index + 1))
    .map((resource) => ({ color: resource.color, label: resource.name as MessageKey }));
}
