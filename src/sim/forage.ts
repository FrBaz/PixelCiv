/**
 * Survie (tâche 2.4 ; ECO-11, RES-03, RES-04, FAU-01, SAI-03 ; ADR 0011).
 *
 * Chaque case porte trois stocks de nourriture, comptés en besoins mensuels d'un adulte :
 * plantes à cueillir, gibier, poisson. Leur plafond suit le rendement du biome
 * (data/biomes.json) et la saison : les plantes ne se trouvent qu'à la belle saison, moins
 * à la saison sèche des tropiques ; la glace gêne la pêche. Une rivière ajoute la pêche de
 * sa classe à la case qu'elle traverse ; la mer côtière, les lacs et les fleuves se
 * pêchent depuis la rive. Le gibier chassé, c'est la faune, qui s'épuise et se
 * reconstitue (FAU-01) ; plus rare dans le grand froid, il repousse moins vite.
 *
 * Une case que personne n'a entamée tient ses stocks au plafond de la saison : rien à y
 * calculer. Seules les cases entamées sont suivies, marquées une à une : elles repoussent
 * chaque mois, dans l'ordre des cases, au rythme de leur rendement, jusqu'à retrouver
 * leur plafond. Chaque case repousse pour elle seule : l'ordre ne change rien aux stocks,
 * et le parcours dans l'ordre des cases lit la mémoire d'un trait.
 *
 * Chaque groupe cueille, chasse et pêche autour de lui, dans un rayon de quelques cases,
 * une part des stocks : de quoi nourrir ses membres, et remplir sa réserve pour l'hiver.
 * La nutrition de ses membres suit ce qu'il a trouvé ; la faim tue et rend moins fécond
 * (cycle de vie).
 */
import type { Biome, Catalog, Nomads, Species } from '../core/data';
import { wrapNearX } from '../core/cylinder';
import { rainSeasonality, seasonFactor } from '../core/seasons';
import { riverClass, type WorldLayers, type WorldSize } from '../core/world';
import { dominantSubspecies, monthOf, MONTHS_PER_YEAR } from './people';
import type { Population } from './population';
import type { Group } from './society';

/** Stocks de nourriture : ceux des cases entamées, les autres étant au plafond. */
export interface FoodStocks {
  /**
   * Stocks des cases entamées, trois par case, côte à côte (FOOD_STRIDE) : plantes,
   * gibier, poisson ; sans valeur ailleurs.
   */
  readonly stocks: Float32Array<ArrayBuffer>;
  /** 1 pour une case entamée. */
  readonly depleted: Uint8Array<ArrayBuffer>;
  /** Nombre de cases entamées. */
  count: number;
}

export interface ForageContent {
  readonly biomes: Catalog<Biome>;
  readonly species: Catalog<Species>;
  readonly nomads: Nomads;
}

/** Valeurs par case dans FoodStocks.stocks : plantes, gibier, poisson. */
export const FOOD_STRIDE = 3;

/** Stocks d'un monde de `count` cases, toutes au plafond. */
export function emptyStocks(count: number): FoodStocks {
  return {
    stocks: new Float32Array(count * FOOD_STRIDE),
    depleted: new Uint8Array(count),
    count: 0,
  };
}

/** Cases entamées, dans l'ordre des cases. */
export function depletedCells(food: FoodStocks): number[] {
  const cells: number[] = [];
  const { depleted } = food;
  for (let cell = 0; cell < depleted.length; cell++) if (depleted[cell] === 1) cells.push(cell);
  return cells;
}

/** Marque une case entamée. */
export function deplete(food: FoodStocks, cell: number): void {
  if (food.depleted[cell] === 1) return;
  food.depleted[cell] = 1;
  food.count++;
}

/** Rendements par biome, en tableaux. */
interface BiomeTable {
  readonly plants: Float32Array;
  readonly game: Float32Array;
  readonly fish: Float32Array;
  /** Le biome est-il une eau douce, qui gèle ? */
  readonly freshwater: Uint8Array;
  /** Pêche du biome « rivière », que chaque classe de rivière reprend en partie. */
  readonly river: number;
}

const tables = new WeakMap<Catalog<Biome>, BiomeTable>();

function biomeTable(biomes: Catalog<Biome>): BiomeTable {
  let table = tables.get(biomes);
  if (table !== undefined) return table;
  table = {
    plants: Float32Array.from(biomes.entries, (biome) => biome.forage.plants),
    game: Float32Array.from(biomes.entries, (biome) => biome.forage.game),
    fish: Float32Array.from(biomes.entries, (biome) => biome.forage.fish),
    freshwater: Uint8Array.from(biomes.entries, (biome) =>
      biome.id === 'lake' || biome.id === 'river' ? 1 : 0,
    ),
    river: biomes.entries.find((biome) => biome.id === 'river')?.forage.fish ?? 0,
  };
  tables.set(biomes, table);
  return table;
}

