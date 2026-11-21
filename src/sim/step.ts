/**
 * Pas mensuel de la simulation (ADR 0003, ADR 0011, ADR 0013, ADR 0014) : les commandes de
 * jeu, et les systèmes du mois, qui s'exécutent dans un ordre fixe : le lieu de chaque groupe
 * se déduit de ses membres, la nourriture repousse, les groupes cherchent leur nourriture et
 * mangent, la population vit (morts, naissances, couples), les groupes trop petits
 * rejoignent un voisin, à un mois de marche au plus, les groupes trop grands se scindent, et
 * le guide de chacun choisit son camp, sauf ceux qui viennent de naître d'une scission, qui
 * ont déjà le leur, et ceux qui attendent un membre venu d'ailleurs ; enfin le plan du mois
 * dit qui part, et quand. Le sous-pas quotidien (day.ts) fait le pas mensuel au soir du
 * trentième jour.
 */
import type {
  Cultures,
  FaunaRules,
  FaunaSpecies,
  Genetics,
  Nomads,
  Seasons,
  Species,
} from '../core/data';
import type { AltitudeLevel } from '../core/data/schemas';
import type { Catalog } from '../core/data/catalog';
import type { Biome } from '../core/data/schemas';
import { Fingerprint } from '../core/hash';
import type { GameCommand, PaintBiomeCommand } from '../core/protocol';
import { LAYER_NAMES } from '../core/world';
import { PARAMETER_NAMES } from '../core/data/worldgen';
import { FAUNA_STREAM, faunaMonth, fingerprintFauna } from './fauna';
import { depletedCells, feedGroup, FOOD_STRIDE, regrowFood } from './forage';
import { groupMembers, mergeGroup, moveGroup, Neighborhood, splitGroup } from './groups';
import { lifeCycle } from './lifecycle';
import {
  clearFields,
  locateGroups,
  planMonth,
  rebuildMovement,
  recordGroups,
  waiting,
} from './movement';
import { NONE } from './population';
import { fingerprintPeople } from './populationSave';
import { spawnGroup } from './spawn';
import { markDirty, type SimState } from './state';
import { cellIndex, walkCost } from './terrain';

/** Contenu dont la simulation se sert. */
export interface SimContent {
  readonly biomes: Catalog<Biome>;
  readonly species: Catalog<Species>;
  readonly genetics: Genetics;
  readonly cultures: Cultures;
  readonly altitudeLevels: Catalog<AltitudeLevel>;
  readonly nomads: Nomads;
  /** Le gibier (ADR 0018) : ses espèces et ses règles communes. */
  readonly fauna: Catalog<FaunaSpecies>;
  readonly faunaRules: FaunaRules;
  /** La neige, la glace et la banquise (data/seasons.json ; ADR 0019). */
  readonly seasons: Seasons;
}

/**
 * Applique une commande ; une commande sans effet est sans danger. Une commande vérifie et
 * calcule tout avant de toucher à l'état : si elle lève une exception, seul le générateur
 * a pu avancer, et applyCommands le ramène en arrière. Une commande à venir qui déplacerait
 * ou retirerait un groupe en cours de mois devra aussi finir sa marche (ADR 0013).
 */
export function applyCommand(state: SimState, command: GameCommand, content: SimContent): void {
  switch (command.type) {
    case 'paintBiome':
      paintBiome(state, command, content);
      break;
    case 'spawnGroup':
      spawnGroup(state, command, content);
      break;
  }
}

/**
 * Le pinceau ne change que le biome d'une case de terre en un autre biome de terre : la
 * mer et les lacs, qui ont une profondeur, restent ce qu'ils sont. Il ne change donc jamais
 * la franchissabilité d'une case, puisque seule l'eau est infranchissable parmi les biomes
 * et que l'altitude, qui fait les sommets, ne change pas : la couche des terres
 * (`state.land`) reste juste sans se recalculer.
 */
