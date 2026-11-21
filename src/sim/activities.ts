/**
 * Activités des individus (tâche 2b.8, ADR 0021). Chaque vivant qui n'est pas porté a une activité,
 * l'une de data/activities.json : se reposer à sa place au camp, cueillir autour d'elle, chasser un
 * animal du gibier, pêcher ou puiser au bord d'une eau, jouer près des siens, ou suivre son groupe
 * vers son nouveau camp (le plan du mois, movement.ts). C'est un état : la colonne `activity`, le
 * jour `until` de son prochain choix, et sa place au camp (`homeX`, `homeY`), que tient la grille
 * des places où qu'il aille.
 *
 * - Qui choisit : le seul vivant dont l'activité finit ce jour-là (l'agenda), et non tous chaque
 *   jour. Il tire son activité sur le flux `sim.activities`, selon son âge, ce qu'il porte, sa
 *   grossesse, sa faim, la saison autour du camp, le goût de sa culture, sa grégarité et
 *   l'activité de son ancre, puis son lieu, puis ses jours sur place. Les choix se font par
 *   emplacements croissants, après les chasses en cours.
 * - Ce qui le déplace : des étapes de la simulation, comme la marche de 2b.3 (movement.ts) : le
 *   rendu les interpole, et ne calcule que son geste, sur place (ADR 0022).
 * - Où : un lieu libre, à `camp.gap` au moins des places tenues et des lieux d'activité occupés ;
 *   jamais sur une case que traverse une rivière, dont la carte dessine le lit ; une rive est sur
 *   la case de terre voisine de l'eau, à `shore.inset` de leur bord commun.
 *
 * Tout se calcule par les quatre opérations, la racine carrée et les arrondis (ADR 0003, 0014).
 */
import type { ActivitiesFile, Biome, Catalog } from '../core/data';
import { ACTIVITY_PLACES, ACTIVITY_SEASONS } from '../core/data/activities';
import { Fingerprint } from '../core/hash';
import { ACT_NONE, ACT_RANK, ACT_RUN } from '../core/protocol';
import { deltaFixedX, FIXED, wrapFixedX } from '../core/position';
import { splitmix32, type RandomStream } from '../core/rng';
import type { CalendarCover } from '../core/snow';
import { dayIndex } from '../core/time';
import { flowDirection, riverClass } from '../core/world';
import { DIRECTIONS } from '../worldgen/grid';
import { SHORE_STRIDE, type CampSupplies } from './activityCache';
import { cellCover, cellFood, deplete, FOOD_STRIDE, stocksInto } from './forage';
import { anchorOf, curveAt, effectiveGregariousness, ownPace, segmentClear } from './movement';
import { monthOf, MONTHS_PER_YEAR } from './people';
import {
  CARRIED,
  FEMALE,
  INTENTION,
  LEAVE,
  NEVER,
  NO_ACTIVITY,
  NONE,
  REST,
  WALK,
} from './population';
import type { SimState } from './state';
import type { SimContent } from './step';

/** Flux des activités : choix, lieux, séjours, coups (ADR 0021). */
export const ACTIVITY_STREAM = 'sim.activities';

const NO = -1;
/** Tolérance de l'arrivée, sur chaque axe : 1/128 de case, comme movement.ts. */
const ARRIVE = FIXED / 128;
/** Côté des tuiles du gibier du jour, 2^3 cases. */
const PREY_SHIFT = 3;
/** Années de la table des âges : la courbe des données, lue à chaque année révolue. */
const AGE_YEARS = 128;
/** Rives gardées par camp et par activité, au plus : les plus proches du camp. */
const MAX_SHORES = 64;
/** Camps dont les rives se gardent, au plus ; au-delà, le cache repart de rien. */
const MAX_SHORE_CAMPS = 8192;
/**
 * Cases ajoutées à la portée d'une eau autour du camp, où l'on en cherche les rives : les places au
 * camp s'écartent de quelques cases de son centre.
 */
const SHORE_MARGIN = 4;

const PLACE = Object.fromEntries(ACTIVITY_PLACES.map((place, index) => [place, index])) as Record<
  (typeof ACTIVITY_PLACES)[number],
  number
>;
const SEASON = Object.fromEntries(
  ACTIVITY_SEASONS.map((season, index) => [season, index]),
) as Record<(typeof ACTIVITY_SEASONS)[number], number>;

// --- Les données, en tables.

/** Les activités en tableaux, pour le choix, sans allocation (ADR 0021, § 9). */
interface ActivityTable {
  readonly count: number;
  /** Rangs du repos (`home`) et du suivi du groupe (`camp`), −1 sans eux. */
  readonly home: number;
  readonly camp: number;
  readonly place: Uint8Array;
  readonly weight: Float64Array;
  readonly carrying: Float64Array;
  readonly pregnant: Float64Array;
  readonly weak: Float64Array;
  /** Saison, rang dans ACTIVITY_SEASONS ; −1 sans saison. */
  readonly season: Int8Array;
  /** 1 pour une activité où l'on se rend en courant. */
  readonly run: Uint8Array;
  readonly reach0: Float64Array;
  readonly reach1: Float64Array;
  readonly daysLow: Int32Array;
  readonly daysSpan: Int32Array;
  /** Facteur de l'âge, par rang puis par année révolue. */
  readonly age: Float64Array;
  /** Pour une activité au bord de l'eau : 1 par biome de ses eaux ; et 1 si les rivières comptent. */
  readonly waters: readonly (Uint8Array | undefined)[];
  readonly rivers: Uint8Array;
  /** Plus long repos, en jours : l'empan des premiers choix (staggered). */
  readonly restMax: number;
}

const tables = new WeakMap<ActivitiesFile['activities'], WeakMap<Catalog<Biome>, ActivityTable>>();

/** Ce que les tables des activités lisent du contenu. */
type TableContent = Pick<SimContent, 'activities' | 'biomes'>;

/** La dernière table demandée, et ce dont elle vient : la plupart des appels redemandent la même. */
let lastList: unknown;
let lastBiomes: unknown;
let lastTable: ActivityTable | undefined;

function tableOf(content: TableContent): ActivityTable {
  const list = content.activities.activities;
  if (lastTable !== undefined && lastList === list && lastBiomes === content.biomes) {
    return lastTable;
  }
  lastTable = buildTable(content);
  lastList = list;
  lastBiomes = content.biomes;
  return lastTable;
}

function buildTable(content: TableContent): ActivityTable {
  const list = content.activities.activities;
  let byBiomes = tables.get(list);
  if (byBiomes === undefined) {
    byBiomes = new WeakMap();
    tables.set(list, byBiomes);
  }
  const known = byBiomes.get(content.biomes);
  if (known !== undefined) return known;
  const count = list.length;
  const home = list.findIndex((activity) => activity.place === 'home');
  const table: ActivityTable = {
    count,
    home,
    camp: list.findIndex((activity) => activity.place === 'camp'),
    place: Uint8Array.from(list, (activity) => PLACE[activity.place]),
    weight: Float64Array.from(list, (activity) => activity.weight),
    carrying: Float64Array.from(list, (activity) => activity.carrying),
    pregnant: Float64Array.from(list, (activity) => activity.pregnant),
    weak: Float64Array.from(list, (activity) => activity.weak),
    season: Int8Array.from(list, (activity) =>
      activity.season === undefined ? -1 : SEASON[activity.season],
    ),
    run: Uint8Array.from(list, (activity) => (activity.gait === 'run' ? 1 : 0)),
    reach0: Float64Array.from(list, (activity) => activity.reach[0]),
    reach1: Float64Array.from(list, (activity) => activity.reach[1]),
    daysLow: Int32Array.from(list, (activity) => activity.days?.[0] ?? 1),
    daysSpan: Int32Array.from(list, (activity) =>
      activity.days === undefined ? 1 : activity.days[1] - activity.days[0] + 1,
    ),
    age: new Float64Array(count * AGE_YEARS),
    waters: list.map((activity) => {
      if (activity.water === undefined) return undefined;
      const wanted = new Set(activity.water.biomes);
      return Uint8Array.from(content.biomes.entries, (biome) => (wanted.has(biome.id) ? 1 : 0));
    }),
    rivers: Uint8Array.from(list, (activity) => (activity.water?.river === true ? 1 : 0)),
    restMax: Math.max(1, list[home]?.days?.[1] ?? 1),
  };
  list.forEach((activity, rank) => {
    for (let year = 0; year < AGE_YEARS; year++) {
      table.age[rank * AGE_YEARS + year] = curveAt(activity.age, year + 0.5);
    }
  });
  byBiomes.set(content.biomes, table);
  return table;
}