/** Part du rendement des plantes au sommet, selon la température du mois et la pluie. */
export function plantSeason(temperature: number, rain: number): number {
  const warmth = Math.min(1, Math.max(0, (temperature - 2) / 13));
  return warmth * Math.min(1, Math.max(0.3, rain));
}

/** Part du rendement du gibier : il repousse moins vite dans le grand froid. */
export function gameSeason(temperature: number): number {
  return temperature < -5 ? 0.6 : 1;
}

/** Part du rendement de la pêche : la glace la gêne sur l'eau douce. */
export function fishSeason(temperature: number, freshwater: boolean): number {
  return freshwater && temperature < -1 ? 0.3 : 1;
}

/**
 * Rendements et plafonds d'une case au mois du pas `tick`, dans un tampon réutilisé :
 * repousse des plantes, du gibier et du poisson (0 à 2), puis leurs plafonds (3 à 5).
 */
export const CELL_FOOD = { growth: 0, caps: 3 } as const;

/**
 * Climat du mois, ligne par ligne : facteur de saison (signé selon l'hémisphère) et pluie
 * du mois rapportée à la moyenne (saison sèche des tropiques, D8). Il ne dépend que du pas
 * et de la hauteur du monde : on le garde d'un appel à l'autre.
 */
interface MonthClimate {
  readonly tick: number;
  readonly height: number;
  readonly season: Float64Array;
  readonly rain: Float64Array;
}

let cachedClimate: MonthClimate | undefined;

function monthClimate(height: number, tick: number): MonthClimate {
  if (cachedClimate?.tick === tick && cachedClimate.height === height) return cachedClimate;
  const factor = seasonFactor(monthOf(tick));
  const season = new Float64Array(height);
  const rain = new Float64Array(height);
  for (let y = 0; y < height; y++) {
    season[y] = y >= height / 2 ? -factor : factor;
    const lat = Math.abs((2 * (y + 0.5)) / height - 1);
    rain[y] = 1 + rainSeasonality(lat) * (season[y] ?? 0);
  }
  cachedClimate = { tick, height, season, rain };
  return cachedClimate;
}

const scratch = new Float64Array(6);

/**
 * Ce que rend une case, et jusqu'où, ce mois-ci (voir CELL_FOOD). Le tampon rendu sert à
 * tous les appels : on le lit avant le suivant.
 */
export function cellFood(
  world: WorldLayers,
  size: WorldSize,
  cell: number,
  tick: number,
  content: ForageContent,
): Float64Array {
  const table = biomeTable(content.biomes);
  const climate = monthClimate(size.height, tick);
  return cellFoodWith(table, climate, content.nomads, world, size.width, cell);
}

/** cellFood, la table des biomes et le climat du mois déjà en main. */
function cellFoodWith(
  table: BiomeTable,
  climate: MonthClimate,
  nomads: Nomads,
  world: WorldLayers,
  width: number,
  cell: number,
): Float64Array {
  const { stocks, river } = nomads;
  const y = Math.floor(cell / width);
  const season = climate.season[y] ?? 0;
  const temperature = ((world.temperature[cell] ?? 0) + (world.amplitude[cell] ?? 0) * season) / 10;
  const biome = world.biome[cell] ?? 0;
  const plants = (table.plants[biome] ?? 0) * plantSeason(temperature, climate.rain[y] ?? 1);
  const game = table.game[biome] ?? 0;
  const fish =
    (table.fish[biome] ?? 0) + (river[riverClass(world.drainage[cell] ?? 0)] ?? 0) * table.river;
  const frozen = fishSeason(temperature, table.freshwater[biome] === 1);
  scratch[0] = plants;
  scratch[1] = game * gameSeason(temperature);
  scratch[2] = fish * frozen;
  scratch[3] = plants * stocks.plants.capacity;
  scratch[4] = game * stocks.game.capacity;
  scratch[5] = fish * stocks.fish.capacity * frozen;
  return scratch;
}

