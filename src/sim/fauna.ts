/**
 * Gibier (tâche 2b.6 ; FAU-01, MON-10, CRE-03 ; ADR 0018).
 *
 * Chaque animal est un individu de l'état du worker, en colonnes de tableaux typés, sans objet par
 * animal (CLAUDE.md, « Performances ») : espèce, harde, naissance, sexe, position (16.16, comme les
 * humains, core/position.ts), place visée, étape en cours, jour du départ, allure, et le chasseur
 * qui le vise (2b.8, nul en 2b.6). Une harde (une harde de biches, une compagnie de sangliers ; un
 * lièvre est une harde d'un) a son domaine, un centre et un rayon, et son but du moment.
 *
 * - Le jour (faunaDay, juste après le mouvement des humains) : une harde dont un membre voit un
 *   humain marcher à moins de `flee.distance` de lui fuit à l'opposé, chacun au galop, le jour
 *   même ; sinon, à son jour, elle choisit un but dans son domaine, d'après l'habitat, le stock de
 *   gibier des cases (2.4) et la saison, loin des camps. Chaque membre tire sa place près du but et
 *   part à son propre jour, à sa propre allure : des mouvements individuels, grégaires. Un membre en
 *   route quand sa harde change de but ou fuit coupe son étape et repart de là, le jour même. Un
 *   animal en route avance d'une addition entière par jour ; ses étapes, droites et vérifiées comme
 *   celles des humains (trace), partent au rendu avec leur allure (protocole 7).
 * - Le mois (faunaMonth, à la fin du pas mensuel) : les effectifs se tiennent au stock. La terre se
 *   découpe en territoires de `rules.territory` cases de côté ; la cible d'un territoire, pour
 *   chaque espèce, est Σ densité × habitat × (stock de gibier / plafond du mois) sur ses cases, et
 *   toutes les cibles se réduisent à proportion quand leur somme passe le plafond du monde
 *   (faunaLimit). Les vieux meurent ; au-dessus de la cible, une part de l'excès meurt ; au-dessous,
 *   aux mois de mise bas, des jeunes naissent près de leur mère ; un territoire vide où la cible le
 *   permet est parfois recolonisé par une harde d'un territoire voisin, qui s'en détache et y marche.
 *
 * Les humains ne lisent rien du gibier : leur suite ne change pas (ADR 0018, § 6). Tous les tirages
 * se font sur le flux `sim.fauna`, qui n'en décale aucun autre. Aucune trigonométrie au jour le
 * jour : des directions tirées par rejet dans le disque unité, Math.sqrt seule ; les virages de la
 * fuite se calculent une fois, par dmath.
 */
import type { Catalog } from '../core/data/catalog';
import type { FaunaRules, FaunaSpecies } from '../core/data/fauna';
import { MAX_FAUNA_SHARE, MAX_HERD } from '../core/data/fauna';
import type { Biome } from '../core/data/schemas';
import { freshArrays, type Allocator } from '../core/buffers';
import { cos, PI, sin } from '../core/dmath';
import type { Fingerprint } from '../core/hash';
import {
  FAUNA_GAIT,
  FAUNA_MALE,
  FAUNA_RUN,
  FAUNA_YOUNG,
  type FaunaFrame,
  type FaunaLegArrays,
} from '../core/protocol';
import { deltaFixedX, FIXED, wrapFixedX } from '../core/position';
import { splitmix32, type RandomStream } from '../core/rng';
import { seasonFactor } from '../core/seasons';
import { dayIndex } from '../core/time';
import { gameCap, gameSeason, type ForageContent } from './forage';
import { LegJournal, MAX_LEG_DAYS, MAX_STEP, trace } from './movement';
import { monthOf, MONTHS_PER_YEAR } from './people';
import type { SimState } from './state';

/** Aucun emplacement. */
const NO = -1;
/** Le flux des tirages du gibier, qui n'en décale aucun autre. */
export const FAUNA_STREAM = 'sim.fauna';
/** Côté des tuiles de la présence des humains, en cases : celles de Movement.heldInTile. */
const HUMAN_TILE_SHIFT = 3;
const TWO_POW_32 = 4294967296;

/** Le contenu dont le gibier se sert. */
export interface FaunaContent extends ForageContent {
  readonly fauna: Catalog<FaunaSpecies>;
  readonly faunaRules: FaunaRules;
  readonly biomes: Catalog<Biome>;
}

/** Tableau typé agrandi à `size` au moins, contenu gardé, le reste rempli de `fill`. */
function grow<T extends Uint8Array | Uint16Array | Uint32Array | Int32Array>(
  array: T,
  size: number,
  fill = 0,
): T {
  if (array.length >= size) return array;
  const Kind = array.constructor as new (length: number) => T;
  const next = new Kind(Math.max(size, array.length * 2, 64));
  if (fill !== 0) next.fill(fill);
  next.set(array);
  return next;
}

/**
 * Étapes du gibier commencées, dans l'ordre où elles commencent, et l'allure de chacune : l'hôte
 * les envoie avec chaque lot de jours (protocole 7). Une étape de zéro jour dit qu'un animal s'arrête
 * là : une étape du même jour la remplace (LegQueue). Ce n'est pas l'état : sans hôte, il n'y en a pas.
 */
export class FaunaJournal {
  private readonly legs = new LegJournal();
  private gaits = new Uint8Array(256);

  get count(): number {
    return this.legs.count;
  }

  push(
    slot: number,
    day: number,
    x: number,
    y: number,
    sx: number,
    sy: number,
    days: number,
    gait: number,
  ): void {
    const at = this.legs.count;
    if (at >= this.gaits.length) this.gaits = grow(this.gaits, at + 1);
    this.gaits[at] = gait;
    this.legs.push(slot, day, x, y, sx, sy, days);
  }

  /** Les étapes notées, dans des tableaux au plus juste, pris de `arrays` ; le journal se vide. */
  take(arrays: Allocator = freshArrays): FaunaLegArrays {
    const n = this.legs.count;
    const gaits = arrays.uint8(n);
    gaits.set(this.gaits.subarray(0, n));
    return { ...this.legs.take(arrays), gaits };
  }
}

/** Les animaux et leurs hardes, en colonnes ; ordre des emplacements et piles libres compris. */
export class Fauna {
  // --- Animaux, par emplacement.
  end = 0;
  count = 0;
  alive = new Uint8Array(0);
  id = new Uint32Array(0);
  species = new Uint8Array(0);
  herd = new Int32Array(0);
  /** Pas mensuel de sa naissance (négatif pour un animal semé adulte). */
  born = new Int32Array(0);
  /** 1 pour un mâle. */
  sex = new Uint8Array(0);
  x = new Int32Array(0);
  y = new Int32Array(0);
  placeX = new Int32Array(0);
  placeY = new Int32Array(0);
  stepX = new Int32Array(0);
  stepY = new Int32Array(0);
  stepDays = new Uint16Array(0);
  /** Jour (dayIndex) où il part vers sa place, NO sans départ prévu. */
  depart = new Int32Array(0);
  /** Allure de son étape, ou de la prochaine : FAUNA_GAIT. */
  gait = new Uint8Array(0);
  /** Le chasseur qui le vise (identifiant d'un humain), 0 sans chasseur : 2b.8. */
  hunter = new Uint32Array(0);
  free: number[] = [];
  nextId = 1;
  // --- Hardes, par emplacement.
  herdEnd = 0;
  herdCount = 0;
  herdAlive = new Uint8Array(0);
  herdId = new Uint32Array(0);
  herdSpecies = new Uint8Array(0);
  /** Centre du domaine : une case. */
  homeX = new Int32Array(0);
  homeY = new Int32Array(0);
  /** But du moment, en unités. */
  goalX = new Int32Array(0);
  goalY = new Int32Array(0);
  /** Jour (dayIndex) du prochain but, et fin du calme qui suit une fuite. */
  next = new Int32Array(0);
  calm = new Int32Array(0);
  herdFree: number[] = [];
  nextHerdId = 1;
  // --- Caches, hors de la sauvegarde et de l'empreinte (rebuildFauna).
  /** Membres de chaque harde, par emplacements croissants : le premier, puis le suivant de chacun. */
  head = new Int32Array(0);
  nextMember = new Int32Array(0);
  size = new Uint16Array(0);
  /** Cibles de base, par territoire et par espèce, l'habitat seul (faunaBase) ; undefined à refaire. */
  base: Float64Array | undefined;
  /** Cibles du mois, refaites à chaque demande (faunaTargets). */
  target = new Float64Array(0);
  /** Hardes de chaque territoire et de chaque espèce, au mois (faunaMonth). */
  keyHead = new Int32Array(0);
  keyNext = new Int32Array(0);
  /** Les animaux du jour par tuiles de 8 × 8 cases, et les alarmes de chaque harde (alarms). */
  gridHead = new Int32Array(0);
  gridNext = new Int32Array(0);
  witness = new Int32Array(0);
  alarmBy = new Int32Array(0);
  alarmX = new Int32Array(0);
  alarmY = new Int32Array(0);
  /** Étapes commencées, que l'hôte envoie au rendu ; aucune sans hôte. */
  journal: FaunaJournal | undefined;
  /**
   * Des animaux sont apparus ou ont disparu hors du pas mensuel (une commande, la chasse de 2b.8) :
   * l'hôte joint une image du gibier à son prochain delta, puis efface la marque.
   */
  changed = false;
  /** Les humains du jour, par tuiles de 8 × 8 cases (cache, refait chaque jour à la première demande). */
  readonly humans = new HumanIndex();
  /** Comptes, pour les mesures et les tests. */
  readonly counts = {
    legs: 0,
    cut: 0,
    stuck: 0,
    flights: 0,
    cornered: 0,
    roams: 0,
    births: 0,
    deaths: 0,
    aged: 0,
    colonized: 0,
  };