// --- L'octet d'activité.

/** Rang de l'activité de `slot`, ACT_NONE sans activité. */
function rankOf(state: SimState, slot: number): number {
  return (state.people.columns.activity[slot] ?? NO_ACTIVITY) & ACT_RANK;
}

/**
 * L'activité de `slot` l'a-t-elle mené hors du suivi de son groupe (ADR 0021) : se repose-t-il,
 * cueille-t-il, chasse-t-il, pêche-t-il, puise-t-il ou joue-t-il ? Ni un porté, ni qui suit son
 * groupe vers son camp, ni qui n'a pas d'activité.
 */
export function onActivity(state: SimState, content: SimContent, slot: number): boolean {
  const rank = rankOf(state, slot);
  if (rank === ACT_NONE) return false;
  const table = tableOf(content);
  return rank < table.count && rank !== table.camp;
}

/**
 * Octet d'activité de `slot`, pour ses étapes et l'image des groupes (protocole 9) : celui de la
 * colonne, rang et charge, avec la course de qui se rend en courant à son activité (le jeu).
 */
export function actByte(state: SimState, content: SimContent, slot: number): number {
  const byte = state.people.columns.activity[slot] ?? NO_ACTIVITY;
  const rank = byte & ACT_RANK;
  if (rank === ACT_NONE) return ACT_NONE;
  return tableOf(content).run[rank] === 1 ? byte | ACT_RUN : byte;
}

/** Allure d'une étape d'activité : la propre de `slot`, fois `rules.run` s'il court. */
export function activityPace(state: SimState, content: SimContent, slot: number): number {
  const run = (actByte(state, content, slot) & ACT_RUN) !== 0;
  return ownPace(state, content, slot) * (run ? content.activities.rules.run : 1);
}

// --- Agenda et lieux.

/** Écrit le jour du prochain choix de `slot`, et le range dans l'agenda (until > 0). */
function setUntil(state: SimState, slot: number, until: number): void {
  state.people.columns.until[slot] = until;
  state.movement.acts.agenda.set(slot, until);
}

/**
 * Le lieu d'activité de `slot`, d'après l'état (ADR 0021) : la position de qui se repose ailleurs
 * qu'à sa place au camp, le but de qui marche vers un autre lieu qu'elle ; aucun sinon.
 */
export function syncSpot(state: SimState, slot: number): void {
  const spots = state.movement.acts.spots;
  const { people } = state;
  if (people.alive[slot] !== 1) {
    spots.release(slot);
    return;
  }
  const { move, x, y, goalX, goalY, homeX, homeY } = people.columns;
  const intention = (move[slot] ?? 0) & INTENTION;
  if (intention === REST && (x[slot] !== homeX[slot] || y[slot] !== homeY[slot])) {
    spots.set(slot, x[slot] ?? 0, y[slot] ?? 0);
  } else if (intention === WALK && (goalX[slot] !== homeX[slot] || goalY[slot] !== homeY[slot])) {
    spots.set(slot, goalX[slot] ?? 0, goalY[slot] ?? 0);
  } else {
    spots.release(slot);
  }
}

/**
 * Distance, en cases, de (x, y) au plus proche lieu d'activité occupé, hors de celui de `except`,
 * bornée par `limit` ; la recherche s'arrête sous `below` (SpotGrid.nearest). Le mouvement la lit
 * pour poser une place au camp, à l'écart des gens partis à leurs activités.
 */
export function spotRoom(
  state: SimState,
  x: number,
  y: number,
  limit: number,
  except: number,
  below = 0,
): number {
  return state.movement.acts.spots.nearest(x, y, limit, except, below);
}

/**
 * Refait l'agenda et les lieux occupés d'après l'état (rebuildMovement, et la fin du plan du
 * mois) : chaque vivant dont le prochain choix est à venir (until > 0) dans la liste de ce jour,
 * et le lieu de chacun (syncSpot).
 */
export function rebuildActivities(state: SimState): void {
  const { people } = state;
  const acts = state.movement.acts;
  acts.ensure(people.columns.id.length);
  acts.clear();
  const { until } = people.columns;
  for (let slot = 0; slot < people.end; slot++) {
    if (people.alive[slot] !== 1) continue;
    acts.agenda.set(slot, until[slot] ?? 0);
    syncSpot(state, slot);
  }
}

/**
 * Description de l'agenda et des lieux occupés, pour les tests : égale pour deux caches égaux,
 * quel que soit l'ordre de leurs listes, et les défauts trouvés (un emplacement hors de sa liste,
 * un lieu qui n'est pas celui de l'état).
 */
export function describeActivities(state: SimState): { text: string; problems: string[] } {
  const { people } = state;
  const acts = state.movement.acts;
  const problems: string[] = [];
  const { until, move, x, y, goalX, goalY, homeX, homeY } = people.columns;
  const agenda = acts.agenda.entries();
  for (const [slot, day] of agenda) {
    if (people.alive[slot] !== 1) problems.push(`agenda : ${String(slot)} n'est pas vivant`);
    else if (until[slot] !== day) problems.push(`agenda : ${String(slot)} au jour ${String(day)}`);
  }
  const listed = new Set(agenda.map(([slot]) => slot));
  const spots = acts.spots.entries();
  const placed = new Map(spots.map(([slot, sx, sy]) => [slot, [sx, sy] as const]));
  for (let slot = 0; slot < people.end; slot++) {
    if (people.alive[slot] !== 1) continue;
    if ((until[slot] ?? 0) > 0 && !listed.has(slot)) {
      problems.push(`agenda : ${String(slot)} manque`);
    }
    const intention = (move[slot] ?? 0) & INTENTION;
    const atSpot =
      intention === REST && (x[slot] !== homeX[slot] || y[slot] !== homeY[slot])
        ? [x[slot] ?? 0, y[slot] ?? 0]
        : intention === WALK && (goalX[slot] !== homeX[slot] || goalY[slot] !== homeY[slot])
          ? [goalX[slot] ?? 0, goalY[slot] ?? 0]
          : undefined;
    const kept = placed.get(slot);
    if ((atSpot === undefined) !== (kept === undefined)) {
      problems.push(`lieux : ${String(slot)} ${atSpot === undefined ? 'en trop' : 'manque'}`);
    } else if (atSpot !== undefined && kept !== undefined) {
      if (kept[0] !== atSpot[0] || kept[1] !== atSpot[1]) {
        problems.push(`lieux : ${String(slot)} ailleurs`);
      }
    }
  }
  for (const [slot] of spots) {
    if (people.alive[slot] !== 1) problems.push(`lieux : ${String(slot)} n'est pas vivant`);
  }
  const text = [
    `agenda ${agenda.map(([slot, day]) => `${String(slot)}:${String(day)}`).join(' ')}`,
    `lieux ${spots.map(([slot, sx, sy]) => `${String(slot)}@${String(sx)},${String(sy)}`).join(' ')}`,
  ].join('\n');
  return { text, problems };
}

// --- Entrées et sorties des activités.

/**
 * Le premier choix d'un vivant qui devient libre de ses mouvements, sans en avoir encore (une
 * apparition, un sevrage) : il se repose à sa place, et choisit un jour qui ne dépend que de son
 * identifiant, du lendemain de `day` à la fin d'un repos, pour que les choix de ceux qui naissent
 * au même instant s'étalent (critique de la conception, requis 7). Sans tirage.
 */
export function beginActivity(state: SimState, content: SimContent, slot: number, day: number) {
  const table = tableOf(content);
  if (table.home < 0) return;
  state.people.columns.activity[slot] = table.home;
  setUntil(state, slot, staggered(state, table, slot, day + 1));
}

/** Du jour `first` à la fin d'un repos, selon l'identifiant de `slot`. */
function staggered(state: SimState, table: ActivityTable, slot: number, first: number): number {
  return first + ((state.people.columns.id[slot] ?? 0) % table.restMax);
}