/** Somme des trois stocks d'une case ce mois-ci : ceux qu'on suit, ou ses plafonds. */
export function totalStock(
  food: FoodStocks,
  world: WorldLayers,
  size: WorldSize,
  cell: number,
  tick: number,
  content: ForageContent,
): number {
  if (food.depleted[cell] === 1) {
    const at = cell * FOOD_STRIDE;
    return (food.stocks[at] ?? 0) + (food.stocks[at + 1] ?? 0) + (food.stocks[at + 2] ?? 0);
  }
  const values = cellFood(world, size, cell, tick, content);
  return values[3] + values[4] + values[5];
}

/** Écrit dans `out`, à partir de `at`, les trois stocks d'une case ce mois-ci. */
export function stocksInto(
  food: FoodStocks,
  world: WorldLayers,
  size: WorldSize,
  cell: number,
  tick: number,
  content: ForageContent,
  out: Float64Array,
  at: number,
): void {
  if (food.depleted[cell] === 1) {
    const from = cell * FOOD_STRIDE;
    out[at] = food.stocks[from] ?? 0;
    out[at + 1] = food.stocks[from + 1] ?? 0;
    out[at + 2] = food.stocks[from + 2] ?? 0;
    return;
  }
  const values = cellFood(world, size, cell, tick, content);
  out[at] = values[3];
  out[at + 1] = values[4];
  out[at + 2] = values[5];
}

/** Un stock qui atteint 99,9 % de son plafond l'a retrouvé (les flottants arrondissent). */
const FULL = 0.999;

/** Fait repousser les cases entamées ; une case revenue au plafond n'est plus suivie. */
export function regrowFood(
  food: FoodStocks,
  world: WorldLayers,
  size: WorldSize,
  tick: number,
  content: ForageContent,
): void {
  if (food.count === 0) return;
  const table = biomeTable(content.biomes);
  const climate = monthClimate(size.height, tick);
  const { depleted, stocks } = food;
  // Quatre cases à la fois : la plupart sont au plafond, et on les saute d'un coup.
  const words = new Uint32Array(depleted.buffer, 0, depleted.length >> 2);
  const regrow = (cell: number) => {
    const values = cellFoodWith(table, climate, content.nomads, world, size.width, cell);
    const plantsCap = values[3];
    const gameCap = values[4];
    const fishCap = values[5];
    const at = cell * FOOD_STRIDE;
    const plants = Math.min(plantsCap, (stocks[at] ?? 0) + values[0]);
    const game = Math.min(gameCap, (stocks[at + 1] ?? 0) + values[1]);
    const fish = Math.min(fishCap, (stocks[at + 2] ?? 0) + values[2]);
    stocks[at] = plants;
    stocks[at + 1] = game;
    stocks[at + 2] = fish;
    if (plants >= plantsCap * FULL && game >= gameCap * FULL && fish >= fishCap * FULL) {
      // Revenue au plafond.
      depleted[cell] = 0;
      food.count--;
    }
  };
  for (let word = 0; word < words.length; word++) {
    if (words[word] === 0) continue;
    for (let cell = word * 4; cell < word * 4 + 4; cell++) if (depleted[cell] === 1) regrow(cell);
  }
  for (let cell = words.length * 4; cell < depleted.length; cell++) {
    if (depleted[cell] === 1) regrow(cell);
  }
}

/** Cases d'un disque de rayon `radius` autour de (x, y) ; x boucle, y reste dans le monde. */
export function disk(size: WorldSize, x: number, y: number, radius: number): number[] {
  const cells: number[] = [];
  const { width, height } = size;
  for (let dy = -radius; dy <= radius; dy++) {
    const row = y + dy;
    if (row < 0 || row >= height) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > radius * radius) continue;
      cells.push(row * width + ((((x + dx) % width) + width) % width));
    }
  }
  return cells;
}

/** Bonus de rendement d'un biome de prédilection de la sous-espèce (ESP-02). */
const PREFERRED = 1.25;

/** Besoin mensuel de nourriture d'un groupe, en besoins d'un adulte. */
export function groupNeed(
  people: Population,
  members: readonly number[],
  tick: number,
  content: ForageContent,
): number {
  let need = 0;
  const { birth, species: kinds } = people.columns;
  const entries = content.species.entries;
  for (const slot of members) {
    const species = entries.at(kinds[slot] ?? 0);
    const years = (tick - (birth[slot] ?? 0)) / MONTHS_PER_YEAR;
    need += species === undefined || years >= species.maturity ? 1 : species.childNeed;
  }
  return need;
}

/** Décalages (dx, dy) d'un disque de rayon donné, gardés d'un appel à l'autre. */
const disks = new Map<number, Int32Array>();

function diskOffsets(radius: number): Int32Array {
  let offsets = disks.get(radius);
  if (offsets === undefined) {
    const list: number[] = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy <= radius * radius) list.push(dx, dy);
      }
    }
    offsets = Int32Array.from(list);
    disks.set(radius, offsets);
  }
  return offsets;
}

