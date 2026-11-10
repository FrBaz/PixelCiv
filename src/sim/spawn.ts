/**
 * Apparition d'un groupe nomade (tâches 2.5 et 2.10 ; CRE-03, C2 D4 ; ADR 0011).
 *
 * Le Créateur fait apparaître des humains d'une sous-espèce sur une case de terre
 * praticable. Ils forment un groupe, qui reçoit une langue et une culture embryonnaires
 * (C2, D4) : il faut une langue pour nommer ses membres. Le groupe se compose de
 * familles : des couples en âge d'avoir des enfants, leurs enfants, nés d'eux (gènes et
 * noms compris), et quelques adultes seuls. Les lignées existent ainsi dès le départ.
 */
import type { SpawnGroupCommand } from '../core/protocol';
import type { RandomStream } from '../core/rng';
import { inheritGenome, pureAncestry, randomGenome } from './genetics';
import { FEMALE, GENOME_WORDS, MALE, NONE, NEVER, type Population } from './population';
import { MONTHS_PER_YEAR } from './people';
import { NAMING_RULES, type NamingRule } from './society';
import { cellIndex, type SimState } from './state';
import type { SimContent } from './step';

/** Réserve de nourriture d'un groupe qui apparaît, en mois de besoin par membre. */
const STARTING_FOOD = 2;

/** Nom de famille d'un enfant selon la règle de sa culture (IND-08). */
export function inheritedFamilyName(rule: NamingRule, mother: number, father: number): number {
  switch (rule) {
    case 'father':
    case 'both':
      return father;
    case 'mother':
      return mother;
    case 'none':
      return 0;
  }
}

function pickRule(content: SimContent, random: RandomStream): NamingRule {
  const weights = NAMING_RULES.map((rule) => content.cultures.naming[rule]);
  let target = random.nextFloat() * weights.reduce((sum, weight) => sum + weight, 0);
  for (let index = 0; index < NAMING_RULES.length; index++) {
    target -= weights[index] ?? 0;
    if (target < 0) return NAMING_RULES[index] ?? 'father';
  }
  return 'father';
}

/** Fait apparaître le groupe de la commande ; sans effet sur l'eau ou un relief infranchissable. */
export function spawnGroup(state: SimState, command: SpawnGroupCommand, content: SimContent): void {
  const cell = cellIndex(state.size, command.x, command.y);
  if (cell === undefined) return;
  const biome = content.biomes.entries.at(state.world.biome[cell] ?? 0);
  if (biome === undefined || biome.movementCost === null) return;
  const speciesIndex = content.species.indexOf(command.species);
  const species = content.species.entries.at(speciesIndex ?? -1);
  const subspeciesIndex =
    species?.subspecies.findIndex((entry) => entry.id === command.subspecies) ?? -1;
  const subspecies = species?.subspecies.at(subspeciesIndex);
  if (speciesIndex === undefined || species === undefined || subspecies === undefined) return;
  if (subspeciesIndex < 0) return;

  const random = state.rng.stream('sim.spawn');
  const { society, people, tick } = state;
  const x = cell % state.size.width;
  const y = (cell - x) / state.size.width;
  const language = { id: society.languages.length + 1, seed: random.nextUint32() };
  society.languages.push(language);
  const culture = {
    id: society.cultures.length + 1,
    language: language.id,
    naming: pickRule(content, random),
    founded: tick,
  };
  society.cultures.push(culture);
  const group = {
    id: society.nextGroupId++,
    culture: culture.id,
    founded: tick,
    parent: NONE,
    x,
    y,
    homeX: x,
    homeY: y,
    targetX: -1,
    targetY: -1,
    food: STARTING_FOOD * command.count,
  };
  society.groups.set(group.id, group);

  const ancestry = pureAncestry(subspeciesIndex);
  const years = (value: number) => Math.round(value * MONTHS_PER_YEAR);
  const adult = (sex: number, age: number, familyName: number): number => {
    const genome = new Uint32Array(GENOME_WORDS);
    randomGenome(content.genetics, subspecies, random, genome);
    return people.add({
      sex,
      birth: tick - years(age) - random.nextInt(MONTHS_PER_YEAR),
      species: speciesIndex,
      ancestry,
      genome,
      mother: NONE,
      father: NONE,
      group: group.id,
      culture: culture.id,
      givenName: random.nextUint32(),
      familyName,
    });
  };
  const { fertility, couple } = species;
  let remaining = command.count;
  while (remaining > 0) {
    if (remaining === 1) {
      adult(
        random.nextInt(2) === 0 ? FEMALE : MALE,
        random.nextRange(couple.minAge, 50),
        random.nextUint32(),
      );
      remaining--;
      continue;
    }
    // Un couple, et jusqu'à trois de leurs enfants.
    const womanAge = random.nextRange(couple.minAge + 2, fertility.peak + 12);
    const manAge = Math.max(couple.minAge, womanAge + random.nextRange(-2, 8));
    const mother = adult(FEMALE, womanAge, random.nextUint32());
    const father = adult(MALE, manAge, random.nextUint32());
    const motherId = people.get('id', mother);
    const fatherId = people.get('id', father);
    people.set('partner', mother, fatherId);
    people.set('partner', father, motherId);
    const children = Math.min(remaining - 2, random.nextInt(4));
    const motherAge = people.age(mother, tick);
    let youngest = NEVER;
    for (let child = 0; child < children; child++) {
      // Né quand sa mère avait l'âge d'être mère, et pas après aujourd'hui.
      const latest = Math.max(0, motherAge - years(fertility.from + 1));
      const age = random.nextInt(Math.min(latest, years(species.maturity)) + 1);
      const birth = tick - age;
      const genome = new Uint32Array(GENOME_WORDS);
      inheritGenome(
        content.genetics,
        people.columns.genome,
        mother * GENOME_WORDS,
        people.columns.genome,
        father * GENOME_WORDS,
        random,
        genome,
      );
      people.add({
        sex: random.nextInt(2) === 0 ? FEMALE : MALE,
        birth,
        species: speciesIndex,
        ancestry,
        genome,
        mother: motherId,
        father: fatherId,
        group: group.id,
        culture: culture.id,
        givenName: random.nextUint32(),
        familyName: inheritedFamilyName(
          culture.naming,
          people.get('familyName', mother),
          people.get('familyName', father),
        ),
      });
      youngest = Math.max(youngest, birth);
    }
    people.set('lastBirth', mother, youngest);
    remaining -= 2 + children;
  }
  society.chronicle.push({
    tick,
    kind: 'groupAppeared',
    x,
    y,
    group: group.id,
    other: NONE,
    count: command.count,
  });
}

/** Membres d'un groupe, dans l'ordre des emplacements (pour les tests et l'inspection). */
export function membersOf(people: Population, group: number): number[] {
  const members: number[] = [];
  people.forEach((slot) => {
    if (people.get('group', slot) === group) members.push(slot);
  });
  return members;
}
