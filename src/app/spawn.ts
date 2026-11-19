/**
 * Outil d'apparition (CRE-03) : la case touchée peut-elle recevoir un groupe ? Le fil
 * principal en juge avant d'envoyer la commande, par les règles de la simulation : la case
 * du monde qui contient le point (cellIndex, x bouclant d'est en ouest), et un biome et un
 * étage d'altitude franchissables (walkCost). Il refuse aussi une case occupée : par
 * quelqu'un qui s'y tient, d'après les positions des individus, à l'instant affiché ou à
 * celui du dernier état reçu, en marche comme au repos (ADR 0014), ou par une apparition
 * envoyée qu'aucun état n'a encore montrée (OccupiedCells). Un second appui au même point,
 * ou un double-clic, n'empile donc pas un groupe sur le premier. Un refus se dit au joueur,
 * avec sa raison.
 *
 * Le débogage s'en sert aussi : ?crowd=N fait apparaître N individus par groupes de
 * CROWD_GROUP, sur des cases espacées autour du centre de la vue (crowdCells).
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
 * Cases occupées, comptées comme cellIndex : celles où se tient quelqu'un, données à chaque
 * appui (standing), et celles des apparitions envoyées qu'aucun état n'a encore montrées.
 * Une apparition se montre par son fait (« groupAppeared »), à sa case, dans le delta qui
 * suit son application, avec l'image des groupes qui la contient ; un delta parti avant que
 * le worker ne reçoive la commande ne l'efface donc pas.
 */
export class OccupiedCells {
  private standing: ReadonlySet<number> = new Set<number>();
  private readonly sent = new Set<number>();

  /** Un instantané : une autre partie, sans apparition en attente. */
  reset(): void {
    this.standing = new Set<number>();
    this.sent.clear();
  }

  /**
   * Cases où se tient quelqu'un, au moment d'un appui : celles des positions des individus
   * (app/frames.ts, CrowdTimeline.occupied).
   */
  setStanding(cells: ReadonlySet<number>): void {
    this.standing = cells;
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
    return this.standing.has(cell) || this.sent.has(cell);
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

/** Individus par groupe d'une foule de débogage (?crowd=N). */
export const CROWD_GROUP = 20;

/**
 * Effectifs des groupes d'une foule de `total` individus : des groupes de `size`, et le reste
 * en un dernier groupe s'il atteint le minimum d'une apparition, sinon réparti sur les
 * premiers, sans dépasser le maximum.
 */
export function crowdGroups(
  total: number,
  size: number,
  limits: { readonly min: number; readonly max: number },
): number[] {
  const sizes = new Array<number>(Math.floor(total / size)).fill(size);
  let rest = total - sizes.length * size;
  if (rest >= limits.min) {
    sizes.push(rest);
    rest = 0;
  }
  for (let index = 0; rest > 0 && index < sizes.length; index++) {
    const added = Math.min(rest, limits.max - (sizes[index] ?? 0));
    sizes[index] = (sizes[index] ?? 0) + added;
    rest -= added;
  }
  return sizes;
}

/**
 * Cases d'une foule : au plus `count` cases franchissables, de `spacing` en `spacing` cases
 * autour de `center`, par anneaux carrés de plus en plus larges, x ramené dans le monde.
 */
export function crowdCells(
  center: { readonly x: number; readonly y: number },
  count: number,
  spacing: number,
  size: WorldSize,
  passable: (cell: number) => boolean,
): { readonly x: number; readonly y: number }[] {
  const cells: { x: number; y: number }[] = [];
  const seen = new Set<number>();
  const visit = (i: number, j: number) => {
    if (cells.length >= count) return;
    const y = center.y + j * spacing;
    if (y < 0 || y >= size.height) return;
    const x = (((center.x + i * spacing) % size.width) + size.width) % size.width;
    const cell = y * size.width + x;
    if (seen.has(cell) || !passable(cell)) return;
    seen.add(cell);
    cells.push({ x, y });
  };
  const rings = Math.ceil(Math.max(size.width, size.height) / spacing);
  visit(0, 0);
  for (let ring = 1; ring <= rings && cells.length < count; ring++) {
    for (let step = -ring; step < ring; step++) {
      visit(step, -ring);
      visit(ring, step);
      visit(-step, ring);
      visit(-ring, -step);
    }
  }
  return cells;
}
