/**
 * Avancée de la simulation : un pas vaut un mois. Les commandes de jeu s'appliquent
 * au début du pas, puis les systèmes s'exécutent dans un ordre fixe (ADR 0003, ADR 0011) :
 * la nourriture repousse, les groupes cherchent leur nourriture et mangent, la
 * population vit (morts, naissances, couples), puis les groupes trop grands se scindent
 * et tous se déplacent.
 */
import type { Cultures, Genetics, Nomads, Species } from '../core/data';
import type { AltitudeLevel } from '../core/data/schemas';
import type { Catalog } from '../core/data/catalog';
import type { Biome } from '../core/data/schemas';
import { Fingerprint } from '../core/hash';
import type { GameCommand, PaintBiomeCommand } from '../core/protocol';
import { LAYER_NAMES } from '../core/world';
import { PARAMETER_NAMES } from '../core/data/worldgen';
import { feedGroup, regrowFood } from './forage';
import { groupMembers, mergeGroup, moveGroup, splitGroup, walkCost } from './groups';
import { lifeCycle } from './lifecycle';
import { fingerprintPeople } from './populationSave';
import { spawnGroup } from './spawn';
import { cellIndex, markDirty, type SimState } from './state';

/** Contenu dont la simulation se sert. */
export interface SimContent {
  readonly biomes: Catalog<Biome>;
  readonly species: Catalog<Species>;
  readonly genetics: Genetics;
  readonly cultures: Cultures;
  readonly altitudeLevels: Catalog<AltitudeLevel>;
  readonly nomads: Nomads;
}

/** Applique une commande ; une commande sans effet est sans danger. */
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
 * Fait avancer l'état d'un pas. Les commandes reçues s'appliquent d'abord, et sont
 * journalisées avec le pas au début duquel elles s'appliquent.
 */
export function step(state: SimState, commands: readonly GameCommand[], content: SimContent): void {
  for (const command of commands) {
    state.commandLog.push({ tick: state.tick, command });
    applyCommand(state, command, content);
  }
  // Systèmes, dans un ordre fixe.
  const { people, society, food, world, size, tick } = state;
  regrowFood(food, world, size, tick, content);
  let members = groupMembers(people);
  for (const group of society.groups.values()) {
    feedGroup(group, members.get(group.id) ?? [], people, food, world, size, tick, content);
  }
  lifeCycle(state, content);
  members = groupMembers(people);
  for (const group of [...society.groups.values()]) {
    mergeGroup(state, group, members, content);
  }
  members = groupMembers(people);
  const random = state.rng.stream('sim.groups');
  for (const group of [...society.groups.values()]) {
    splitGroup(state, group, members.get(group.id) ?? [], content, random);
  }
  members = groupMembers(people);
  for (const group of society.groups.values()) {
    moveGroup(state, group, members.get(group.id) ?? [], content, random);
  }
  state.tick++;
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
  for (const cell of state.food.list) {
    fingerprint
      .uint32(cell)
      .float64(state.food.plants[cell] ?? 0)
      .float64(state.food.game[cell] ?? 0)
      .float64(state.food.fish[cell] ?? 0);
  }
  for (const [name, words] of Object.entries(state.rng.states())) {
    fingerprint.string(name);
    for (const word of words) fingerprint.uint32(word);
  }
  return fingerprint.hex();
}