  ensure(size: number): void {
    if (this.alive.length >= size) return;
    this.alive = grow(this.alive, size);
    this.id = grow(this.id, size);
    this.species = grow(this.species, size);
    this.herd = grow(this.herd, size, NO);
    this.born = grow(this.born, size);
    this.sex = grow(this.sex, size);
    this.x = grow(this.x, size);
    this.y = grow(this.y, size);
    this.placeX = grow(this.placeX, size);
    this.placeY = grow(this.placeY, size);
    this.stepX = grow(this.stepX, size);
    this.stepY = grow(this.stepY, size);
    this.stepDays = grow(this.stepDays, size);
    this.depart = grow(this.depart, size, NO);
    this.gait = grow(this.gait, size);
    this.hunter = grow(this.hunter, size);
    this.nextMember = grow(this.nextMember, size, NO);
  }

  ensureHerds(size: number): void {
    if (this.herdAlive.length >= size) return;
    this.herdAlive = grow(this.herdAlive, size);
    this.herdId = grow(this.herdId, size);
    this.herdSpecies = grow(this.herdSpecies, size);
    this.homeX = grow(this.homeX, size);
    this.homeY = grow(this.homeY, size);
    this.goalX = grow(this.goalX, size);
    this.goalY = grow(this.goalY, size);
    this.next = grow(this.next, size);
    this.calm = grow(this.calm, size);
    this.head = grow(this.head, size, NO);
    this.size = grow(this.size, size);
    this.keyNext = grow(this.keyNext, size, NO);
  }

  /** Une harde nouvelle, vide ; renvoie son emplacement. */
  addHerd(
    species: number,
    homeX: number,
    homeY: number,
    goalX: number,
    goalY: number,
    next: number,
  ): number {
    const slot = this.herdFree.pop() ?? this.herdEnd++;
    this.ensureHerds(slot + 1);
    this.herdAlive[slot] = 1;
    this.herdId[slot] = this.nextHerdId++;
    this.herdSpecies[slot] = species;
    this.homeX[slot] = homeX;
    this.homeY[slot] = homeY;
    this.goalX[slot] = goalX;
    this.goalY[slot] = goalY;
    this.next[slot] = next;
    this.calm[slot] = 0;
    this.head[slot] = NO;
    this.size[slot] = 0;
    this.herdCount++;
    return slot;
  }

  /** Retire une harde vide. */
  removeHerd(slot: number): void {
    if (this.herdAlive[slot] !== 1) return;
    this.herdAlive[slot] = 0;
    this.herdCount--;
    this.herdFree.push(slot);
  }

  /** Un animal nouveau, au repos sur (x, y), dans la harde `herd` ; renvoie son emplacement. */
  add(species: number, herd: number, born: number, sex: number, x: number, y: number): number {
    const slot = this.free.pop() ?? this.end++;
    this.ensure(slot + 1);
    this.alive[slot] = 1;
    this.id[slot] = this.nextId++;
    this.species[slot] = species;
    this.born[slot] = born;
    this.sex[slot] = sex;
    this.x[slot] = x;
    this.y[slot] = y;
    this.placeX[slot] = x;
    this.placeY[slot] = y;
    this.stepX[slot] = 0;
    this.stepY[slot] = 0;
    this.stepDays[slot] = 0;
    this.depart[slot] = NO;
    this.gait[slot] = FAUNA_GAIT.rest;
    this.hunter[slot] = 0;
    this.count++;
    this.herd[slot] = NO;
    this.join(slot, herd);
    return slot;
  }

  /** Retire un animal. */
  remove(slot: number): void {
    if (this.alive[slot] !== 1) return;
    this.leave(slot);
    this.alive[slot] = 0;
    this.count--;
    this.free.push(slot);
  }

  /** Fait passer un animal dans la harde `herd`, sans rien changer d'autre de lui. */
  moveTo(slot: number, herd: number): void {
    if (this.herd[slot] === herd) return;
    this.leave(slot);
    this.join(slot, herd);
  }

  /** Membres d'une harde, par emplacements croissants, dans `out`. */
  members(herd: number, out: number[]): number[] {
    out.length = 0;
    for (let at = this.head[herd] ?? NO; at >= 0; at = this.nextMember[at] ?? NO) out.push(at);
    return out;
  }

  /**
   * Rang d'un animal dans la liste de sa harde, rangée par emplacements croissants : la liste se
   * parcourt dans un ordre canonique, le même après un chargement (rebuildFauna).
   */
  private join(slot: number, herd: number): void {
    let previous = NO;
    let at = this.head[herd] ?? NO;
    while (at >= 0 && at < slot) {
      previous = at;
      at = this.nextMember[at] ?? NO;
    }
    this.nextMember[slot] = at;
    if (previous >= 0) this.nextMember[previous] = slot;
    else this.head[herd] = slot;
    this.size[herd] = (this.size[herd] ?? 0) + 1;
    this.herd[slot] = herd;
  }

  private leave(slot: number): void {
    const herd = this.herd[slot] ?? NO;
    if (herd < 0) return;
    let previous = NO;
    for (let at = this.head[herd] ?? NO; at >= 0; at = this.nextMember[at] ?? NO) {
      if (at === slot) {
        const next = this.nextMember[slot] ?? NO;
        if (previous >= 0) this.nextMember[previous] = next;
        else this.head[herd] = next;
        break;
      }
      previous = at;
    }
    this.size[herd] = Math.max(0, (this.size[herd] ?? 1) - 1);
    this.nextMember[slot] = NO;
    this.herd[slot] = NO;
  }
}

/** Refait les caches (membres, tailles, cibles, présence des humains) d'après les colonnes. */
export function rebuildFauna(fauna: Fauna): void {
  fauna.ensureHerds(fauna.herdEnd);
  fauna.ensure(fauna.end);
  fauna.head.fill(NO);
  fauna.size.fill(0);
  fauna.nextMember.fill(NO);
  for (let slot = fauna.end - 1; slot >= 0; slot--) {
    if (fauna.alive[slot] !== 1) continue;
    const herd = fauna.herd[slot] ?? NO;
    if (herd < 0) continue;
    fauna.nextMember[slot] = fauna.head[herd] ?? NO;
    fauna.head[herd] = slot;
    fauna.size[herd] = (fauna.size[herd] ?? 0) + 1;
  }
  fauna.base = undefined;
  fauna.humans.day = NO;
}

// --- Habitat, territoires et cibles.

const habitats = new WeakMap<Catalog<Biome>, WeakMap<Catalog<FaunaSpecies>, Float32Array[]>>();

/** Qualité de l'habitat de chaque biome, par espèce (data/biomes.json, fauna). */
export function habitatTable(content: Pick<FaunaContent, 'biomes' | 'fauna'>): Float32Array[] {
  let bySpecies = habitats.get(content.biomes);
  if (bySpecies === undefined) {
    bySpecies = new WeakMap();
    habitats.set(content.biomes, bySpecies);
  }
  let table = bySpecies.get(content.fauna);
  if (table === undefined) {
    table = content.fauna.entries.map((species) =>
      Float32Array.from(content.biomes.entries, (biome) => biome.fauna[species.id] ?? 0),
    );
    bySpecies.set(content.fauna, table);
  }
  return table;
}

const anyHabitats = new WeakMap<Float32Array[], Uint8Array>();

/** 1 pour un biome où vit au moins une espèce. */
function habitatAny(content: Pick<FaunaContent, 'biomes' | 'fauna'>): Uint8Array {
  const table = habitatTable(content);
  let any = anyHabitats.get(table);
  if (any === undefined) {
    any = Uint8Array.from(content.biomes.entries, (_, biome) =>
      table.some((row) => (row[biome] ?? 0) > 0) ? 1 : 0,
    );
    anyHabitats.set(table, any);
  }
  return any;
}

/** Territoires du monde, en colonnes et en rangées (rules.territory divise chaque taille de monde). */
export function territoriesOf(
  state: Pick<SimState, 'size'>,
  rules: FaunaRules,
): { columns: number; rows: number } {
  return {
    columns: Math.ceil(state.size.width / rules.territory),
    rows: Math.ceil(state.size.height / rules.territory),
  };
}

/** Territoire de la case (column, row), column dans le monde. */
export function territoryOf(
  state: Pick<SimState, 'size'>,
  rules: FaunaRules,
  column: number,
  row: number,
): number {
  const side = rules.territory;
  const columns = Math.ceil(state.size.width / side);
  return Math.floor(row / side) * columns + Math.floor(column / side);
}

/** Cibles de base : Σ densité × habitat sur les cases de chaque territoire, par espèce. */
export function faunaBase(state: SimState, content: FaunaContent): Float64Array {
  const table = habitatTable(content);
  const species = content.fauna.entries;
  const count = species.length;
  const { columns, rows } = territoriesOf(state, content.faunaRules);
  const base = new Float64Array(columns * rows * count);
  const { width, height } = state.size;
  const biome = state.world.biome;
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const b = biome[row * width + column] ?? 0;
      const tile = territoryOf(state, content.faunaRules, column, row);
      for (let s = 0; s < count; s++) {
        const quality = table[s]?.[b] ?? 0;
        if (quality > 0) {
          const key = tile * count + s;
          base[key] = (base[key] ?? 0) + quality * (species[s]?.density ?? 0);
        }
      }
    }
  }
  return base;
}