/**
 * Le suivi du groupe (ADR 0021, § 2) : le plan du mois met `slot` en partance vers le nouveau
 * camp. Sa chasse finit, son lieu se libère, et son activité devient le suivi du groupe, sans
 * choix jusqu'à son arrivée.
 */
export function followGroup(state: SimState, content: SimContent, slot: number): void {
  releasePrey(state, slot);
  const table = tableOf(content);
  if (table.camp >= 0) state.people.columns.activity[slot] = table.camp;
  setUntil(state, slot, 0);
  state.movement.acts.spots.release(slot);
}

/**
 * L'arrivée de `slot` à sa place au nouveau camp, au bout du suivi du groupe : il s'y repose, et
 * choisit le lendemain.
 */
export function arrivedAtCamp(state: SimState, content: SimContent, slot: number, day: number) {
  const table = tableOf(content);
  if (rankOf(state, slot) !== table.camp || table.home < 0) return;
  state.movement.acts.counts.arrivals++;
  state.people.columns.activity[slot] = table.home;
  setUntil(state, slot, day + 1);
}

/**
 * La fin du trajet d'une activité, au soir du jour `day` : il y passera les jours que son choix a
 * tirés (until négatif), comptés du lendemain.
 */
export function tripEnded(state: SimState, slot: number, day: number): void {
  const until = state.people.columns.until[slot] ?? 0;
  if (until < 0) setUntil(state, slot, day + 1 - until);
}

/**
 * Les activités d'une partie de la version 8, déduites de son état, sans tirage (ADR 0021, § 7) :
 * le repos pour qui se repose, son choix étalé du lendemain à la fin d'un repos ; le suivi du
 * groupe pour qui part ou marche vers son camp ; aucune pour un porté. Puis les caches.
 */
export function deduceActivities(state: SimState, content: TableContent): void {
  const table = tableOf(content);
  const { people } = state;
  const { move, activity } = people.columns;
  const now = dayIndex(state);
  for (let slot = 0; slot < people.end; slot++) {
    if (people.alive[slot] !== 1) continue;
    const intention = (move[slot] ?? 0) & INTENTION;
    if (intention === REST && table.home >= 0) {
      activity[slot] = table.home;
      people.columns.until[slot] = staggered(state, table, slot, now);
    } else if ((intention === LEAVE || intention === WALK) && table.camp >= 0) {
      activity[slot] = table.camp;
    }
  }
  rebuildActivities(state);
}

// --- Le camp : saisons et rives.

/**
 * Les eaux de chaque activité et les cases où se tenir, case par case (ActivityCache.waterMask,
 * standMask) : une eau d'une activité est un biome de ses eaux, ou, si elle les compte, la rivière
 * d'une case de terre ; on se tient sur une case franchissable que ne traverse aucune rivière, dont
 * la carte dessine le lit, et dont aucune rivière ne coupe un coin (cornerCut). Rien de tout cela
 * ne change en cours de partie : calculés une fois.
 */
function masksOf(state: SimState, content: TableContent): void {
  const acts = state.movement.acts;
  const list = content.activities.activities;
  if (acts.masksFor === list && acts.waterMask !== undefined) return;
  const table = tableOf(content);
  const { biome, drainage } = state.world;
  const count = biome.length;
  const water = new Uint16Array(count);
  const stand = new Uint8Array(count);
  for (let cell = 0; cell < count; cell++) {
    const land = (state.cost[cell] ?? Infinity) < Infinity;
    const river = riverClass(drainage[cell] ?? 0) > 0;
    if (land && !river && !cornerCut(state, cell)) stand[cell] = 1;
    let bits = 0;
    for (let rank = 0; rank < table.count; rank++) {
      if (table.place[rank] !== PLACE.water) continue;
      if (
        table.waters[rank]?.[biome[cell] ?? 0] === 1 ||
        (table.rivers[rank] === 1 && land && river)
      ) {
        bits |= 1 << rank;
      }
    }
    water[cell] = bits;
  }
  acts.waterMask = water;
  acts.standMask = stand;
  acts.masksFor = list;
  acts.shores.clear();
}

/**
 * Une rivière coupe-t-elle un coin de la case `cell` : deux de ses voisines qui partagent ce coin
 * reliées en diagonale par un écoulement dont la carte dessine le lit ? Ce lit passe au plus près
 * du coin, jusque dans la case.
 */
function cornerCut(state: SimState, cell: number): boolean {
  const { width, height } = state.size;
  const cx = cell % width;
  const cy = (cell - cx) / width;
  for (let sy = -1; sy <= 1; sy += 2) {
    const row = cy + sy;
    if (row < 0 || row >= height) continue;
    const vertical = row * width + cx;
    for (let sx = -1; sx <= 1; sx += 2) {
      const horizontal = cy * width + ((((cx + sx) % width) + width) % width);
      if (drawnLink(state, vertical, horizontal, sx, -sy)) return true;
      if (drawnLink(state, horizontal, vertical, -sx, sy)) return true;
    }
  }
  return false;
}

/**
 * La case `from` s'écoule-t-elle de (dx, dy), vers `to`, par un lit que la carte dessine : celui
 * d'une rivière, ou celui qui sort d'une eau vers une rivière ?
 */
function drawnLink(state: SimState, from: number, to: number, dx: number, dy: number): boolean {
  const code = state.world.drainage[from] ?? 0;
  const [sx, sy] = DIRECTIONS[flowDirection(code)] ?? [0, 0];
  if (sx !== dx || sy !== dy) return false;
  if (riverClass(code) > 0) return true;
  const water = !((state.cost[from] ?? Infinity) < Infinity);
  return water && riverClass(state.world.drainage[to] ?? 0) > 0;
}

/** La case `cell` est-elle une eau de l'activité de rang `rank` (masksOf) ? */
function waterOf(state: SimState, rank: number, cell: number): boolean {
  return (((state.movement.acts.waterMask?.[cell] ?? 0) >> rank) & 1) === 1;
}

/** Peut-on se tenir sur la case `cell` (masksOf) ? */
function standable(state: SimState, cell: number): boolean {
  return state.movement.acts.standMask?.[cell] === 1;
}

/** Un quart de case, en unités : la marge d'un lieu à toute case où l'on ne se tient pas. */
const QUARTER = FIXED / 4;

/**
 * Peut-on se tenir au point (x, y), en unités : sur une case où l'on se tient (standable), à un
 * quart de case au moins de chacune de ses voisines où l'on ne se tient pas, de côté comme de
 * coin ? Ni l'eau des côtes ni le lit d'une rivière n'y entrent sur la carte (critique, requis 5 ;
 * src/render/activitySpots.test.ts).
 */
function clearAt(state: SimState, x: number, y: number): boolean {
  const { width, height } = state.size;
  if (y < 0 || y >= height * FIXED) return false;
  const wx = wrapFixedX(x, width);
  const cx = Math.floor(wx / FIXED);
  const cy = Math.floor(y / FIXED);
  if (!standable(state, cy * width + cx)) return false;
  const fx = wx - cx * FIXED;
  const fy = y - cy * FIXED;
  const sx = fx < QUARTER ? -1 : fx >= FIXED - QUARTER ? 1 : 0;
  const sy = fy < QUARTER ? -1 : fy >= FIXED - QUARTER ? 1 : 0;
  const column = (((cx + sx) % width) + width) % width;
  const row = cy + sy;
  if (row < 0 || row >= height) return false;
  if (sx !== 0 && !standable(state, cy * width + column)) return false;
  if (sy !== 0 && !standable(state, row * width + cx)) return false;
  return sx === 0 || sy === 0 || standable(state, row * width + column);
}

/** clearAt, pour les tests : peut-on se tenir au point (x, y), en unités ? */
export function standsClear(state: SimState, content: TableContent, x: number, y: number): boolean {
  masksOf(state, content);
  return clearAt(state, x, y);
}

/**
 * Décalage le long d'une rive, en unités, pour le tirage `fraction` de [0, 1) : de −spread/2
 * inclus à +spread/2 exclu, dans la moitié centrale du bord pour un `spread` d'une demi-case au
 * plus (son schéma le borne).
 */
export function shoreAlong(fraction: number, spread: number): number {
  return Math.floor((fraction - 0.5) * spread * FIXED);
}

