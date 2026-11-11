/**
 * Avancée de la simulation : un pas vaut un mois. Les commandes de jeu s'appliquent
 * au début du pas, puis les systèmes s'exécutent dans un ordre fixe (ADR 0003, ADR 0011) :
 * la nourriture repousse, les groupes cherchent leur nourriture et mangent, la
 * population vit (morts, naissances, couples), les groupes trop petits rejoignent un
 * voisin, les groupes trop grands se scindent, et tous se déplacent, sauf ceux qui
 * viennent de naître d'une scission, déjà partis vers leur aire.
 */
import type { Cultures, Genetics, Nomads, Species } from '../core/data';
import type { AltitudeLevel } from '../core/data/schemas';
import type { Catalog } from '../core/data/catalog';
import type { Biome } from '../core/data/schemas';
import { Fingerprint } from '../core/hash';
import type { GameCommand, PaintBiomeCommand } from '../core/protocol';
import { LAYER_NAMES } from '../core/world';
import { PARAMETER_NAMES } from '../core/data/worldgen';
import { depletedCells, feedGroup, FOOD_STRIDE, regrowFood } from './forage';
import { groupMembers, mergeGroup, moveGroup, splitGroup } from './groups';
import { lifeCycle } from './lifecycle';
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
}

/**
 * Applique une commande ; une commande sans effet est sans danger. Une commande vérifie et
 * calcule tout avant de toucher à l'état : si elle lève une exception, seul le générateur
 * a pu avancer, et step le ramène en arrière.
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
 * mer et les lacs, qui ont une profondeur, restent ce qu'ils sont.
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
  markDirty(state, index);
}

/**
 * Commande écartée : elle a levé `error` en s'appliquant. L'état est resté celui d'avant
 * elle, générateur compris, et elle n'entre pas au journal.
 */
export type RejectedCommand = (command: GameCommand, error: unknown) => void;

/**
 * Applique des commandes, dans l'ordre, et les journalise avec le pas au début duquel
 * elles s'appliquent : le pas courant, qui n'a pas encore commencé. Sans `rejected`,
 * l'exception d'une commande remonte ; avec, la commande est écartée et signalée.
 *
 * step les applique au début du mois. L'hôte, en pause, les applique dès leur réception :
 * rien ne change l'état d'ici le pas suivant, qui commence donc là où il aurait commencé
 * après elles, et le rejeu du journal ne voit aucune différence.
 */
export function applyCommands(
  state: SimState,
  commands: readonly GameCommand[],
  content: SimContent,
  rejected?: RejectedCommand,
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
    state.commandLog.push({ tick: state.tick, command });
  }
}

/**
 * Fait passer un mois. Les commandes reçues s'appliquent d'abord (applyCommands) ; sans
 * `rejected`, l'exception d'une commande remonte ; avec, la commande est écartée et
 * signalée, et le mois continue. Renvoie les membres de chaque groupe à la fin du mois,
 * dans l'ordre des emplacements, tels que les donnerait groupMembers.
 */
export function step(
  state: SimState,
  commands: readonly GameCommand[],
  content: SimContent,
  rejected?: RejectedCommand,
): ReadonlyMap<number, readonly number[]> {
  applyCommands(state, commands, content, rejected);
  // Systèmes, dans un ordre fixe.
  const { people, society, food, world, size, tick } = state;
  regrowFood(food, world, size, tick, content);
  let members = groupMembers(people);
  for (const group of society.groups.values()) {
    feedGroup(group, members.get(group.id) ?? [], people, food, world, size, tick, content);
  }
  lifeCycle(state, content, members);
  // Les fusions se décident toutes sur les membres d'après le cycle de vie ; les listes
  // se mettent à jour ensuite, dans l'ordre des emplacements, comme si on les recomptait.
  members = groupMembers(people);
  const merges: [from: number, into: number][] = [];
  for (const group of [...society.groups.values()]) {
    const into = mergeGroup(state, group, members, content);
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
    // Un groupe né d'une scission ce mois-ci a déjà fait sa marche du mois (splitGroup).
    if (group.founded === tick && group.parent !== NONE) continue;
    moveGroup(state, group, members.get(group.id) ?? [], content, random);
  }
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

/** Empreinte de l'état du monde, pour les tests de déterminisme. */
export function fingerprint(state: SimState): string {
  const fingerprint = new Fingerprint()
    .string(state.params.seed)
    .string(state.params.size)
    .uint32(state.tick);
  for (const name of PARAMETER_NAMES) fingerprint.string(name).float64(state.params[name]);
  for (const name of LAYER_NAMES) fingerprint.string(name).typedArray(state.world[name]);
  fingerprintPeople(fingerprint, state.people, state.society);
  for (const cell of depletedCells(state.food)) {
    fingerprint
      .uint32(cell)
      .float64(state.food.stocks[cell * FOOD_STRIDE] ?? 0)
      .float64(state.food.stocks[cell * FOOD_STRIDE + 1] ?? 0)
      .float64(state.food.stocks[cell * FOOD_STRIDE + 2] ?? 0);
  }
  for (const [name, words] of Object.entries(state.rng.states())) {
    fingerprint.string(name);
    for (const word of words) fingerprint.uint32(word);
  }
  return fingerprint.hex();
}