/**
 * Part du gibier d'une case qui reste : son stock sur son plafond du mois (gameCap, la formule de
 * forage.ts), 1 si personne ne l'a entamée.
 */
export function gameRatio(state: SimState, cell: number, content: FaunaContent): number {
  if (state.food.depleted[cell] !== 1) return 1;
  const cap = gameCap(state.world, state.size, cell, state.tick, content);
  if (!(cap > 0)) return 0;
  return Math.min(1, Math.max(0, (state.food.stocks[cell * 3 + 1] ?? 0) / cap));
}

/** Plus d'animaux que cela, jamais, sur ce monde. */
export function faunaLimit(state: Pick<SimState, 'size'>): number {
  return Math.floor(state.size.width * state.size.height * MAX_FAUNA_SHARE);
}

/**
 * Cibles du mois, par territoire et par espèce : la base, moins ce que la chasse a pris sur les
 * cases entamées ; puis, si leur somme passe le plafond du monde, toutes réduites à proportion, si
 * bien que le plafond se partage, au lieu de remplir le monde d'un bord à l'autre jusqu'à lui.
 */
export function faunaTargets(state: SimState, content: FaunaContent): Float64Array {
  const fauna = state.fauna;
  fauna.base ??= faunaBase(state, content);
  if (fauna.target.length !== fauna.base.length) fauna.target = new Float64Array(fauna.base.length);
  const target = fauna.target;
  target.set(fauna.base);
  const table = habitatTable(content);
  const species = content.fauna.entries;
  const count = species.length;
  const { width } = state.size;
  const { depleted } = state.food;
  const anyHabitat = habitatAny(content);
  // Quatre cases à la fois : la plupart sont intactes (forage.ts, regrowFood).
  const words = new Uint32Array(depleted.buffer, 0, depleted.length >> 2);
  for (let cell = 0; cell < depleted.length; cell++) {
    if ((cell & 3) === 0 && cell >> 2 < words.length && words[cell >> 2] === 0) {
      cell += 3;
      continue;
    }
    if (depleted[cell] !== 1) continue;
    const b = state.world.biome[cell] ?? 0;
    if (anyHabitat[b] !== 1) continue;
    const ratio = gameRatio(state, cell, content);
    if (ratio >= 1) continue;
    const row = Math.floor(cell / width);
    const tile = territoryOf(state, content.faunaRules, cell - row * width, row);
    for (let s = 0; s < count; s++) {
      const quality = table[s]?.[b] ?? 0;
      if (quality > 0) {
        const key = tile * count + s;
        target[key] = (target[key] ?? 0) - quality * (species[s]?.density ?? 0) * (1 - ratio);
      }
    }
  }
  let total = 0;
  for (const value of target) if (value > 0) total += value;
  const limit = faunaLimit(state);
  if (total > limit) {
    const share = limit / total;
    for (let key = 0; key < target.length; key++) target[key] = (target[key] ?? 0) * share;
  }
  return target;
}

// --- Outils du mouvement.

function passableAt(state: SimState, x: number, y: number): boolean {
  const { width, height } = state.size;
  const row = Math.floor(y / FIXED);
  if (row < 0 || row >= height) return false;
  const column = Math.floor(wrapFixedX(x, width) / FIXED);
  return Number.isFinite(state.cost[row * width + column] ?? Number.POSITIVE_INFINITY);
}

function cellAt(state: SimState, x: number, y: number): number {
  const { width } = state.size;
  return Math.floor(y / FIXED) * width + Math.floor(wrapFixedX(x, width) / FIXED);
}

/** Un point du disque unité, par rejet (aucune trigonométrie, ADR 0014), écrit dans `disk`. */
const disk = new Float64Array(2);
function inDisk(random: RandomStream): Float64Array {
  for (let tries = 0; tries < 8; tries++) {
    const u = random.nextFloat() * 2 - 1;
    const v = random.nextFloat() * 2 - 1;
    if (u * u + v * v <= 1) {
      disk[0] = u;
      disk[1] = v;
      return disk;
    }
  }
  disk[0] = 0;
  disk[1] = 0;
  return disk;
}

/**
 * Allure propre d'un animal, d'après son identifiant (splitmix32, crédité) : pace × (1 − jitter +
 * 2 × jitter × u), u dans [0, 1[, la même d'une étape à l'autre et après un chargement.
 */
export function ownPace(pace: number, id: number, jitter: number): number {
  const u = splitmix32(id)() / TWO_POW_32;
  return pace * (1 - jitter + 2 * jitter * u);
}

const turnTables = new WeakMap<FaunaRules, Float64Array>();

/** Directions de la fuite, par paires (cos, sin) : l'opposé de l'humain, puis chaque virage. */
function fleeTurns(rules: FaunaRules): Float64Array {
  const known = turnTables.get(rules);
  if (known !== undefined) return known;
  const turns = new Float64Array(2 + 2 * rules.turns.length);
  turns[0] = 1;
  turns[1] = 0;
  rules.turns.forEach((degrees, index) => {
    const angle = (degrees * PI) / 180;
    turns[2 + 2 * index] = cos(angle);
    turns[3 + 2 * index] = sin(angle);
  });
  turnTables.set(rules, turns);
  return turns;
}

/**
 * Les humains du jour, pour le gibier : la présence des marcheurs par tuiles de 8 × 8 cases, faite
 * une fois par jour, à la première demande, et les places tenues de chaque tuile
 * (Movement.heldInTile : repos, partance, buts des marcheurs), que le mouvement des humains compte
 * sans rien changer à leurs choix.
 */
export class HumanIndex {
  day = NO;
  tilesX = 0;
  tilesY = 0;
  /** 1 pour une tuile où marche au moins un humain ce jour. */
  walkers = new Uint8Array(0);
  held: Uint32Array = new Uint32Array(0);

  build(state: SimState): void {
    const today = dayIndex(state);
    if (this.day === today) return;
    this.day = today;
    this.listed = NO;
    const { width, height } = state.size;
    this.tilesX = (width + 7) >> HUMAN_TILE_SHIFT;
    this.tilesY = (height + 7) >> HUMAN_TILE_SHIFT;
    const tiles = this.tilesX * this.tilesY;
    if (this.walkers.length !== tiles) this.walkers = new Uint8Array(tiles);
    this.walkers.fill(0);
    const { people, movement } = state;
    const { x, y } = people.columns;
    this.held = movement.heldInTile;
    for (let index = 0; index < movement.activeCount; index++) {
      const slot = movement.active[index] ?? 0;
      if (!movement.isActive(slot)) continue;
      const tile = this.tileAt(x[slot] ?? 0, y[slot] ?? 0);
      if (tile >= 0) this.walkers[tile] = 1;
    }
  }

  /** Tuile de la position (x, y), en unités, x dans le monde ; −1 hors du monde. */
  tileAt(x: number, y: number): number {
    const row = Math.floor(y / FIXED) >> HUMAN_TILE_SHIFT;
    const column = Math.floor(x / FIXED) >> HUMAN_TILE_SHIFT;
    if (row < 0 || row >= this.tilesY || column < 0 || column >= this.tilesX) return NO;
    return row * this.tilesX + column;
  }

  /**
   * Un humain marche-t-il (`walking`), ou se tient-il, au repos comme en marche, dans une tuile que
   * touche le carré de côté 2 × limit cases autour du point (px, py) ?
   */
  any(px: number, py: number, limit: number, walking: boolean): boolean {
    const reach = limit * FIXED;
    const top = Math.max(0, Math.floor((py - reach) / FIXED) >> HUMAN_TILE_SHIFT);
    const bottom = Math.min(this.tilesY - 1, Math.floor((py + reach) / FIXED) >> HUMAN_TILE_SHIFT);
    const left = Math.floor((px - reach) / FIXED) >> HUMAN_TILE_SHIFT;
    const right = Math.floor((px + reach) / FIXED) >> HUMAN_TILE_SHIFT;
    for (let row = top; row <= bottom; row++) {
      for (let column = left; column <= right; column++) {
        const tile = row * this.tilesX + (((column % this.tilesX) + this.tilesX) % this.tilesX);
        if (this.walkers[tile] === 1) return true;
        if (!walking && (this.held[tile] ?? 0) > 0) return true;
      }
    }
    return false;
  }

  /** Jour des listes des humains par tuile (`nearest`), refaites à la première demande du jour. */
  private listed = NO;
  /** Premier humain de chaque tuile, puis le suivant de chacun : par emplacements croissants. */
  private head = new Int32Array(0);
  private link = new Int32Array(0);

  /**
   * Les humains vivants rangés par tuiles de 8 × 8 cases, à leur position du jour : une fois par
   * jour, à la première demande, si bien que seules les hardes qu'un camp gêne les font.
   */
  private list(state: SimState): void {
    const today = dayIndex(state);
    const tiles = this.tilesX * this.tilesY;
    if (this.listed === today && this.head.length === tiles) return;
    this.listed = today;
    const { people } = state;
    const { x, y } = people.columns;
    if (this.head.length !== tiles) this.head = new Int32Array(tiles);
    this.head.fill(NO);
    if (this.link.length < people.end) this.link = new Int32Array(people.end * 2);
    for (let slot = people.end - 1; slot >= 0; slot--) {
      if (people.alive[slot] !== 1) continue;
      const tile = this.tileAt(x[slot] ?? 0, y[slot] ?? 0);
      if (tile < 0) continue;
      this.link[slot] = this.head[tile] ?? NO;
      this.head[tile] = slot;
    }
  }

