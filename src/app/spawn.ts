/**
 * Outil d'apparition (CRE-03) : la case touchée peut-elle recevoir un groupe ? Le fil
 * principal en juge avant d'envoyer la commande, par les règles de la simulation : la case
 * du monde qui contient le point (cellIndex, x bouclant d'est en ouest), et un biome et un
 * étage d'altitude franchissables (walkCost). Un refus se dit au joueur, avec sa raison.
 */
import type { WorldLayers, WorldSize } from '../core/world';
import type { MessageKey } from '../i18n';
import { cellIndex, walkCost, type TerrainContent } from '../sim/terrain';

/** La case où le groupe apparaîtra, ramenée dans le monde, ou la raison du refus. */
export type SpawnTarget =
  { readonly x: number; readonly y: number } | { readonly refusal: MessageKey };

export function spawnTarget(
  layers: WorldLayers,
  size: WorldSize,
  x: number,
  y: number,
  content: TerrainContent,
): SpawnTarget {
  const cell = cellIndex(size, x, y);
  // Au-delà des pôles : la carte se prolonge à l'écran, pas le monde.
  if (cell === undefined) return { refusal: 'creator.outside' };
  if (!Number.isFinite(walkCost(layers, cell, content))) {
    // Une terre au-dessus de la mer, mais d'un étage infranchissable : un sommet. Sinon,
    // l'eau, le lit d'un fleuve ou l'estran.
    const biome = content.biomes.entries.at(layers.biome[cell] ?? 0);
    const land = biome !== undefined && biome.movementCost !== null;
    const summit = land && (layers.elevation[cell] ?? 0) > 0;
    return { refusal: summit ? 'creator.summit' : 'creator.water' };
  }
  const column = cell % size.width;
  return { x: column, y: (cell - column) / size.width };
}