/** Les quatre voisins d'une case : dx, dy. */
const SIDES = [1, 0, -1, 0, 0, 1, 0, -1] as const;

/** Décalages (dx, dy) d'un disque de rayon donné, par distance croissante au centre. */
const discs = new Map<number, Int16Array>();

function discOffsets(radius: number): Int16Array {
  let offsets = discs.get(radius);
  if (offsets === undefined) {
    const list: [number, number, number][] = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy <= radius * radius) list.push([dx * dx + dy * dy, dx, dy]);
      }
    }
    // Par distance, puis par rangée, puis par colonne : un ordre fixe.
    list.sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1]);
    offsets = Int16Array.from(list.flatMap(([, dx, dy]) => [dx, dy]));
    discs.set(radius, offsets);
  }
  return offsets;
}

/** Rives trouvées autour d'un camp, reprises d'un appel à l'autre. */
const shoreBuffer = new Int32Array(MAX_SHORES * SHORE_STRIDE);

/**
 * Les rives d'une activité au bord de l'eau autour du camp (cx, cy) : pour chaque eau de
 * l'activité à sa portée, chaque case voisine où se tenir (standable) donne le milieu de leur bord
 * commun, rentré de `shore.inset` dans la terre. Une rivière qui traverse une case de terre se
 * puise donc depuis une case voisine, hors du lit que la carte y dessine (critique, requis 5).
 * Les eaux se parcourent de la plus proche du camp à la plus lointaine, MAX_SHORES rives au plus.
 */
function shoresNear(
  state: SimState,
  content: SimContent,
  table: ActivityTable,
  rank: number,
  cx: number,
  cy: number,
): Int32Array {
  const { width, height } = state.size;
  const acts = state.movement.acts;
  const cache = acts.shores;
  const settings = acts.shoresFor;
  if (settings?.[0] !== content.activities || settings[1] !== content.nomads) {
    cache.clear();
    acts.shoresFor = [content.activities, content.nomads];
  }
  const key = (cy * width + cx) * 16 + rank;
  const known = cache.get(key);
  if (known !== undefined) return known;
  const { gregarious, shore } = content.activities.rules;
  const widest = gregarious.reach[0] + gregarious.reach[1] * (1 - content.nomads.camp.cohesion);
  const radius = Math.ceil((table.reach1[rank] ?? 0) * Math.max(1, widest)) + SHORE_MARGIN;
  const inset = Math.round(shore.inset * FIXED);
  const offsets = discOffsets(radius);
  let count = 0;
  for (let at = 0; at < offsets.length && count < MAX_SHORES; at += 2) {
    const row = cy + (offsets[at + 1] ?? 0);
    if (row < 0 || row >= height) continue;
    const column = (((cx + (offsets[at] ?? 0)) % width) + width) % width;
    const cell = row * width + column;
    if (!waterOf(state, rank, cell)) continue;
    for (let side = 0; side < SIDES.length && count < MAX_SHORES; side += 2) {
      const ox = SIDES[side] ?? 0;
      const oy = SIDES[side + 1] ?? 0;
      const nr = row + oy;
      if (nr < 0 || nr >= height) continue;
      const nc = (((column + ox) % width) + width) % width;
      if (!standable(state, nr * width + nc)) continue;
      // Le milieu du bord commun, rentré dans la case de terre.
      let px = nc * FIXED + FIXED / 2;
      let py = nr * FIXED + FIXED / 2;
      if (ox === 1) px = nc * FIXED + inset;
      else if (ox === -1) px = nc * FIXED + FIXED - inset;
      else if (oy === 1) py = nr * FIXED + inset;
      else py = nr * FIXED + FIXED - inset;
      const base = count * SHORE_STRIDE;
      shoreBuffer[base] = wrapFixedX(px, width);
      shoreBuffer[base + 1] = py;
      shoreBuffer[base + 2] = ox === 0 ? 1 : 0;
      shoreBuffer[base + 3] = cell;
      count++;
    }
  }
  const shores = shoreBuffer.slice(0, count * SHORE_STRIDE);
  if (cache.size >= MAX_SHORE_CAMPS) cache.clear();
  cache.set(key, shores);
  return shores;
}

/**
 * Les rives de l'activité de rang `rank` autour du camp (cx, cy) : SHORE_STRIDE entiers par rive
 * (CampSupplies.shores). Pour les tests et l'inspection.
 */
export function shoresOf(
  state: SimState,
  content: SimContent,
  cx: number,
  cy: number,
  rank: number,
): Int32Array {
  masksOf(state, content);
  return shoresNear(state, content, tableOf(content), rank, cx, cy);
}

/** Couverture que gèle une eau de la case `cell` : la glace d'une rivière, ou celle de son biome. */
function waterCover(state: SimState, content: SimContent, cell: number): CalendarCover | undefined {
  if ((state.cost[cell] ?? Infinity) < Infinity) return 'ice';
  const cover = content.biomes.entries.at(state.world.biome[cell] ?? 0)?.seasons.cover;
  return cover === 'ice' || cover === 'sea-ice' ? cover : undefined;
}

/**
 * Saisons et rives du camp (cx, cy) au mois du pas en cours (ADR 0021, § 1) : pour une saison de
 * plantes, de gibier ou de poisson, la part de ce rendement dans ce que rend le disque où le groupe
 * se nourrit (forage.radius, cellFood : les plafonds du mois), fois trois ; pour le dégel, la part
 * de l'eau libre, ni neige sur la case du camp, ni glace sur la plus proche de ses rives. Une
 * fonction du monde, du contenu, du camp et du mois : un cache, vidé chaque mois et au pinceau.
 */
function campSupplies(state: SimState, content: SimContent, cx: number, cy: number): CampSupplies {
  const acts = state.movement.acts;
  // Une fonction du monde, de la case et du mois de l'année : gardée d'une année à l'autre, pour
  // le contenu de `campsFor` ; vidée au pinceau, qui change les biomes (clearFields).
  if (acts.campsFor !== content || acts.camps.size >= MAX_SHORE_CAMPS) {
    acts.camps.clear();
    acts.campsFor = content;
  }
  const { width, height } = state.size;
  const key = (cy * width + cx) * MONTHS_PER_YEAR + monthOf(state.tick);
  const known = acts.camps.get(key);
  if (known !== undefined) return known;
  masksOf(state, content);
  const table = tableOf(content);
  const radius = content.nomads.forage.radius;
  const totals = new Float64Array(3);
  for (let dy = -radius; dy <= radius; dy++) {
    const row = cy + dy;
    if (row < 0 || row >= height) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > radius * radius) continue;
      const cell = row * width + ((((cx + dx) % width) + width) % width);
      const food = cellFood(state.world, state.size, state.calendars, cell, state.tick, content);
      totals[0] += food[3];
      totals[1] += food[4];
      totals[2] += food[5];
    }
  }
  const total = totals[0] + totals[1] + totals[2];
  const shores = Array.from({ length: table.count }, (_, rank) =>
    table.place[rank] === PLACE.water ? shoresNear(state, content, table, rank, cx, cy) : undefined,
  );
  const factor = new Float64Array(table.count).fill(1);
  for (let rank = 0; rank < table.count; rank++) {
    const season = table.season[rank] ?? -1;
    if (season < 0) continue;
    if (season === SEASON.thaw) {
      const snow = cellCover(
        state.world,
        state.size,
        state.calendars,
        cy * width + cx,
        state.tick,
        'snow',
        content,
      );
      const first = shores[rank];
      const water = first !== undefined && first.length > 0 ? first[3] : NO;
      const cover = water < 0 ? undefined : waterCover(state, content, water);
      const ice =
        cover === undefined
          ? 0
          : cellCover(state.world, state.size, state.calendars, water, state.tick, cover, content);
      factor[rank] = 1 - Math.max(snow, ice);
    } else {
      factor[rank] = total > 0 ? (3 * (totals[season] ?? 0)) / total : 0;
    }
  }
  const supplies: CampSupplies = { factor, shores };
  acts.camps.set(key, supplies);
  return supplies;
}