  /**
   * Distance, en cases, du point (px, py) au plus proche des humains vivants, à leur position du
   * jour, au plus court à travers la couture ; `limit` au plus, et `limit` si aucun ne s'en
   * approche à moins de `limit`.
   */
  nearest(state: SimState, px: number, py: number, limit: number): number {
    return this.scan(state, px, py, limit, false);
  }

  /**
   * Un humain vivant se tient-il à moins de `bound` cases du point (px, py) ? La même réponse que
   * nearest(…, bound) < bound, sans chercher plus loin que le premier.
   */
  closer(state: SimState, px: number, py: number, bound: number): boolean {
    return this.scan(state, px, py, bound, true) < bound;
  }

  private scan(state: SimState, px: number, py: number, limit: number, first: boolean): number {
    this.list(state);
    const { x, y } = state.people.columns;
    const { width } = state.size;
    const reach = limit * FIXED;
    const top = Math.max(0, Math.floor((py - reach) / FIXED) >> HUMAN_TILE_SHIFT);
    const bottom = Math.min(this.tilesY - 1, Math.floor((py + reach) / FIXED) >> HUMAN_TILE_SHIFT);
    const left = Math.floor((px - reach) / FIXED) >> HUMAN_TILE_SHIFT;
    const right = Math.floor((px + reach) / FIXED) >> HUMAN_TILE_SHIFT;
    let best = limit * limit;
    for (let row = top; row <= bottom; row++) {
      for (let column = left; column <= right; column++) {
        const tile = row * this.tilesX + (((column % this.tilesX) + this.tilesX) % this.tilesX);
        for (let slot = this.head[tile] ?? NO; slot !== NO; slot = this.link[slot] ?? NO) {
          const dx = deltaFixedX(px, x[slot] ?? 0, width) / FIXED;
          const dy = ((y[slot] ?? 0) - py) / FIXED;
          best = Math.min(best, dx * dx + dy * dy);
          if (first && Math.sqrt(best) < limit) return Math.sqrt(best);
        }
      }
    }
    return Math.sqrt(best);
  }
}

/** Le facteur de saison du dernier instant demandé (seasonFactor, dmath), gardé d'un appel à l'autre. */
let seasonMonth = Number.NaN;
let seasonValue = 0;

function seasonAt(month: number): number {
  if (month !== seasonMonth) {
    seasonMonth = month;
    seasonValue = seasonFactor(month);
  }
  return seasonValue;
}

/** Mois continu du jour en cours, de 0 à 12 (le milieu du jour). */
function monthOfDay(state: SimState): number {
  return monthOf(state.tick) - 0.5 + (state.day + 0.5) / 30;
}

/**
 * Note d'une case pour l'espèce `s`, à la saison `factor` : habitat × stock de gibier restant ×
 * saison du gibier (gameSeason à la température du jour), si bien que l'hiver pousse les hardes
 * vers les cases plus chaudes de leur domaine, et la chasse hors des cases entamées.
 */
function score(
  state: SimState,
  content: FaunaContent,
  s: number,
  cell: number,
  factor: number,
): number {
  const quality = habitatTable(content)[s]?.[state.world.biome[cell] ?? 0] ?? 0;
  if (quality <= 0) return 0;
  const { width, height } = state.size;
  const row = Math.floor(cell / width);
  const season = row >= height / 2 ? -factor : factor;
  const temperature =
    ((state.world.temperature[cell] ?? 0) + (state.world.amplitude[cell] ?? 0) * season) / 10;
  return (
    quality *
    gameRatio(state, cell, content) *
    gameSeason(temperature, content.nomads.stocks.game.cold)
  );
}

// --- Le jour.

/** Places déjà prises d'une harde, x puis y, et ses membres : repris d'un appel à l'autre. */
const taken: number[] = [];
const listed: number[] = [];

/**
 * Les membres d'une harde visent leur place autour de son but, à `gap` au moins les uns des autres,
 * et partent à leur jour : au galop, tous le jour même ; au pas, chacun jusqu'à `lag` jours plus
 * tard. Un membre en route coupe son étape là où il est, ce jour, et repart d'ici le jour même :
 * l'étape d'arrêt notée au journal ne vaut que s'il ne peut repartir (FaunaJournal).
 */
function scatter(
  state: SimState,
  content: FaunaContent,
  herd: number,
  today: number,
  gait: number,
  random: RandomStream,
): void {
  const fauna = state.fauna;
  const species = content.fauna.entries.at(fauna.herdSpecies[herd] ?? 0);
  if (species === undefined) return;
  const { width } = state.size;
  const gx = fauna.goalX[herd] ?? 0;
  const gy = fauna.goalY[herd] ?? 0;
  const tries = content.faunaRules.draws.place;
  const gap = species.gap * species.gap;
  taken.length = 0;
  for (const slot of fauna.members(herd, listed)) {
    // La première place libre à `gap` des autres ; à défaut, la moins serrée des places tirées,
    // et le but lui-même si aucune ne se franchit.
    let px = gx;
    let py = gy;
    let roomiest = -1;
    for (let attempt = 0; attempt < tries; attempt++) {
      const d = inDisk(random);
      const cx = gx + Math.round(d[0] * species.spread * FIXED);
      const cy = gy + Math.round(d[1] * species.spread * FIXED);
      if (!passableAt(state, cx, cy)) continue;
      let nearest = Number.POSITIVE_INFINITY;
      for (let at = 0; at < taken.length; at += 2) {
        const dx = deltaFixedX(cx, taken[at] ?? 0, width) / FIXED;
        const dy = ((taken[at + 1] ?? 0) - cy) / FIXED;
        nearest = Math.min(nearest, dx * dx + dy * dy);
      }
      if (nearest > roomiest) {
        roomiest = nearest;
        px = cx;
        py = cy;
      }
      if (nearest >= gap) break;
    }
    taken.push(px, py);
    fauna.placeX[slot] = wrapFixedX(px, width);
    fauna.placeY[slot] = py;
    fauna.gait[slot] = gait;
    if ((fauna.stepDays[slot] ?? 0) > 0) {
      fauna.stepX[slot] = 0;
      fauna.stepY[slot] = 0;
      fauna.stepDays[slot] = 0;
      fauna.depart[slot] = today;
      fauna.counts.cut++;
      fauna.journal?.push(
        slot,
        today,
        fauna.x[slot] ?? 0,
        fauna.y[slot] ?? 0,
        0,
        0,
        0,
        FAUNA_GAIT.rest,
      );
    } else {
      fauna.depart[slot] =
        gait === FAUNA_GAIT.run
          ? today
          : today + Math.floor(random.nextFloat() * (species.lag + 1));
    }
  }
}

const candidateValue = new Float64Array(8);
const candidateX = new Float64Array(8);
const candidateY = new Float64Array(8);

/** Jour du prochain but : `rest` jours de repos, tirés dans leur étendue. */
function restUntil(species: FaunaSpecies, today: number, random: RandomStream): number {
  const [low, high] = species.rest;
  return today + low + Math.floor(random.nextFloat() * (high - low + 1));
}

/**
 * Un nouveau but pour la harde, dans son domaine : le meilleur de quelques tirages, à `roam` cases
 * du but actuel, notés d'abord (score) ; les plus chers des contrôles, les camps et la vue depuis
 * l'ancien but, ne se font que dans l'ordre des notes, jusqu'au premier qui passe. Hors de son
 * domaine (après une fuite, ou pour une harde qui recolonise un territoire), elle y revient : ses
 * tirages vont vers le centre, au plus loin de `roam`, et chacun doit l'en rapprocher, même par une
 * case sans habitat.
 */
