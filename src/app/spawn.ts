/**
 * Outil d'apparition (CRE-03) : la case touchée peut-elle recevoir un groupe ? Le fil
 * principal en juge avant d'envoyer la commande, par les règles de la simulation : la case
 * du monde qui contient le point (cellIndex, x bouclant d'est en ouest), et un biome et un
 * étage d'altitude franchissables (walkCost). Il refuse aussi une case occupée : par un
 * groupe qui s'y tient, à l'instant affiché ou à celui du dernier état reçu, en marche
 * comme au repos (ADR 0013), ou par une apparition envoyée qu'aucun état n'a encore
 * montrée (OccupiedCells). Un second appui au même point, ou un double-clic, n'empile donc
 * pas un groupe sous le premier, où rien ne le distinguerait à l'écran. Un refus se dit au
 * joueur, avec sa raison.
 */
import type { ChronicleView } from '../core/protocol';
import type { WorldLayers, WorldSize } from '../core/world';
import type { MessageKey } from '../i18n';
import type { ChronicleKind } from '../sim/society';
import { cellIndex, walkCost, type TerrainContent } from '../sim/terrain';

/** La case où le groupe apparaîtra, ramenée dans le monde, ou la raison du refus. */
export type SpawnTarget =
  { readonly x: number; readonly y: number } | { readonly refusal: MessageKey };

/** Le fait qui montre une apparition, à sa case. */
const APPEARED: ChronicleKind = 'groupAppeared';

/**
 * Cases occupées, comptées comme cellIndex : celles où se tiennent des groupes, données à
 * chaque appui (groups), et celles des apparitions envoyées qu'aucun état n'a encore
 * montrées. Une apparition se montre par son fait (« groupAppeared »), à sa case, dans le
 * delta qui suit son application, avec l'image des groupes qui la contient ; un delta
 * parti avant que le worker ne reçoive la commande ne l'efface donc pas.
 */
export class OccupiedCells {
  private groups: ReadonlySet<number> = new Set<number>();
  private readonly sent = new Set<number>();

  /** Un instantané : une autre partie, sans apparition en attente. */
  reset(): void {
    this.groups = new Set<number>();
    this.sent.clear();
  }

  /** Cases où se tiennent les groupes, au moment d'un appui. */
  setGroups(cells: ReadonlySet<number>): void {
    this.groups = cells;
  }

  /** Un delta : les apparitions que ses faits montrent ne sont plus en attente. */
  update(facts: readonly ChronicleView[], size: WorldSize): void {
    for (const fact of facts) {
      if (fact.kind === APPEARED) this.sent.delete(fact.y * size.width + fact.x);
    }
  }

  /** Une apparition envoyée sur la case (x, y) du monde. */
  add(x: number, y: number, size: WorldSize): void {
    this.sent.add(y * size.width + x);
  }

  /** Le worker a refusé une commande : les apparitions en attente ne viendront peut-être pas. */
  refused(): void {
    this.sent.clear();
  }

  /** La case `cell`, comptée comme cellIndex, est-elle occupée ? */
  has(cell: number): boolean {
    return this.groups.has(cell) || this.sent.has(cell);
  }
}

/** La case du point (x, y), si un groupe peut y apparaître, ou la raison du refus. */
export function spawnTarget(
  layers: WorldLayers,
  size: WorldSize,
  x: number,
  y: number,
  content: TerrainContent,
  occupied: Pick<OccupiedCells, 'has'>,
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
  if (occupied.has(cell)) return { refusal: 'creator.occupied' };
  const column = cell % size.width;
  return { x: column, y: (cell - column) / size.width };
}