/** Biomes de prédilection de chaque sous-espèce, en masque par biome (ESP-02). */
const preferences = new WeakMap<Species, Uint8Array[]>();

function preferredBiomes(species: Species, subspecies: number, biomes: Catalog<Biome>) {
  let masks = preferences.get(species);
  if (masks === undefined) {
    masks = species.subspecies.map((entry) => {
      const wanted = new Set(entry.biomes);
      return Uint8Array.from(biomes.entries, (biome) => (wanted.has(biome.id) ? 1 : 0));
    });
    preferences.set(species, masks);
  }
  return masks[subspecies];
}

/** Cases et stocks du disque de cueillette d'un groupe, dans des tampons réutilisés. */
let diskCells = new Int32Array(64);
let diskStocks = new Float64Array(64 * 3);

/**
 * Nourrit un groupe un mois : il prend autour de lui la part des stocks qu'il lui faut
 * pour ses membres et sa réserve, mange, et la nutrition de chacun suit ce qu'il a eu.
 * Renvoie la part du besoin couverte, de 0 à 1.
 */
export function feedGroup(
  group: Group,
  members: readonly number[],
  people: Population,
  food: FoodStocks,
  world: WorldLayers,
  size: WorldSize,
  tick: number,
  content: ForageContent,
): number {
  if (members.length === 0) return 1;
  const { nomads } = content;
  const need = groupNeed(people, members, tick, content);
  const cap = nomads.reserve.months * need;
  // Biomes de prédilection : ceux de la sous-espèce dominante du premier membre, faute
  // de mieux pour un groupe mêlé.
  const first = members[0] ?? 0;
  const species = content.species.entries.at(people.get('species', first));
  const preferred =
    species === undefined
      ? undefined
      : preferredBiomes(species, dominantSubspecies(people, first).index, content.biomes);
  // Les cases du disque, dans l'ordre de disk() : x boucle, y reste dans le monde.
  const offsets = diskOffsets(nomads.forage.radius);
  if (diskCells.length < offsets.length / 2) {
    diskCells = new Int32Array(offsets.length / 2);
    diskStocks = new Float64Array((offsets.length / 2) * 3);
  }
  const cells = diskCells;
  const stocks = diskStocks;
  const { width, height } = size;
  let count = 0;
  for (let index = 0; index < offsets.length; index += 2) {
    const row = group.y + (offsets[index + 1] ?? 0);
    if (row < 0 || row >= height) continue;
    const column = wrapNearX(group.x + (offsets[index] ?? 0), width);
    cells[count++] = row * width + column;
  }
  let available = 0;
  for (let index = 0; index < count; index++) {
    const cell = cells[index] ?? 0;
    stocksInto(food, world, size, cell, tick, content, stocks, index * 3);
    const bonus = preferred?.[world.biome[cell] ?? 0] === 1 ? PREFERRED : 1;
    const total =
      (stocks[index * 3] ?? 0) + (stocks[index * 3 + 1] ?? 0) + (stocks[index * 3 + 2] ?? 0);
    available += total * nomads.forage.share * bonus;
  }
  const wanted = need + Math.max(0, cap - group.food);
  const harvest = Math.min(wanted, available);
  if (harvest > 0) {
    // Chaque stock perd la même part de ce qui y était pris.
    const kept = 1 - (harvest / available) * nomads.forage.share;
    for (let index = 0; index < count; index++) {
      const cell = cells[index] ?? 0;
      const plants = stocks[index * 3] ?? 0;
      const game = stocks[index * 3 + 1] ?? 0;
      const fish = stocks[index * 3 + 2] ?? 0;
      if (plants + game + fish <= 0) continue;
      const at = cell * FOOD_STRIDE;
      food.stocks[at] = plants * kept;
      food.stocks[at + 1] = game * kept;
      food.stocks[at + 2] = fish * kept;
      deplete(food, cell);
    }
  }
  const eaten = Math.min(need, harvest + group.food);
  group.food = Math.min(
    cap,
    Math.max(0, group.food + harvest - eaten) * (1 - nomads.reserve.spoilage),
  );
  const fed = need > 0 ? eaten / need : 1;
  // La nutrition suit, d'un mois à l'autre, la part du besoin couverte.
  const nutrition = people.columns.nutrition;
  for (const slot of members) {
    nutrition[slot] = Math.round((nutrition[slot] ?? 0) * 0.4 + 255 * fed * 0.6);
  }
  return fed;
}