function roam(
  state: SimState,
  content: FaunaContent,
  herd: number,
  today: number,
  random: RandomStream,
): void {
  const fauna = state.fauna;
  const s = fauna.herdSpecies[herd] ?? 0;
  const species = content.fauna.entries.at(s);
  if (species === undefined) return;
  const rules = content.faunaRules;
  const { width, height } = state.size;
  const gx = fauna.goalX[herd] ?? 0;
  const gy = fauna.goalY[herd] ?? 0;
  const hx = ((fauna.homeX[herd] ?? 0) + 0.5) * FIXED;
  const hy = ((fauna.homeY[herd] ?? 0) + 0.5) * FIXED;
  const ox = deltaFixedX(hx, gx, width) / FIXED;
  const oy = (gy - hy) / FIXED;
  const away = Math.sqrt(ox * ox + oy * oy);
  const homing = away > species.range;
  const factor = seasonAt(monthOfDay(state));
  let found = 0;
  for (let attempt = 0; attempt < rules.draws.goal; attempt++) {
    const d = inDisk(random);
    const reach = homing
      ? species.roam[1]
      : species.roam[0] + random.nextFloat() * (species.roam[1] - species.roam[0]);
    const jitter = 0.8 + 0.2 * random.nextFloat();
    let ux = d[0];
    let uy = d[1];
    if (homing) {
      ux = -ox / away + 0.5 * ux;
      uy = -oy / away + 0.5 * uy;
    }
    const length = Math.sqrt(ux * ux + uy * uy);
    if (length < 1e-6) continue;
    const cx = gx + Math.round((ux / length) * reach * FIXED);
    const cy = gy + Math.round((uy / length) * reach * FIXED);
    if (!passableAt(state, cx, cy)) continue;
    const dx = deltaFixedX(hx, cx, width) / FIXED;
    const dy = (cy - hy) / FIXED;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (homing ? distance >= away : distance > species.range) continue;
    const note = score(state, content, s, cellAt(state, cx, cy), factor);
    const value = (homing ? Math.max(note, 1e-3) : note) * jitter;
    if (value <= 0) continue;
    // Rangé par note décroissante, à égalité dans l'ordre des tirages.
    let at = found++;
    while (at > 0 && (candidateValue[at - 1] ?? 0) < value) {
      candidateValue[at] = candidateValue[at - 1] ?? 0;
      candidateX[at] = candidateX[at - 1] ?? 0;
      candidateY[at] = candidateY[at - 1] ?? 0;
      at--;
    }
    candidateValue[at] = value;
    candidateX[at] = cx;
    candidateY[at] = cy;
  }
  fauna.next[herd] = homing ? today + species.rest[0] : restUntil(species, today, random);
  const avoid = rules.camps * species.flee.distance;
  const humans = state.people.count > 0 && avoid > 0 ? state.fauna.humans : undefined;
  humans?.build(state);
  // Une harde dont le but est déjà dans la zone d'un camp (un camp posé à côté d'elle, une fuite
  // qui l'y a menée) n'y trouverait aucun but à `roam` cases, la zone se comptant par tuiles de
  // 8 × 8 cases : elle resterait là, au camp, des mois. Elle y garde alors le droit de choisir un
  // but à `camps` distances d'alarme au moins de l'humain vivant le plus proche, ou, si le sien en
  // est déjà plus près, pas plus près que lui : elle va et vient sans approcher le camp, et s'en
  // écarte (ADR 0018, § 2).
  const here =
    humans?.any(gx, gy, avoid, false) === true ? humans.nearest(state, gx, gy, avoid) : NO;
  for (let index = 0; index < found; index++) {
    const cx = candidateX[index] ?? 0;
    const cy = candidateY[index] ?? 0;
    // Loin des camps : aucune tuile de 8 × 8 cases où se tient un humain à moins de `camps`
    // distances d'alarme (présence du jour, sans chercher l'humain le plus proche).
    if (humans?.any(cx, cy, avoid, false) === true) {
      if (here === NO || humans.closer(state, cx, cy, here)) continue;
    }
    if (!trace(state.cost, width, height, gx, gy, gx + deltaFixedX(gx, cx, width), cy).clear) {
      continue;
    }
    fauna.counts.roams++;
    fauna.goalX[herd] = wrapFixedX(cx, width);
    fauna.goalY[herd] = cy;
    scatter(state, content, herd, today, FAUNA_GAIT.walk, random);
    return;
  }
}

/**
 * Les alarmes du jour : pour chaque harde, le membre de plus petit emplacement qu'un humain en
 * marche approche à moins de la distance d'alarme de son espèce (`witness`, NO sans alarme), et le
 * marcheur de plus petit emplacement qui l'approche ainsi (`alarmX`, `alarmY`). Le choix ne dépend
 * donc d'aucun ordre de liste. Les animaux, peu nombreux, se rangent par tuiles de 8 × 8 cases ;
 * chaque marcheur regarde ceux des tuiles autour de lui, et non chaque animal tous les marcheurs
 * de la sienne, qui peuvent être des dizaines autour d'un camp.
 */
function alarms(state: SimState, content: FaunaContent): void {
  const fauna = state.fauna;
  const humans = fauna.humans;
  const { tilesX, tilesY } = humans;
  const tiles = tilesX * tilesY;
  if (fauna.gridHead.length !== tiles) fauna.gridHead = new Int32Array(tiles);
  fauna.gridHead.fill(NO);
  if (fauna.gridNext.length < fauna.end) fauna.gridNext = new Int32Array(fauna.alive.length);
  if (fauna.witness.length < fauna.herdEnd) {
    fauna.witness = new Int32Array(fauna.herdAlive.length);
    fauna.alarmX = new Int32Array(fauna.herdAlive.length);
    fauna.alarmY = new Int32Array(fauna.herdAlive.length);
    fauna.alarmBy = new Int32Array(fauna.herdAlive.length);
  }
  fauna.witness.fill(NO);
  const { gridHead, gridNext, witness, alarmX, alarmY, alarmBy } = fauna;
  const distances = alarmDistances(content);
  let reach = 0;
  for (const distance of distances) reach = Math.max(reach, distance);
  if (!(reach > 0)) return;
  for (let slot = fauna.end - 1; slot >= 0; slot--) {
    if (fauna.alive[slot] !== 1) continue;
    const tile = humans.tileAt(fauna.x[slot] ?? 0, fauna.y[slot] ?? 0);
    if (tile < 0) continue;
    gridNext[slot] = gridHead[tile] ?? NO;
    gridHead[tile] = slot;
  }
  const { width } = state.size;
  const { movement } = state;
  const { x, y } = state.people.columns;
  const span = reach * FIXED;
  for (let index = 0; index < movement.activeCount; index++) {
    const human = movement.active[index] ?? 0;
    if (!movement.isActive(human)) continue;
    const hx = x[human] ?? 0;
    const hy = y[human] ?? 0;
    // Les tuiles que touche le carré de côté 2 × reach autour de lui ; x étant dans le monde,
    // elles débordent d'une tuile au plus de part et d'autre de la couture.
    const top = Math.max(0, Math.floor((hy - span) / FIXED) >> HUMAN_TILE_SHIFT);
    const bottom = Math.min(tilesY - 1, Math.floor((hy + span) / FIXED) >> HUMAN_TILE_SHIFT);
    const left = Math.floor((hx - span) / FIXED) >> HUMAN_TILE_SHIFT;
    const right = Math.floor((hx + span) / FIXED) >> HUMAN_TILE_SHIFT;
    const first = left < 0 ? left + tilesX : left;
    for (let row = top; row <= bottom; row++) {
      for (let column = left; column <= right; column++) {
        const wrapped = column < 0 ? column + tilesX : column >= tilesX ? column - tilesX : column;
        // Sur un monde étroit, deux colonnes du carré ne désignent jamais la même tuile.
        if (column !== left && wrapped === first) continue;
        for (
          let slot = gridHead[row * tilesX + wrapped] ?? NO;
          slot >= 0;
          slot = gridNext[slot] ?? NO
        ) {
          const distance = distances[fauna.species[slot] ?? 0] ?? 0;
          const dx = deltaFixedX(fauna.x[slot] ?? 0, hx, width) / FIXED;
          const dy = (hy - (fauna.y[slot] ?? 0)) / FIXED;
          if (!(dx * dx + dy * dy < distance * distance)) continue;
          const herd = fauna.herd[slot] ?? NO;
          if (herd < 0) continue;
          const known = witness[herd] ?? NO;
          if (known >= 0 && (slot > known || (slot === known && human >= (alarmBy[herd] ?? 0)))) {
            continue;
          }
          witness[herd] = slot;
          alarmBy[herd] = human;
          alarmX[herd] = hx;
          alarmY[herd] = hy;
        }
      }
    }
  }
}

const alarmTables = new WeakMap<Catalog<FaunaSpecies>, Float64Array>();

/** Distance d'alarme de chaque espèce, en cases. */
function alarmDistances(content: Pick<FaunaContent, 'fauna'>): Float64Array {
  let table = alarmTables.get(content.fauna);
  if (table === undefined) {
    table = Float64Array.from(content.fauna.entries, (entry) => entry.flee.distance);
    alarmTables.set(content.fauna, table);
  }
  return table;
}

/**
 * La harde fuit l'humain en (tx, ty), qu'a vu le membre `witness` : un but à `flee.length` cases
 * du centre de ses membres, à l'opposé de l'humain, ou selon les virages des règles si la voie,
 * depuis le témoin, est barrée ; chacun y court, le jour même. Faux si toute voie est barrée.
 */
function flee(
  state: SimState,
  content: FaunaContent,
  herd: number,
  witness: number,
  tx: number,
  ty: number,
  today: number,
  random: RandomStream,
): boolean {
  const fauna = state.fauna;
  const species = content.fauna.entries.at(fauna.herdSpecies[herd] ?? 0);
  if (species === undefined) return false;
  const { width, height } = state.size;
  // Le centre des membres, au plus court à travers la couture depuis le premier d'entre eux.
  const first = fauna.head[herd] ?? witness;
  const fx = fauna.x[first] ?? 0;
  let sumX = 0;
  let sumY = 0;
  let members = 0;
  for (let slot = first; slot >= 0; slot = fauna.nextMember[slot] ?? NO) {
    sumX += deltaFixedX(fx, fauna.x[slot] ?? 0, width);
    sumY += fauna.y[slot] ?? 0;
    members++;
  }
  const cx = fx + Math.round(sumX / Math.max(1, members));
  const cy = Math.round(sumY / Math.max(1, members));
  let ux = deltaFixedX(tx, cx, width) / FIXED;
  let uy = (cy - ty) / FIXED;
  let norm = Math.sqrt(ux * ux + uy * uy);
  if (norm < 1e-6) {
    // L'humain sur le centre : à l'opposé de lui depuis le témoin, ou au hasard.
    ux = deltaFixedX(tx, fauna.x[witness] ?? 0, width) / FIXED;
    uy = ((fauna.y[witness] ?? 0) - ty) / FIXED;
    norm = Math.sqrt(ux * ux + uy * uy);
    if (norm < 1e-6) {
      const d = inDisk(random);
      ux = d[0] + 1e-3;
      uy = d[1];
      norm = Math.sqrt(ux * ux + uy * uy);
    }
  }
  ux /= norm;
  uy /= norm;
  const turns = fleeTurns(content.faunaRules);
  const wx = fauna.x[witness] ?? 0;
  const wy = fauna.y[witness] ?? 0;
  // Toute la longueur de la fuite, dans chaque direction ; puis, acculée, la moitié.
  for (const length of [species.flee.length, species.flee.length / 2]) {
    for (let at = 0; at + 1 < turns.length; at += 2) {
      const c = turns[at] ?? 1;
      const s = turns[at + 1] ?? 0;
      const dx = ux * c - uy * s;
      const dy = ux * s + uy * c;
      const gx = cx + Math.round(dx * length * FIXED);
      const gy = cy + Math.round(dy * length * FIXED);
      if (!passableAt(state, gx, gy)) continue;
      if (!trace(state.cost, width, height, wx, wy, wx + deltaFixedX(wx, gx, width), gy).clear) {
        continue;
      }
      fauna.goalX[herd] = wrapFixedX(gx, width);
      fauna.goalY[herd] = gy;
      fauna.calm[herd] = today + species.flee.calm;
      fauna.next[herd] = restUntil(species, today, random);
      fauna.counts.flights++;
      scatter(state, content, herd, today, FAUNA_GAIT.run, random);
      return true;
    }
  }
  fauna.counts.cornered++;
  return false;
}