function paintBiome(state: SimState, command: PaintBiomeCommand, content: SimContent): void {
  const index = cellIndex(state.size, command.x, command.y);
  const target = content.biomes.indexOf(command.biome);
  if (index === undefined || target === undefined) return;
  const water = (biome: number) => content.biomes.entries.at(biome)?.family === 'water';
  const current = state.world.biome[index] ?? 0;
  if (current === target || water(current) || water(target)) return;
  state.world.biome[index] = target;
  state.cost[index] = walkCost(state.world, index, content);
  // Les champs de distances des camps suivaient l'ancien coût (ADR 0014).
  clearFields(state);
  // Les cibles du gibier suivent l'habitat, qui suit le biome (ADR 0018).
  state.fauna.base = undefined;
  markDirty(state, index);
}

/**
 * Commande écartée : elle a levé `error` en s'appliquant. L'état est resté celui d'avant
 * elle, générateur compris, et elle n'entre pas au journal.
 */
export type RejectedCommand = (command: GameCommand, error: unknown) => void;

/**
 * Applique des commandes, dans l'ordre, et les journalise avec l'instant où elles
 * s'appliquent : le mois et le jour courants, avant que le jour suivant ne passe. Sans `rejected`,
 * l'exception d'une commande remonte ; avec, la commande est écartée et signalée. Les caches
 * du mouvement se refont d'après l'état après chaque commande appliquée, un groupe ayant pu
 * apparaître : la commande suivante voit les places qu'il tient. Un lot donne donc l'état
 * de ses commandes appliquées une à une.
 *
 * advanceDay les applique au début du jour, et le rejeu par lots d'un même instant. L'hôte,
 * en pause, les applique une à une, dès leur réception : rien ne change l'état d'ici le jour
 * suivant, qui commence donc là où il aurait commencé après elles, et le rejeu du journal ne
 * voit aucune différence.
 */
export function applyCommands(
  state: SimState,
  commands: readonly GameCommand[],
  content: SimContent,
  rejected?: RejectedCommand,
): void {
  if (commands.length === 0) return;
  try {
    applyEach(state, commands, content, rejected);
  } finally {
    rebuildMovement(state);
  }
}

function applyEach(
  state: SimState,
  commands: readonly GameCommand[],
  content: SimContent,
  rejected: RejectedCommand | undefined,
): void {
  for (const command of commands) {
    if (rejected === undefined) {
      applyCommand(state, command, content);
    } else {
      const streams = state.rng.states();
      try {
        applyCommand(state, command, content);
      } catch (error) {
        state.rng.restore(streams);
        rejected(command, error);
        continue;
      }
    }
    state.commandLog.push({ tick: state.tick, day: state.day, command });
    rebuildMovement(state);
  }
}

/**
 * Pas mensuel : les systèmes du mois, dans un ordre fixe, puis le mois suivant commence
 * (`tick` augmente). Le relevé des groupes, au début, dit au plan du mois qui a changé de
 * groupe et quel camp a changé. Renvoie les membres de chaque groupe à la fin du mois, dans
 * l'ordre des emplacements, tels que les donnerait groupMembers. Les commandes ne passent pas
 * par lui, mais par advanceDay.
 */