/** Goût de la culture `culture` pour chaque activité, puis son partage entre les sexes. */
function tastesOf(state: SimState, content: SimContent, culture: number): Float64Array {
  const acts = state.movement.acts;
  const list = content.activities.activities;
  if (acts.tastesList !== list) {
    acts.tastes.clear();
    acts.tastesList = list;
  }
  let tastes = acts.tastes.get(culture);
  if (tastes !== undefined) return tastes;
  tastes = new Float64Array(2 * list.length);
  const next = splitmix32(new Fingerprint().string(state.params.seed).uint32(culture).value());
  for (let rank = 0; rank < list.length; rank++) {
    const activity = list[rank];
    const u = next() / 4294967296;
    const v = next() / 4294967296;
    tastes[rank] = activity.taste[0] + (activity.taste[1] - activity.taste[0]) * u;
    tastes[list.length + rank] = activity.sex[0] + (activity.sex[1] - activity.sex[0]) * v;
  }
  acts.tastes.set(culture, tastes);
  return tastes;
}

// --- Le gibier.

/** Le gibier vivant du jour par tuiles de 8 × 8 cases, rangé à la première demande du jour. */
function preyIndex(state: SimState, day: number): void {
  const acts = state.movement.acts;
  const fauna = state.fauna;
  const tilesX = (state.size.width + 7) >> PREY_SHIFT;
  const tilesY = (state.size.height + 7) >> PREY_SHIFT;
  if (acts.preyDay === day && acts.preyHead.length === tilesX * tilesY) return;
  acts.preyDay = day;
  if (acts.preyHead.length !== tilesX * tilesY) acts.preyHead = new Int32Array(tilesX * tilesY);
  acts.preyHead.fill(NO);
  if (acts.preyNext.length < fauna.end) acts.preyNext = new Int32Array(fauna.alive.length);
  for (let slot = fauna.end - 1; slot >= 0; slot--) {
    if (fauna.alive[slot] !== 1) continue;
    const tile =
      (Math.floor((fauna.y[slot] ?? 0) / FIXED) >> PREY_SHIFT) * tilesX +
      (Math.floor((fauna.x[slot] ?? 0) / FIXED) >> PREY_SHIFT);
    acts.preyNext[slot] = acts.preyHead[tile] ?? NO;
    acts.preyHead[tile] = slot;
  }
}

/**
 * Les animaux vivants et libres (sans chasseur) les plus proches de (x, y), à `radius` cases au
 * plus, couture comprise : `count` au plus, du plus proche au plus lointain, à égalité par
 * emplacements croissants, dans `out` (ADR 0018, § 9 : faunaNear). Le gibier du jour, rangé par
 * tuiles (preyIndex) : rien du rendu ni de la caméra.
 */
export function faunaNear(
  state: SimState,
  day: number,
  x: number,
  y: number,
  radius: number,
  count: number,
  out: number[],
): number[] {
  out.length = 0;
  if (state.fauna.count === 0 || count < 1) return out;
  preyIndex(state, day);
  const acts = state.movement.acts;
  const fauna = state.fauna;
  const { width, height } = state.size;
  const tilesX = (width + 7) >> PREY_SHIFT;
  const tilesY = (height + 7) >> PREY_SHIFT;
  const span = radius * FIXED;
  const top = Math.max(0, Math.floor((y - span) / FIXED) >> PREY_SHIFT);
  const bottom = Math.min(tilesY - 1, Math.floor((y + span) / FIXED) >> PREY_SHIFT);
  const left = Math.floor((x - span) / FIXED) >> PREY_SHIFT;
  const right = Math.floor((x + span) / FIXED) >> PREY_SHIFT;
  const first = left < 0 ? left + tilesX : left;
  const distances: number[] = [];
  for (let row = top; row <= bottom; row++) {
    for (let column = left; column <= right; column++) {
      const wrapped = column < 0 ? column + tilesX : column >= tilesX ? column - tilesX : column;
      // Sur un monde étroit, deux colonnes du carré ne désignent jamais la même tuile.
      if (column !== left && wrapped === first) continue;
      for (
        let slot = acts.preyHead[row * tilesX + wrapped] ?? NO;
        slot >= 0;
        slot = acts.preyNext[slot] ?? NO
      ) {
        if (fauna.alive[slot] !== 1 || (fauna.hunter[slot] ?? 0) !== 0) continue;
        const dx = deltaFixedX(x, fauna.x[slot] ?? 0, width) / FIXED;
        const dy = ((fauna.y[slot] ?? 0) - y) / FIXED;
        const distance = dx * dx + dy * dy;
        if (distance > radius * radius) continue;
        // Rangé à sa place parmi les `count` plus proches.
        let at = out.length;
        while (
          at > 0 &&
          ((distances[at - 1] ?? 0) > distance ||
            ((distances[at - 1] ?? 0) === distance && (out[at - 1] ?? 0) > slot))
        ) {
          at--;
        }
        if (at >= count) continue;
        out.splice(at, 0, slot);
        distances.splice(at, 0, distance);
        if (out.length > count) {
          out.length = count;
          distances.length = count;
        }
      }
    }
  }
  return out;
}

/** Distance de fuite de l'animal `slot`, en cases. */
function fleeOf(state: SimState, content: SimContent, slot: number): number {
  return content.fauna.entries.at(state.fauna.species[slot] ?? 0)?.flee.distance ?? 1;
}

/**
 * Point d'affût de qui chasse l'animal `prey` depuis (hx, hy) : sur le segment de l'animal vers
 * lui, à `hunt.stalk` distances de fuite de l'animal, hors de l'alarme ; sa propre position s'il
 * en est déjà plus près. undefined sur une case où l'on ne se tient pas, ou hors de vue de lui.
 */
function stalkPoint(
  state: SimState,
  content: SimContent,
  prey: number,
  hx: number,
  hy: number,
): readonly [number, number] | undefined {
  const fauna = state.fauna;
  const { width } = state.size;
  const ax = fauna.x[prey] ?? 0;
  const ay = fauna.y[prey] ?? 0;
  const dx = deltaFixedX(ax, hx, width) / FIXED;
  const dy = (hy - ay) / FIXED;
  const length = Math.sqrt(dx * dx + dy * dy);
  const reach = content.activities.rules.hunt.stalk * fleeOf(state, content, prey);
  if (length <= reach) {
    // Déjà assez près : il reste là, s'il peut s'y tenir.
    return clearAt(state, hx, hy) ? [hx, hy] : undefined;
  }
  const px = wrapFixedX(ax + Math.round((dx / length) * reach * FIXED), width);
  const py = ay + Math.round((dy / length) * reach * FIXED);
  if (!clearAt(state, px, py)) return undefined;
  if (!segmentClear(state, hx, hy, px, py)) return undefined;
  return [px, py];
}

/** Les neuf cases autour d'un animal pris, et les stocks de l'une d'elles, repris d'une prise à l'autre. */
const preyCells = new Int32Array(9);
const preyStocks = new Float64Array(3);

/**
 * La prise de l'animal `prey` par `slot` (ADR 0021, § 4) : l'animal meurt, et l'image du gibier
 * part avec le jour (Fauna.changed) ; sa viande (`hunt.meat`, en besoins mensuels d'un adulte)
 * s'ôte du stock de gibier des neuf cases autour de lui, dans l'ordre des cases, tant qu'il en
 * reste, et va à la réserve du groupe du chasseur. Rien ne compte deux fois : le pas mensuel trouve
 * ces cases entamées et la réserve plus pleine, qu'il borne comme toujours à `reserve.months`
 * besoins du groupe (forage.ts, feedGroup).
 */