/**
 * Étape droite de l'animal vers sa place, à son allure (ownPace) divisée par le coût moyen du
 * segment ; le pas entier s'arrondit, et le segment se vérifie entre les bouts exacts de l'étape,
 * comme pour les humains (movement.ts, legTo). Faux si la voie n'est pas libre, ou s'il y est déjà.
 */
function startLeg(state: SimState, content: FaunaContent, slot: number, today: number): boolean {
  const fauna = state.fauna;
  const species = content.fauna.entries.at(fauna.species[slot] ?? 0);
  const { width, height } = state.size;
  const ax = fauna.x[slot] ?? 0;
  const ay = fauna.y[slot] ?? 0;
  const bx = ax + deltaFixedX(ax, fauna.placeX[slot] ?? 0, width);
  const by = fauna.placeY[slot] ?? 0;
  fauna.depart[slot] = NO;
  if (species === undefined || (bx === ax && by === ay)) return false;
  const path = trace(state.cost, width, height, ax, ay, bx, by);
  if (!path.clear) return false;
  const { margin } = path;
  const gait = fauna.gait[slot] ?? FAUNA_GAIT.walk;
  const pace = ownPace(
    gait === FAUNA_GAIT.run ? species.pace.run : species.pace.walk,
    fauna.id[slot] ?? 0,
    content.faunaRules.jitter,
  );
  const dx = (bx - ax) / FIXED;
  const dy = (by - ay) / FIXED;
  const length = Math.sqrt(dx * dx + dy * dy);
  const speed = pace / Math.max(1, path.cost);
  let days = Math.min(MAX_LEG_DAYS, Math.max(1, Math.ceil(length / speed - 1e-9)));
  // Jamais plus de MAX_STEP par jour sur un axe.
  days = Math.max(days, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay)) / MAX_STEP));
  const sx = Math.round((bx - ax) / days);
  const sy = Math.round((by - ay) / days);
  const ex = ax + days * sx;
  const ey = ay + days * sy;
  if (ey < 0 || ey >= height * FIXED) return false;
  if (ex !== bx || ey !== by) {
    // Le bout exact s'écarte à peine de la place : dans la même case, et sans frôler un coin de
    // plus près, l'étape traverse les mêmes cases.
    const shift = (Math.abs(ex - bx) + Math.abs(ey - by)) / FIXED;
    const same =
      Math.floor(ex / FIXED) === Math.floor(bx / FIXED) &&
      Math.floor(ey / FIXED) === Math.floor(by / FIXED) &&
      margin > shift;
    if (!same && !trace(state.cost, width, height, ax, ay, ex, ey).clear) return false;
  }
  fauna.stepX[slot] = sx;
  fauna.stepY[slot] = sy;
  fauna.stepDays[slot] = days;
  fauna.counts.legs++;
  fauna.journal?.push(slot, today, ax, ay, sx, sy, days, gait);
  return true;
}

/**
 * Un jour du gibier, après le mouvement des humains : les hardes s'alarment ou choisissent leur
 * but, dans l'ordre de leurs emplacements ; puis chaque animal part, avance ou arrive, dans l'ordre
 * des siens. Le worker ne connaît pas la caméra : tous les animaux bougent, qu'on les voie ou non.
 */
export function faunaDay(state: SimState, content: FaunaContent): void {
  const fauna = state.fauna;
  if (fauna.count === 0) return;
  const today = dayIndex(state);
  const random = state.rng.stream(FAUNA_STREAM);
  const people = state.people.count > 0;
  if (people) {
    fauna.humans.build(state);
    alarms(state, content);
  }
  for (let herd = 0; herd < fauna.herdEnd; herd++) {
    if (fauna.herdAlive[herd] !== 1 || (fauna.size[herd] ?? 0) === 0) continue;
    if (people && today >= (fauna.calm[herd] ?? 0)) {
      const witness = fauna.witness[herd] ?? NO;
      if (
        witness >= 0 &&
        flee(
          state,
          content,
          herd,
          witness,
          fauna.alarmX[herd] ?? 0,
          fauna.alarmY[herd] ?? 0,
          today,
          random,
        )
      ) {
        continue;
      }
    }
    if (today >= (fauna.next[herd] ?? 0)) roam(state, content, herd, today, random);
  }
  const span = state.size.width * FIXED;
  for (let slot = 0; slot < fauna.end; slot++) {
    if (fauna.alive[slot] !== 1) continue;
    if ((fauna.stepDays[slot] ?? 0) === 0) {
      const depart = fauna.depart[slot] ?? NO;
      if (depart === NO || depart > today) continue;
      if (!startLeg(state, content, slot, today)) {
        // Voie barrée, ou déjà à sa place : il se repose là où il est.
        fauna.counts.stuck++;
        fauna.placeX[slot] = fauna.x[slot] ?? 0;
        fauna.placeY[slot] = fauna.y[slot] ?? 0;
        fauna.gait[slot] = FAUNA_GAIT.rest;
        continue;
      }
    }
    let nx = (fauna.x[slot] ?? 0) + (fauna.stepX[slot] ?? 0);
    if (nx < 0) nx += span;
    else if (nx >= span) nx -= span;
    fauna.x[slot] = nx;
    fauna.y[slot] = (fauna.y[slot] ?? 0) + (fauna.stepY[slot] ?? 0);
    const left = (fauna.stepDays[slot] ?? 1) - 1;
    fauna.stepDays[slot] = left;
    if (left === 0) {
      // Arrivé : sa place est là où son étape l'a mené, à quelques unités de celle qu'il visait.
      fauna.placeX[slot] = nx;
      fauna.placeY[slot] = fauna.y[slot] ?? 0;
      fauna.stepX[slot] = 0;
      fauna.stepY[slot] = 0;
      fauna.gait[slot] = FAUNA_GAIT.rest;
    }
  }
}

// --- Apparition, naissances et morts.

/** Arrondi au hasard : n + 1 avec la chance de la partie fractionnaire. */
function stochastic(value: number, random: RandomStream): number {
  if (!(value > 0)) return 0;
  const whole = Math.floor(value);
  return whole + (random.nextFloat() < value - whole ? 1 : 0);
}

/** Une case d'habitat du territoire `tile`, la meilleure de quelques tirages, ou −1. */
function habitatCell(
  state: SimState,
  content: FaunaContent,
  s: number,
  tile: number,
  random: RandomStream,
): number {
  const rules = content.faunaRules;
  const side = rules.territory;
  const { columns } = territoriesOf(state, rules);
  const { width, height } = state.size;
  const tx = (tile % columns) * side;
  const ty = Math.floor(tile / columns) * side;
  const factor = seasonAt(monthOfDay(state));
  let best = -1;
  let value = 0;
  for (let attempt = 0; attempt < rules.draws.cell; attempt++) {
    const column = tx + Math.floor(random.nextFloat() * side);
    const row = ty + Math.floor(random.nextFloat() * side);
    if (column >= width || row >= height) continue;
    const cell = row * width + column;
    if (!Number.isFinite(state.cost[cell] ?? Number.POSITIVE_INFINITY)) continue;
    const note = score(state, content, s, cell, factor);
    if (note > value) {
      value = note;
      best = cell;
    }
  }
  return best;
}

/**
 * Une harde nouvelle de `count` animaux de l'espèce `s`, autour d'un point de la case `cell`, qui
 * est le centre de son domaine : à la création du monde, ou à la relecture d'une partie qui n'avait
 * pas de gibier. Âges étalés sur la vie, sexes selon `males`. Renvoie l'emplacement de la harde, ou
 * NO si aucun animal n'a pu s'y poser.
 */