export function monthStep(
  state: SimState,
  content: SimContent,
): ReadonlyMap<number, readonly number[]> {
  // Systèmes, dans un ordre fixe.
  const { people, society, food, world, size, tick } = state;
  const record = recordGroups(state);
  let members = groupMembers(people);
  locateGroups(state, members);
  const { calendars } = state;
  regrowFood(food, world, size, calendars, tick, content);
  for (const group of society.groups.values()) {
    const fed = members.get(group.id) ?? [];
    feedGroup(group, fed, people, food, world, size, calendars, tick, content);
  }
  // Le voisinage des groupes, en temps de trajet, depuis leur lieu : mariages et réunions le
  // partagent.
  const neighbors = new Neighborhood(state, content.nomads.marriage);
  lifeCycle(state, content, members, neighbors);
  // Les fusions se décident toutes sur les membres d'après le cycle de vie ; les listes
  // se mettent à jour ensuite, dans l'ordre des emplacements, comme si on les recomptait.
  members = groupMembers(people);
  const merges: [from: number, into: number][] = [];
  for (const group of [...society.groups.values()]) {
    const into = mergeGroup(state, group, members, content, neighbors);
    if (into !== undefined) merges.push([group.id, into.id]);
  }
  for (const [from, into] of merges) {
    members.set(into, mergeSlots(members.get(into) ?? [], members.get(from) ?? []));
    members.delete(from);
  }
  const random = state.rng.stream('sim.groups');
  const groupOf = people.columns.group;
  for (const group of [...society.groups.values()]) {
    const list = members.get(group.id) ?? [];
    const child = splitGroup(state, group, list, content, random);
    if (child === undefined) continue;
    members.set(
      group.id,
      list.filter((slot) => groupOf[slot] === group.id),
    );
    members.set(
      child.id,
      list.filter((slot) => groupOf[slot] === child.id),
    );
  }
  for (const group of society.groups.values()) {
    // Un groupe né d'une scission ce mois-ci a déjà son camp (splitGroup) ; un groupe attend
    // le membre venu d'ailleurs qui n'est pas encore près de son camp.
    if (group.founded === tick && group.parent !== NONE) continue;
    const list = members.get(group.id) ?? [];
    if (waiting(state, content, group, list, record)) continue;
    moveGroup(state, group, list, content, random);
  }
  planMonth(state, content, record, members);
  // Le gibier se tient au stock, une fois la chasse du mois faite (ADR 0018).
  faunaMonth(state, content);
  state.tick++;
  return members;
}

/** Réunion de deux listes d'emplacements croissantes et disjointes, croissante. */
function mergeSlots(a: readonly number[], b: readonly number[]): number[] {
  const merged: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const left = a[i] ?? Number.POSITIVE_INFINITY;
    const right = b[j] ?? Number.POSITIVE_INFINITY;
    if (left < right) {
      merged.push(left);
      i++;
    } else {
      merged.push(right);
      j++;
    }
  }
  return merged;
}

/**
 * Empreinte de l'état du monde, pour les tests de déterminisme. Sans le gibier (`fauna: false`),
 * ni ses colonnes ni son flux n'y entrent : c'est l'empreinte d'avant la tâche 2b.6, qui montre
 * que la suite des humains ne change pas avec lui (ADR 0018, § 6).
 */
export function fingerprint(state: SimState, options: { readonly fauna?: boolean } = {}): string {
  const withFauna = options.fauna ?? true;
  const fingerprint = new Fingerprint()
    .string(state.params.seed)
    .string(state.params.size)
    .uint32(state.tick);
  for (const name of PARAMETER_NAMES) fingerprint.string(name).float64(state.params[name]);
  for (const name of LAYER_NAMES) fingerprint.string(name).typedArray(state.world[name]);
  fingerprintPeople(fingerprint, state.people, state.society);
  if (withFauna) fingerprintFauna(fingerprint, state.fauna);
  for (const cell of depletedCells(state.food)) {
    fingerprint
      .uint32(cell)
      .float64(state.food.stocks[cell * FOOD_STRIDE] ?? 0)
      .float64(state.food.stocks[cell * FOOD_STRIDE + 1] ?? 0)
      .float64(state.food.stocks[cell * FOOD_STRIDE + 2] ?? 0);
  }
  for (const [name, words] of Object.entries(state.rng.states())) {
    if (!withFauna && name === FAUNA_STREAM) continue;
    fingerprint.string(name);
    for (const word of words) fingerprint.uint32(word);
  }
  // Le jour du mois (ADR 0013) ; positions et mouvements sont dans les colonnes des vivants.
  fingerprint.uint32(state.day);
  return fingerprint.hex();
}