function takePrey(state: SimState, content: SimContent, slot: number, prey: number): void {
  const { fauna, food } = state;
  const { width, height } = state.size;
  const acts = state.movement.acts;
  let meat = content.fauna.entries.at(fauna.species[prey] ?? 0)?.hunt.meat ?? 0;
  const cx = Math.floor(wrapFixedX(fauna.x[prey] ?? 0, width) / FIXED);
  const cy = Math.floor((fauna.y[prey] ?? 0) / FIXED);
  fauna.remove(prey);
  fauna.changed = true;
  acts.counts.kills++;
  const group = state.society.groups.get(state.people.columns.group[slot] ?? NONE);
  if (group === undefined || !(meat > 0)) return;
  let count = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const row = cy + dy;
    if (row < 0 || row >= height) continue;
    for (let dx = -1; dx <= 1; dx++) {
      preyCells[count++] = row * width + ((((cx + dx) % width) + width) % width);
    }
  }
  let taken = 0;
  for (const cell of preyCells.subarray(0, count).sort()) {
    if (!(meat > 0)) break;
    stocksInto(
      food,
      state.world,
      state.size,
      state.calendars,
      cell,
      state.tick,
      content,
      preyStocks,
      0,
    );
    const game = preyStocks[1];
    if (!(game > 0)) continue;
    const take = Math.min(game, meat);
    const at = cell * FOOD_STRIDE;
    food.stocks[at] = preyStocks[0];
    food.stocks[at + 1] = game - take;
    food.stocks[at + 2] = preyStocks[2];
    deplete(food, cell);
    meat -= take;
    taken += take;
  }
  group.food += taken;
  acts.counts.meat += taken;
}

/** La chasse de `slot` finit : l'animal qu'il visait est libre. */
function releasePrey(state: SimState, slot: number): void {
  const acts = state.movement.acts;
  const prey = acts.prey.get(slot);
  if (prey === undefined) return;
  if (state.fauna.hunter[prey] === state.people.columns.id[slot]) state.fauna.hunter[prey] = 0;
  acts.prey.delete(slot);
}

/**
 * Les chasses en cours, d'après l'état : chaque animal vivant qu'un chasseur vise (sa colonne
 * `hunter`), si ce chasseur vit et chasse encore ; les autres réservations se libèrent. Rend les
 * chasseurs, par emplacements croissants, et tient la proie de chacun pour le jour.
 */
function huntsOf(state: SimState, content: SimContent): number[] {
  const { fauna, people } = state;
  const acts = state.movement.acts;
  const table = tableOf(content);
  const hunters: number[] = [];
  for (let animal = 0; animal < fauna.end; animal++) {
    const hunter = fauna.hunter[animal] ?? 0;
    if (hunter === 0) continue;
    const slot = fauna.alive[animal] === 1 ? people.slotOf(hunter) : undefined;
    const rank = slot === undefined ? ACT_NONE : rankOf(state, slot);
    if (slot === undefined || rank >= table.count || table.place[rank] !== PLACE.prey) {
      fauna.hunter[animal] = 0;
      continue;
    }
    acts.prey.set(slot, animal);
    hunters.push(slot);
  }
  return hunters.sort((a, b) => a - b);
}

/** Pose une étape d'arrêt dans le journal, si `slot` marche : il s'arrête là où il est. */
function cutWalk(state: SimState, slot: number, day: number): void {
  const { columns } = state.people;
  if (((columns.move[slot] ?? 0) & INTENTION) !== WALK || (columns.stepDays[slot] ?? 0) === 0) {
    return;
  }
  state.movement.journal?.push(slot, day, columns.x[slot] ?? 0, columns.y[slot] ?? 0, 0, 0, 0);
  columns.stepDays[slot] = 0;
}

/** `slot` s'arrête là où il est, au repos, son étape d'arrêt notée s'il marchait. */
function stopHere(state: SimState, slot: number, day: number): void {
  const { columns } = state.people;
  if (((columns.move[slot] ?? 0) & INTENTION) !== WALK) return;
  cutWalk(state, slot, day);
  columns.move[slot] = REST;
  columns.goalX[slot] = columns.x[slot] ?? 0;
  columns.goalY[slot] = columns.y[slot] ?? 0;
  columns.stepX[slot] = 0;
  columns.stepY[slot] = 0;
  columns.stepDays[slot] = 0;
  state.movement.removeActive(slot);
  state.movement.acts.counts.stops++;
}

/** `slot` se met en marche vers (gx, gy), sa marche en cours coupée s'il en avait une. */
function walkTo(state: SimState, slot: number, gx: number, gy: number, day: number): void {
  const { columns } = state.people;
  cutWalk(state, slot, day);
  columns.goalX[slot] = gx;
  columns.goalY[slot] = gy;
  columns.move[slot] = WALK;
  columns.stepDays[slot] = 0;
  state.movement.addActive(slot);
}

/**
 * Un jour de chasse de `slot` sur l'animal `prey` (ADR 0021, § 5) : au repos à portée du coup, il
 * frappe, une fois par chasse ; sinon il vise l'affût, là où se tient l'animal ce jour, s'il s'est
 * assez déplacé. Faux quand la chasse finit : l'animal s'est trop éloigné de sa place au camp.
 */
function huntDay(
  state: SimState,
  content: SimContent,
  slot: number,
  prey: number,
  day: number,
  random: RandomStream,
): boolean {
  const { columns } = state.people;
  const fauna = state.fauna;
  const acts = state.movement.acts;
  const { rules } = content.activities;
  const table = tableOf(content);
  const { width } = state.size;
  const rank = rankOf(state, slot);
  const hx = columns.x[slot] ?? 0;
  const hy = columns.y[slot] ?? 0;
  const ax = fauna.x[prey] ?? 0;
  const ay = fauna.y[prey] ?? 0;
  // Trop loin de sa place au camp : il renonce.
  const reach = (table.reach1[rank] ?? 0) * reachFactor(state, content, slot) + rules.hunt.leash;
  const lx = deltaFixedX(columns.homeX[slot] ?? 0, ax, width) / FIXED;
  const ly = (ay - (columns.homeY[slot] ?? 0)) / FIXED;
  if (lx * lx + ly * ly > reach * reach) {
    releasePrey(state, slot);
    acts.counts.lost++;
    return false;
  }
  const walking = ((columns.move[slot] ?? 0) & INTENTION) === WALK;
  const dx = deltaFixedX(hx, ax, width) / FIXED;
  const dy = (ay - hy) / FIXED;
  const flee = fleeOf(state, content, prey);
  const strike = rules.hunt.strike * flee;
  if (!walking && dx * dx + dy * dy <= strike * strike) {
    // Le coup : la chance de l'espèce fait la prise ; manqué, il charge en courant.
    acts.counts.strikes++;
    acts.struck.add(slot);
    const chance = content.fauna.entries.at(fauna.species[prey] ?? 0)?.hunt.chance ?? 0;
    const hit = random.nextFloat() < chance;
    releasePrey(state, slot);
    if (hit) {
      acts.counts.hits++;
      takePrey(state, content, slot, prey);
      // Il reste un jour au lieu du coup, puis choisit.
      state.movement.journal?.push(slot, day, hx, hy, 0, 0, 0);
      setUntil(state, slot, day + 1);
      return true;
    }
    acts.counts.misses++;
    // La harde l'entend le jour même, même au calme (fauna.ts, faunaDay).
    acts.misses.push(prey, hx, hy);
    // La charge court là où se tenait l'animal, si l'on peut s'y tenir ; sinon, il reste, et sa
    // chasse finit le lendemain.
    if (clearAt(state, ax, ay)) {
      columns.activity[slot] = (columns.activity[slot] ?? NO_ACTIVITY) | ACT_RUN;
      walkTo(state, slot, ax, ay, day);
      setUntil(state, slot, day + rules.hunt.charge);
    } else {
      setUntil(state, slot, day + 1);
    }
    syncSpot(state, slot);
    return true;
  }
  const point = stalkPoint(state, content, prey, hx, hy);
  if (point === undefined) return true;
  const [px, py] = point;
  // L'affût ne se revise que si l'animal s'est assez déplacé : depuis le but de qui y marche, la
  // position de qui y est.
  const revise = rules.hunt.revise;
  const fromX = walking ? (columns.goalX[slot] ?? 0) : hx;
  const fromY = walking ? (columns.goalY[slot] ?? 0) : hy;
  const mx = deltaFixedX(fromX, px, width) / FIXED;
  const my = (py - fromY) / FIXED;
  if (mx * mx + my * my < revise * revise) return true;
  if (Math.abs(deltaFixedX(hx, px, width)) <= ARRIVE && Math.abs(py - hy) <= ARRIVE) {
    // L'affût est là où il se tient (stalkPoint l'a voulu sur une case où l'on se tient).
    stopHere(state, slot, day);
  } else {
    walkTo(state, slot, px, py, day);
  }
  syncSpot(state, slot);
  return true;
}

// --- Le choix.