export function spawnHerd(
  state: SimState,
  content: FaunaContent,
  s: number,
  cell: number,
  count: number,
  random: RandomStream,
): number {
  const fauna = state.fauna;
  const species = content.fauna.entries.at(s);
  if (species === undefined) return NO;
  const { width, height } = state.size;
  const column = cell % width;
  const row = Math.floor(cell / width);
  const gx = column * FIXED + Math.floor(random.nextFloat() * FIXED);
  const gy = row * FIXED + Math.floor(random.nextFloat() * FIXED);
  const today = dayIndex(state);
  const herd = fauna.addHerd(
    s,
    column,
    row,
    gx,
    gy,
    today + Math.floor(random.nextFloat() * (species.rest[1] + 1)),
  );
  const lifespan = species.lifespan * MONTHS_PER_YEAR;
  const limit = faunaLimit(state);
  for (let index = 0; index < count && fauna.count < limit; index++) {
    let x = gx;
    let y = gy;
    for (let attempt = 0; attempt < content.faunaRules.draws.place; attempt++) {
      const d = inDisk(random);
      const cx = gx + Math.round(d[0] * species.spread * FIXED);
      const cy = gy + Math.round(d[1] * species.spread * FIXED);
      if (passableAt(state, cx, cy) && trace(state.cost, width, height, gx, gy, cx, cy).clear) {
        x = cx;
        y = cy;
        break;
      }
    }
    const age = Math.floor(random.nextFloat() * lifespan * 0.8);
    const sex = random.nextFloat() < species.males ? 1 : 0;
    fauna.add(s, herd, state.tick - age, sex, wrapFixedX(x, width), y);
  }
  if ((fauna.size[herd] ?? 0) === 0) {
    fauna.removeHerd(herd);
    return NO;
  }
  return herd;
}

/**
 * Sème le gibier d'un monde d'après ses cibles (habitat, stocks entamés, plafond) : à la création,
 * ou à la relecture d'une sauvegarde qui n'en avait pas. Pour chaque territoire et chaque espèce,
 * la cible se ramène à l'entier, son reste reporté sur le territoire suivant, se découpe en hardes
 * de `herd` membres, et chaque harde se pose sur la meilleure de quelques cases tirées dans le
 * territoire.
 */
export function seedFauna(state: SimState, content: FaunaContent): void {
  const fauna = state.fauna;
  const random = state.rng.stream(FAUNA_STREAM);
  const species = content.fauna.entries;
  if (species.length === 0) return;
  const target = faunaTargets(state, content);
  const tiles = target.length / species.length;
  const limit = faunaLimit(state);
  // Chaque cible se ramène à l'entier en reportant son reste sur le territoire suivant, espèce
  // par espèce : la somme des effectifs semés reste celle des cibles, à un animal près, si bien
  // qu'un monde au plafond se peuple d'un bord à l'autre, sans s'arrêter au plafond avant la fin.
  const carry = new Float64Array(species.length);
  for (let tile = 0; tile < tiles; tile++) {
    for (let s = 0; s < species.length; s++) {
      const entry = species.at(s);
      if (entry === undefined) continue;
      const wanted = Math.max(0, target[tile * species.length + s] ?? 0) + (carry[s] ?? 0);
      let left = Math.floor(wanted);
      carry[s] = wanted - left;
      while (left > 0 && fauna.count < limit) {
        const [low, high] = entry.herd;
        let size = Math.min(left, low + Math.floor(random.nextFloat() * (high - low + 1)));
        // Un reste trop petit pour une harde la rejoint.
        if (left - size > 0 && left - size < low) size = Math.min(MAX_HERD, high, left);
        const cell = habitatCell(state, content, s, tile, random);
        if (cell < 0) break;
        spawnHerd(state, content, s, cell, size, random);
        left -= size;
      }
    }
  }
}

/** Hardes d'un territoire et d'une espèce, au mois : repris d'un appel à l'autre. */
const keyed: number[] = [];

/** Les hardes de la clé (territoire × espèces + espèce) `key`, dans `keyed`. */
function herdsOf(fauna: Fauna, key: number): number[] {
  keyed.length = 0;
  for (let herd = fauna.keyHead[key] ?? NO; herd >= 0; herd = fauna.keyNext[herd] ?? NO) {
    keyed.push(herd);
  }
  return keyed;
}

/**
 * Le mois du gibier, à la fin du pas mensuel, une fois la chasse du mois faite : les vieux
 * meurent ; puis, territoire par territoire et espèce par espèce, une part de l'excès sur la cible
 * meurt, et le manque se comble aux mois de mise bas ; un territoire vide peut être recolonisé.
 */
export function faunaMonth(state: SimState, content: FaunaContent): void {
  const fauna = state.fauna;
  const species = content.fauna.entries;
  const S = species.length;
  if (S === 0 || fauna.count === 0) return;
  const random = state.rng.stream(FAUNA_STREAM);
  const rules = content.faunaRules;
  // Les vieux meurent, dans l'ordre des emplacements.
  for (let slot = 0; slot < fauna.end; slot++) {
    if (fauna.alive[slot] !== 1) continue;
    const entry = species.at(fauna.species[slot] ?? 0);
    if (entry === undefined) continue;
    if (state.tick - (fauna.born[slot] ?? 0) >= entry.lifespan * MONTHS_PER_YEAR) {
      fauna.remove(slot);
      fauna.counts.aged++;
    }
  }
  const target = faunaTargets(state, content);
  const { columns, rows } = territoriesOf(state, rules);
  const tiles = columns * rows;
  // Les hardes de chaque territoire et de chaque espèce, par emplacements croissants, et leurs
  // effectifs ; les hardes vides s'en vont.
  if (fauna.keyHead.length < tiles * S) fauna.keyHead = new Int32Array(tiles * S);
  fauna.keyHead.fill(NO);
  fauna.ensureHerds(fauna.herdEnd);
  const counts = new Float64Array(tiles * S);
  for (let herd = fauna.herdEnd - 1; herd >= 0; herd--) {
    if (fauna.herdAlive[herd] !== 1) continue;
    if ((fauna.size[herd] ?? 0) === 0) {
      fauna.removeHerd(herd);
      continue;
    }
    const tile = territoryOf(state, rules, fauna.homeX[herd] ?? 0, fauna.homeY[herd] ?? 0);
    const key = tile * S + (fauna.herdSpecies[herd] ?? 0);
    fauna.keyNext[herd] = fauna.keyHead[key] ?? NO;
    fauna.keyHead[key] = herd;
    counts[key] = (counts[key] ?? 0) + (fauna.size[herd] ?? 0);
  }
  // Le mois qui s'achève, de 0 (janvier) à 11.
  const month = ((state.tick % MONTHS_PER_YEAR) + MONTHS_PER_YEAR) % MONTHS_PER_YEAR;
  const limit = faunaLimit(state);
  const today = dayIndex(state);
  const members: number[] = [];
  for (let tile = 0; tile < tiles; tile++) {
    const south = (Math.floor(tile / columns) + 0.5) * rules.territory >= state.size.height / 2;
    for (let s = 0; s < S; s++) {
      const entry = species.at(s);
      if (entry === undefined) continue;
      const key = tile * S + s;
      const count = counts[key] ?? 0;
      const goal = Math.max(0, target[key] ?? 0);
      if (count > goal + 0.5) {
        // L'excès meurt en partie : des animaux au hasard parmi ceux du territoire.
        const herds = herdsOf(fauna, key);
        let deaths = stochastic((count - goal) * entry.cull, random);
        while (deaths-- > 0 && herds.length > 0) {
          const pick = Math.floor(random.nextFloat() * herds.length);
          const herd = herds[pick] ?? 0;
          fauna.members(herd, members);
          const victim = members.at(Math.floor(random.nextFloat() * members.length));
          if (victim === undefined) continue;
          fauna.remove(victim);
          fauna.counts.deaths++;
          // Une harde vidée ne se tire plus.
          if ((fauna.size[herd] ?? 0) === 0) herds.splice(pick, 1);
        }
        continue;
      }
      const birthMonth = entry.birth.months.includes(south ? (month + 6) % 12 : month);
      if (!birthMonth || fauna.count >= limit) continue;
      if (count === 0) {
        if (goal >= entry.herd[0] && random.nextFloat() < entry.colonize) {
          colonize(state, content, s, tile, counts, today, random);
        }
        continue;
      }
      if (count >= goal - 0.5) continue;
      const herds = herdsOf(fauna, key);
      let births = stochastic(Math.min(goal - count, entry.birth.growth * count), random);
      while (births-- > 0 && fauna.count < limit && herds.length > 0) {
        if (entry.herd[1] === 1) {
          // Une espèce solitaire : le jeune naît près d'une mère au hasard, et vit seul.
          const from = herds[Math.floor(random.nextFloat() * herds.length)] ?? 0;
          const mother = fauna.head[from] ?? NO;
          if (mother < 0) continue;
          const mx = fauna.x[mother] ?? 0;
          const my = fauna.y[mother] ?? 0;
          const herd = fauna.addHerd(
            s,
            fauna.homeX[from] ?? 0,
            fauna.homeY[from] ?? 0,
            mx,
            my,
            today + 1 + Math.floor(random.nextFloat() * entry.rest[1]),
          );
          fauna.add(s, herd, state.tick, random.nextFloat() < entry.males ? 1 : 0, mx, my);
          fauna.counts.births++;
          continue;
        }
        // Une mère au hasard, dans une harde qui a de la place ; le jeune naît à sa place.
        const room = Math.min(MAX_HERD, entry.herd[1]);
        let open = 0;
        for (const herd of herds) if ((fauna.size[herd] ?? 0) < room) open++;
        let herd = NO;
        if (open > 0) {
          let pick = Math.floor(random.nextFloat() * open);
          for (const candidate of herds) {
            if ((fauna.size[candidate] ?? 0) >= room) continue;
            if (pick-- === 0) {
              herd = candidate;
              break;
            }
          }
        } else {
          // Plus de place : la moitié d'une harde au hasard s'en détache, sur le même domaine.
          const from = herds[Math.floor(random.nextFloat() * herds.length)] ?? 0;
          herd = fauna.addHerd(
            s,
            fauna.homeX[from] ?? 0,
            fauna.homeY[from] ?? 0,
            fauna.goalX[from] ?? 0,
            fauna.goalY[from] ?? 0,
            today,
          );
          fauna.members(from, members);
          for (let index = 0; index < members.length; index += 2) {
            fauna.moveTo(members[index] ?? 0, herd);
          }
          herds.push(herd);
        }
        fauna.members(herd, members);
        const mother = members.at(Math.floor(random.nextFloat() * members.length));
        if (mother === undefined) continue;
        fauna.add(
          s,
          herd,
          state.tick,
          random.nextFloat() < entry.males ? 1 : 0,
          fauna.x[mother] ?? 0,
          fauna.y[mother] ?? 0,
        );
        fauna.counts.births++;
      }
    }
  }
  for (let herd = 0; herd < fauna.herdEnd; herd++) {
    if (fauna.herdAlive[herd] === 1 && (fauna.size[herd] ?? 0) === 0) fauna.removeHerd(herd);
  }
}

