/**
 * Description d'une case pour l'inspection (IHM-02, première version) : tout ce que les
 * couches du monde en disent, avec la température du mois courant (C1, D8).
 */
import { altitudeLevelIndex } from '../core/altitude';
import type { GameData } from '../core/data';
import { riverClass, type WorldLayers, type WorldSize } from '../core/world';
import type { MessageKey } from '../i18n';
import type { CellDetails } from '../ui/store';

/** Case (x, y) ; x boucle, y est borné aux pôles. `month` est le mois continu, de 0 à 12. */
export function describeCell(
  layers: WorldLayers,
  size: WorldSize,
  x: number,
  y: number,
  month: number,
  data: Pick<GameData, 'biomes' | 'altitudeLevels' | 'resources'>,
): CellDetails | undefined {
  if (!Number.isFinite(x) || y < 0 || y >= size.height) return undefined;
  const column = ((Math.floor(x) % size.width) + size.width) % size.width;
  const row = Math.floor(y);
  const cell = row * size.width + column;
  const biome = data.biomes.entries.at(layers.biome[cell] ?? 0);
  const depth = layers.waterDepth[cell] ?? 0;
  const elevation = layers.elevation[cell] ?? 0;
  // Les eaux se rangent par leur profondeur, mesurée depuis leur surface (D2, D11).
  const level = data.altitudeLevels.entries.at(
    altitudeLevelIndex(data.altitudeLevels.entries, depth > 0 ? -depth : Math.max(0, elevation)),
  );
  const temperature = (layers.temperature[cell] ?? 0) / 10;
  const amplitude = (layers.amplitude[cell] ?? 0) / 10;
  const south = row >= size.height / 2;
  const season = Math.cos((2 * Math.PI * (month - 6.5)) / 12) * (south ? -1 : 1);
  const deposit = layers.deposit[cell] ?? 0;
  return {
    x: column,
    y: row,
    biome: (biome?.name ?? 'biome.ocean') as MessageKey,
    level: (level?.name ?? 'altitude.plain-one') as MessageKey,
    elevation,
    depth,
    temperature,
    monthly: temperature + amplitude * season,
    precipitation: layers.precipitation[cell] ?? 0,
    river: riverClass(layers.drainage[cell] ?? 0),
    deposit:
      deposit > 0
        ? (data.resources.entries.at(deposit - 1)?.name as MessageKey | undefined)
        : undefined,
    trees: Math.round(((layers.trees[cell] ?? 0) / 255) * 100),
    shrubs: Math.round(((layers.shrubs[cell] ?? 0) / 255) * 100),
  };
}