/**
 * Facteur des anneaux et des portées de `slot`, selon sa grégarité effective g' (ADR 0021, § 3) :
 * reach[0] + reach[1] × (1 − g'). Les grégaires restent près des leurs.
 */
function reachFactor(state: SimState, content: SimContent, slot: number): number {
  const { reach } = content.activities.rules.gregarious;
  return reach[0] + reach[1] * (1 - effectiveGregariousness(state, content, slot));
}

/** Point tiré dans l'anneau [r0, r1] autour de l'origine, par rejet dans le disque unité. */
function inRing(random: RandomStream, r0: number, r1: number, out: [number, number]): void {
  let u: number;
  let v: number;
  let length: number;
  do {
    u = 2 * random.nextFloat() - 1;
    v = 2 * random.nextFloat() - 1;
    length = Math.sqrt(u * u + v * v);
  } while (length > 1 || length === 0);
  const r = r0 + (r1 - r0) * length;
  out[0] = (u / length) * r;
  out[1] = (v / length) * r;
}

/** Le point tiré par inRing, repris d'un appel à l'autre. */
const ring: [number, number] = [0, 0];

/**
 * Le lieu (x, y) est-il libre pour `slot` : à `camp.gap` au moins de toute place tenue, hors de la
 * sienne, et de tout lieu d'activité occupé, hors du sien (critique, requis 6) ?
 */
function free(state: SimState, content: SimContent, slot: number, x: number, y: number): boolean {
  const { gap } = content.nomads.camp;
  if (state.movement.nearestHeld(x, y, gap, slot, false, gap) < gap) return false;
  return spotRoom(state, x, y, gap, slot, gap) >= gap;
}

/** Choix du lieu, repris d'un appel à l'autre. */
const preyList: number[] = [];
/** Rives essayées au plus pour un choix : `shore.choices + draws` le bornent. */
const MAX_TRIED = 32;
const shoreDistance = new Float64Array(MAX_TRIED);
const shoreOrder = new Int32Array(MAX_TRIED);
const shoreChosen = new Float64Array(2 * MAX_TRIED);

/**
 * Lieu de l'activité de rang `rank` pour `slot`, en unités, ou undefined faute de lieu libre :
 * sa place au camp (`home`) ; un point de l'anneau autour d'elle (`around`), ou autour de la place
 * de son ancre (`near`), sur une case où l'on se tient, à plantes pour la cueillette, en vue de lui ;
 * une rive libre parmi les `shore.choices` plus proches de sa place, à sa portée (`water`) ; l'affût
 * de l'un des `draws` animaux libres les plus proches de sa place (`prey`), qu'il réserve. Un
 * grégaire qui fait comme son ancre, partie à la même activité, se place près d'elle, à la chance
 * g' (ADR 0021, § 3). Anneaux et portées suivent sa grégarité (reachFactor).
 */