/**
 * Recolonisation du territoire vide `tile` par l'espèce `s` : une harde d'un territoire voisin, à
 * `rules.neighbors` territoires au plus, couture comprise, qui compte au moins deux hardes
 * minimales, en détache la moitié, dont le domaine passe dans le territoire vide, sur la meilleure
 * de quelques cases ; elle y marche de but en but (roam), sans apparaître d'un coup. Pour une
 * espèce solitaire, c'est un animal d'un territoire qui en a plusieurs. Rien sans voisin peuplé.
 */
function colonize(
  state: SimState,
  content: FaunaContent,
  s: number,
  tile: number,
  counts: Float64Array,
  today: number,
  random: RandomStream,
): void {
  const fauna = state.fauna;
  const entry = content.fauna.entries.at(s);
  if (entry === undefined) return;
  const rules = content.faunaRules;
  const S = content.fauna.entries.length;
  const { columns, rows } = territoriesOf(state, rules);
  const column = tile % columns;
  const row = Math.floor(tile / columns);
  const solitary = entry.herd[1] === 1;
  const enough = solitary ? 2 : 2 * entry.herd[0];
  // Les hardes qui peuvent partir, dans l'ordre des territoires voisins, puis des emplacements.
  const donors: number[] = [];
  const reach = rules.neighbors;
  for (let dy = -reach; dy <= reach; dy++) {
    const r = row + dy;
    if (r < 0 || r >= rows) continue;
    for (let dx = -reach; dx <= reach; dx++) {
      if (dx === 0 && dy === 0) continue;
      const c = (((column + dx) % columns) + columns) % columns;
      const key = (r * columns + c) * S + s;
      if ((counts[key] ?? 0) < enough) continue;
      for (const herd of herdsOf(fauna, key)) {
        if (solitary || (fauna.size[herd] ?? 0) >= enough) donors.push(herd);
      }
    }
  }
  if (donors.length === 0) return;
  const cell = habitatCell(state, content, s, tile, random);
  if (cell < 0) return;
  const from = donors[Math.floor(random.nextFloat() * donors.length)] ?? 0;
  const { width } = state.size;
  const homeX = cell % width;
  const homeY = Math.floor(cell / width);
  if (solitary) {
    fauna.homeX[from] = homeX;
    fauna.homeY[from] = homeY;
    fauna.next[from] = today;
  } else {
    const herd = fauna.addHerd(
      s,
      homeX,
      homeY,
      fauna.goalX[from] ?? 0,
      fauna.goalY[from] ?? 0,
      today,
    );
    const members = fauna.members(from, []);
    for (let index = 0; index < members.length; index += 2) {
      fauna.moveTo(members[index] ?? 0, herd);
    }
  }
  fauna.counts.colonized++;
}

// --- Empreinte.

/** L'état du gibier dans l'empreinte : colonnes des vivants, hardes, piles libres et compteurs. */
export function fingerprintFauna(fingerprint: Fingerprint, fauna: Fauna): void {
  fingerprint.uint32(fauna.end).uint32(fauna.nextId).uint32(fauna.herdEnd).uint32(fauna.nextHerdId);
  for (let slot = 0; slot < fauna.end; slot++) {
    if (fauna.alive[slot] !== 1) {
      fingerprint.uint32(0);
      continue;
    }
    fingerprint
      .uint32(fauna.id[slot] ?? 0)
      .uint32(fauna.species[slot] ?? 0)
      .uint32((fauna.herd[slot] ?? 0) >>> 0)
      .uint32((fauna.born[slot] ?? 0) >>> 0)
      .uint32(fauna.sex[slot] ?? 0)
      .uint32((fauna.x[slot] ?? 0) >>> 0)
      .uint32((fauna.y[slot] ?? 0) >>> 0)
      .uint32((fauna.placeX[slot] ?? 0) >>> 0)
      .uint32((fauna.placeY[slot] ?? 0) >>> 0)
      .uint32((fauna.stepX[slot] ?? 0) >>> 0)
      .uint32((fauna.stepY[slot] ?? 0) >>> 0)
      .uint32(fauna.stepDays[slot] ?? 0)
      .uint32((fauna.depart[slot] ?? 0) >>> 0)
      .uint32(fauna.gait[slot] ?? 0)
      .uint32(fauna.hunter[slot] ?? 0);
  }
  fingerprint.uint32(fauna.free.length);
  for (const slot of fauna.free) fingerprint.uint32(slot);
  for (let herd = 0; herd < fauna.herdEnd; herd++) {
    if (fauna.herdAlive[herd] !== 1) {
      fingerprint.uint32(0);
      continue;
    }
    fingerprint
      .uint32(fauna.herdId[herd] ?? 0)
      .uint32(fauna.herdSpecies[herd] ?? 0)
      .uint32((fauna.homeX[herd] ?? 0) >>> 0)
      .uint32((fauna.homeY[herd] ?? 0) >>> 0)
      .uint32((fauna.goalX[herd] ?? 0) >>> 0)
      .uint32((fauna.goalY[herd] ?? 0) >>> 0)
      .uint32((fauna.next[herd] ?? 0) >>> 0)
      .uint32((fauna.calm[herd] ?? 0) >>> 0);
  }
  fingerprint.uint32(fauna.herdFree.length);
  for (const herd of fauna.herdFree) fingerprint.uint32(herd);
}

// --- Image du gibier pour le rendu (protocole 7).

/**
 * L'image du gibier : chaque vivant, par emplacements croissants, sa sorte (espèce, jeune, mâle
 * adulte, au galop), sa harde, sa position, et l'étape en cours de qui marche, repartie de
 * l'instant de l'image ; son allure est celle de l'animal (FAUNA_RUN).
 */
export function faunaFrame(
  state: SimState,
  content: Pick<FaunaContent, 'fauna'>,
  arrays: Allocator = freshArrays,
): FaunaFrame {
  const fauna = state.fauna;
  const n = fauna.count;
  const slots = arrays.uint32(n);
  const ids = arrays.uint32(n);
  const kinds = arrays.uint8(n);
  const herds = arrays.uint32(n);
  const positions = arrays.int32(2 * n);
  let walking = 0;
  for (let slot = 0; slot < fauna.end; slot++) {
    if (fauna.alive[slot] === 1 && (fauna.stepDays[slot] ?? 0) > 0) walking++;
  }
  const legs = {
    slots: arrays.uint32(walking),
    days: arrays.uint32(walking),
    start: arrays.int32(2 * walking),
    step: arrays.int32(2 * walking),
    count: arrays.uint16(walking),
  };
  const today = dayIndex(state);
  let index = 0;
  let leg = 0;
  for (let slot = 0; slot < fauna.end; slot++) {
    if (fauna.alive[slot] !== 1) continue;
    const s = fauna.species[slot] ?? 0;
    const species = content.fauna.entries.at(s);
    const months = state.tick - (fauna.born[slot] ?? 0);
    const young = species !== undefined && months < species.birth.young;
    const male =
      species?.look.male !== undefined &&
      (fauna.sex[slot] ?? 0) === 1 &&
      months >= (species.look.maleFrom ?? 0) * MONTHS_PER_YEAR;
    const left = fauna.stepDays[slot] ?? 0;
    const running = left > 0 && fauna.gait[slot] === FAUNA_GAIT.run;
    slots[index] = slot;
    ids[index] = fauna.id[slot] ?? 0;
    kinds[index] =
      s | (young ? FAUNA_YOUNG : 0) | (male ? FAUNA_MALE : 0) | (running ? FAUNA_RUN : 0);
    const herd = fauna.herd[slot] ?? NO;
    herds[index] = herd >= 0 ? (fauna.herdId[herd] ?? 0) : 0;
    positions[2 * index] = fauna.x[slot] ?? 0;
    positions[2 * index + 1] = fauna.y[slot] ?? 0;
    if (left > 0) {
      legs.slots[leg] = slot;
      legs.days[leg] = today;
      legs.start[2 * leg] = fauna.x[slot] ?? 0;
      legs.start[2 * leg + 1] = fauna.y[slot] ?? 0;
      legs.step[2 * leg] = fauna.stepX[slot] ?? 0;
      legs.step[2 * leg + 1] = fauna.stepY[slot] ?? 0;
      legs.count[leg] = left;
      leg++;
    }
    index++;
  }
  return { slots, ids, kinds, herds, positions, legs };
}
