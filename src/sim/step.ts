/**
 * Avancée de la simulation : un pas vaut un mois. Les commandes de jeu s'appliquent
 * au début du pas, puis les systèmes s'exécutent dans un ordre fixe (ADR 0003, ADR 0011) :
 * le cycle de vie de la population, pour l'instant.
 */
import type { Cultures, Genetics, Species } from '../core/data';
import type { Catalog } from '../core/data/catalog';
import type { Biome } from '../core/data/schemas';
import { Fingerprint } from '../core/hash';
import type { GameCommand, PaintBiomeCommand } from '../core/protocol';
import { LAYER_NAMES } from '../core/world';
import { PARAMETER_NAMES } from '../core/data/worldgen';
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
  lifeCycle(state, content);
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
  for (const [name, words] of Object.entries(state.rng.states())) {
    fingerprint.string(name);
    for (const word of words) fingerprint.uint32(word);
  }
  return fingerprint.hex();
}