function spotOf(
  state: SimState,
  content: SimContent,
  slot: number,
  rank: number,
  day: number,
  random: RandomStream,
  g: number,
  anchor: number,
  anchorRank: number,
): readonly [number, number] | undefined {
  const table = tableOf(content);
  const { columns } = state.people;
  const { width } = state.size;
  const { rules } = content.activities;
  const { gap } = content.nomads.camp;
  const spots = state.movement.acts.spots;
  const x = columns.x[slot] ?? 0;
  const y = columns.y[slot] ?? 0;
  const homeX = columns.homeX[slot] ?? x;
  const homeY = columns.homeY[slot] ?? y;
  const factor = rules.gregarious.reach[0] + rules.gregarious.reach[1] * (1 - g);
  const place = table.place[rank] ?? PLACE.home;
  // Près de son ancre, partie à la même activité, s'il est grégaire.
  const kin =
    place !== PLACE.home &&
    place !== PLACE.prey &&
    anchor >= 0 &&
    rank === anchorRank &&
    spots.has(anchor) &&
    random.nextFloat() < g;
  switch (place) {
    case PLACE.home:
      return [homeX, homeY];
    case PLACE.around:
    case PLACE.near: {
      let ox = homeX;
      let oy = homeY;
      let r0 = (table.reach0[rank] ?? 0) * factor;
      let r1 = (table.reach1[rank] ?? 0) * factor;
      if (kin) {
        ox = spots.xOf(anchor);
        oy = spots.yOf(anchor);
        r0 = gap;
        r1 = 2 * gap;
      } else if (place === PLACE.near && anchor >= 0) {
        ox = columns.homeX[anchor] ?? ox;
        oy = columns.homeY[anchor] ?? oy;
      }
      const plants = table.season[rank] === SEASON.plants;
      for (let attempt = 0; attempt < rules.draws; attempt++) {
        inRing(random, r0, r1, ring);
        const px = wrapFixedX(ox + Math.round(ring[0] * FIXED), width);
        const py = oy + Math.round(ring[1] * FIXED);
        if (!clearAt(state, px, py)) continue;
        const cell = Math.floor(py / FIXED) * width + Math.floor(px / FIXED);
        if (
          plants &&
          (content.biomes.entries.at(state.world.biome[cell] ?? 0)?.forage.plants ?? 0) <= 0
        ) {
          continue;
        }
        if (!free(state, content, slot, px, py)) continue;
        if (!segmentClear(state, x, y, px, py)) continue;
        return [px, py];
      }
      return undefined;
    }
    case PLACE.water: {
      const group = state.society.groups.get(columns.group[slot] ?? NONE);
      if (group === undefined) return undefined;
      const shores = campSupplies(state, content, group.campX, group.campY).shores[rank];
      if (shores === undefined || shores.length === 0) return undefined;
      const ox = kin ? spots.xOf(anchor) : homeX;
      const oy = kin ? spots.yOf(anchor) : homeY;
      const reach = (table.reach1[rank] ?? 0) * factor;
      const count = shores.length / SHORE_STRIDE;
      // Les rives à sa portée les plus proches de son origine, `choices + draws` au plus, par une
      // passe et un rangement par insertion ; à égalité, dans l'ordre des rives du camp.
      const { spread, choices } = rules.shore;
      const limit = Math.min(MAX_TRIED, choices + rules.draws);
      let kept = 0;
      for (let at = 0; at < count; at++) {
        const ex = deltaFixedX(ox, shores[at * SHORE_STRIDE] ?? 0, width) / FIXED;
        const ey = ((shores[at * SHORE_STRIDE + 1] ?? 0) - oy) / FIXED;
        const distance = ex * ex + ey * ey;
        if (distance > reach * reach) continue;
        let place = kept;
        while (place > 0 && (shoreDistance[place - 1] ?? 0) > distance) place--;
        if (place >= limit) continue;
        for (let k = Math.min(kept, limit - 1); k > place; k--) {
          shoreDistance[k] = shoreDistance[k - 1] ?? 0;
          shoreOrder[k] = shoreOrder[k - 1] ?? 0;
        }
        shoreDistance[place] = distance;
        shoreOrder[place] = at;
        kept = Math.min(limit, kept + 1);
      }
      // Chacune tirée le long de sa rive, jusqu'à `choices` lieux libres et en vue.
      let chosen = 0;
      for (let index = 0; index < kept && chosen < choices; index++) {
        const at = shoreOrder[index] ?? 0;
        const along = shoreAlong(random.nextFloat(), spread);
        const axis = shores[at * SHORE_STRIDE + 2] ?? 0;
        const px = wrapFixedX((shores[at * SHORE_STRIDE] ?? 0) + (axis === 1 ? along : 0), width);
        const py = (shores[at * SHORE_STRIDE + 1] ?? 0) + (axis === 0 ? along : 0);
        if (!free(state, content, slot, px, py) || !segmentClear(state, x, y, px, py)) continue;
        shoreChosen[2 * chosen] = px;
        shoreChosen[2 * chosen + 1] = py;
        chosen++;
      }
      if (chosen === 0) return undefined;
      const pick = random.nextInt(chosen);
      return [shoreChosen[2 * pick] ?? 0, shoreChosen[2 * pick + 1] ?? 0];
    }
    case PLACE.prey: {
      const radius = (table.reach1[rank] ?? 0) * factor;
      const found = faunaNear(state, day, homeX, homeY, radius, rules.draws, preyList);
      if (found.length === 0) {
        state.movement.acts.counts.noprey++;
        return undefined;
      }
      for (const prey of found) {
        const point = stalkPoint(state, content, prey, x, y);
        if (point === undefined) continue;
        state.fauna.hunter[prey] = columns.id[slot] ?? 0;
        state.movement.acts.prey.set(slot, prey);
        return point;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Poids du choix en cours, repris d'un choix à l'autre. */
let weights = new Float64Array(16);

/**
 * Poids de chaque activité pour le choix de `slot`, par rang, dans `out` ; rend leur somme (ADR
 * 0021, § 1) : le poids des données, fois le facteur de son âge, de ce qu'il porte, de sa grossesse
 * et de sa faim, la saison au camp de son groupe, le goût de sa culture et le partage entre les
 * sexes ; fois 1 + rest × g' pour le repos et 1 + kin × g' pour l'activité de son ancre, si ce n'est
 * pas le repos (on cueille près d'un parent), g' sa grégarité effective. Nul pour le suivi du groupe, que seul le plan du mois donne, et pour une
 * activité au bord de l'eau sans rive au camp. Sans tirage.
 */
export function activityWeights(
  state: SimState,
  content: SimContent,
  slot: number,
  out: Float64Array,
): number {
  const table = tableOf(content);
  const { people, movement } = state;
  const { columns } = people;
  const { rules } = content.activities;
  const years = (state.tick - (columns.birth[slot] ?? 0)) / MONTHS_PER_YEAR;
  const year = Math.min(AGE_YEARS - 1, Math.max(0, Math.floor(years)));
  const carrying = (movement.childHead[slot] ?? NO) >= 0;
  const pregnant = (columns.conceived[slot] ?? NEVER) !== NEVER;
  const weak = (columns.nutrition[slot] ?? 255) / 255 < rules.weak;
  const group = state.society.groups.get(columns.group[slot] ?? NONE);
  const supplies =
    group === undefined ? undefined : campSupplies(state, content, group.campX, group.campY);
  const tastes = tastesOf(state, content, columns.culture[slot] ?? 0);
  const female = (columns.sex[slot] ?? 0) === FEMALE;
  const g = effectiveGregariousness(state, content, slot);
  const anchor = anchorOf(state, content, slot);
  const anchorRank = anchor >= 0 && people.alive[anchor] === 1 ? rankOf(state, anchor) : ACT_NONE;
  let total = 0;
  for (let rank = 0; rank < table.count; rank++) {
    out[rank] = 0;
    if (rank === table.camp) continue;
    let weight = (table.weight[rank] ?? 0) * (table.age[rank * AGE_YEARS + year] ?? 0);
    if (weight <= 0) continue;
    if (carrying) weight *= table.carrying[rank] ?? 1;
    if (pregnant) weight *= table.pregnant[rank] ?? 1;
    if (weak) weight *= table.weak[rank] ?? 1;
    if ((table.season[rank] ?? -1) >= 0) weight *= supplies?.factor[rank] ?? 0;
    weight *= tastes[rank] ?? 1;
    const share = tastes[table.count + rank] ?? 0;
    weight *= female ? 1 - share : 1 + share;
    if (table.place[rank] === PLACE.water && (supplies?.shores[rank]?.length ?? 0) === 0) continue;
    if (rank === table.home) weight *= 1 + rules.gregarious.rest * g;
    else if (rank === anchorRank) weight *= 1 + rules.gregarious.kin * g;
    if (!(weight > 0)) continue;
    out[rank] = weight;
    total += weight;
  }
  return total;
}

/**
 * Le choix de `slot`, le jour `day` (ADR 0021, § 2) : son activité, tirée selon ses poids
 * (activityWeights) ; son lieu (spotOf), faute duquel il se repose à sa place ; ses jours sur
 * place, comptés de son arrivée, ou, pour la chasse, de ce jour. Une marche coupée, ou une activité
 * qui change sur place, note son étape d'arrêt.
 */
function decide(
  state: SimState,
  content: SimContent,
  slot: number,
  day: number,
  random: RandomStream,
): void {
  const table = tableOf(content);
  const { people, movement } = state;
  const { columns } = people;
  const acts = movement.acts;
  acts.counts.decisions++;
  releasePrey(state, slot);
  const before = rankOf(state, slot);
  if (weights.length < table.count) weights = new Float64Array(table.count);
  const total = activityWeights(state, content, slot, weights);
  const g = effectiveGregariousness(state, content, slot);
  const anchor = anchorOf(state, content, slot);
  const anchorRank = anchor >= 0 && people.alive[anchor] === 1 ? rankOf(state, anchor) : ACT_NONE;
  let rank = table.home;
  if (total > 0) {
    let u = random.nextFloat() * total;
    for (let index = 0; index < table.count; index++) {
      const weight = weights[index] ?? 0;
      if (weight <= 0) continue;
      rank = index;
      u -= weight;
      if (u < 0) break;
    }
  }
  let spot = spotOf(state, content, slot, rank, day, random, g, anchor, anchorRank);
  if (spot === undefined) {
    if (rank !== table.home) acts.counts.nospot++;
    rank = table.home;
    spot = [columns.homeX[slot] ?? 0, columns.homeY[slot] ?? 0];
  }
  acts.counts.chosen[rank] = (acts.counts.chosen[rank] ?? 0) + 1;
  columns.activity[slot] = rank;
  const stay = (table.daysLow[rank] ?? 1) + random.nextInt(table.daysSpan[rank] ?? 1);
  const x = columns.x[slot] ?? 0;
  const y = columns.y[slot] ?? 0;
  const { width } = state.size;
  const [sx, sy] = spot;
  if (Math.abs(deltaFixedX(x, sx, width)) <= ARRIVE && Math.abs(sy - y) <= ARRIVE) {
    // Il y est déjà : il y reste ; une marche coupée, ou une autre activité sur place, le dit au
    // rendu par une étape d'arrêt.
    const walking = ((columns.move[slot] ?? 0) & INTENTION) === WALK;
    if (walking) stopHere(state, slot, day);
    else if (before !== rank) movement.journal?.push(slot, day, x, y, 0, 0, 0);
    setUntil(state, slot, day + stay);
    syncSpot(state, slot);
    return;
  }
  acts.counts.trips++;
  walkTo(state, slot, sx, sy, day);
  setUntil(state, slot, table.place[rank] === PLACE.prey ? day + stay : -stay);
  syncSpot(state, slot);
}

// --- Le jour.

/**
 * Les activités du jour `day` (dayIndex), entre les départs et la marche (ADR 0021, § 2) : d'abord
 * les chasses en cours, par emplacements croissants des chasseurs (affût, coup, charge) ; puis les
 * choix de ceux dont l'activité finit ce jour, par emplacements croissants. Seuls coûtent ceux-là,
 * avec un parcours du gibier pour ses réservations. Sans activités dans le contenu, rien, pas même
 * un flux.
 */
export function activitiesDay(state: SimState, content: SimContent, day: number): void {
  const acts = state.movement.acts;
  acts.prey.clear();
  acts.struck.clear();
  acts.misses.length = 0;
  const { people } = state;
  if (people.count === 0 || tableOf(content).count === 0) return;
  masksOf(state, content);
  const { columns } = people;
  const due = acts.due;
  due.length = 0;
  let random: RandomStream | undefined;
  for (const slot of huntsOf(state, content)) {
    if (columns.until[slot] === day) continue;
    random ??= state.rng.stream(ACTIVITY_STREAM);
    // La chasse finie, il choisit ce jour même.
    if (!huntDay(state, content, slot, acts.prey.get(slot) ?? NO, day, random)) {
      setUntil(state, slot, day);
    }
  }
  acts.agenda.take(day, due);
  if (due.length === 0) return;
  due.sort((a, b) => a - b);
  random ??= state.rng.stream(ACTIVITY_STREAM);
  let previous = NO;
  for (const slot of due) {
    if (slot === previous) continue;
    previous = slot;
    if (people.alive[slot] !== 1 || columns.until[slot] !== day) continue;
    const intention = (columns.move[slot] ?? 0) & INTENTION;
    if (intention === CARRIED || intention === LEAVE || !onActivity(state, content, slot)) continue;
    decide(state, content, slot, day, random);
  }
}
