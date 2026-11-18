/**
 * Apparition d'un groupe nomade (tâches 2.5 et 2.10 ; CRE-03, C2 D4 ; ADR 0011).
 *
 * Le Créateur fait apparaître des humains d'une sous-espèce sur une case de terre
 * franchissable. Ils forment un groupe, qui reçoit une langue et une culture embryonnaires
 * (C2, D4) : il faut une langue pour nommer ses membres. Le groupe se compose de
 * familles : des couples en âge d'avoir des enfants, jusqu'à trois de leurs enfants, nés
 * d'eux (gènes et noms compris) à l'âge où la simulation les aurait eus, et au plus un
 * adulte seul. Les lignées existent ainsi dès le départ.
 *
 * Les âges se tirent en mois entiers, dans des bornes déduites de l'espèce (ESP-03) :
 * - les adultes, de l'âge du couple à la fin de la fécondité, au plus tard un an avant la
 *   longévité (spawnAdultAges ; le schéma garantit que l'intervalle n'est pas vide) ;
 *   l'homme d'un couple a au plus l'écart d'âge permis d'avec sa femme ;
 * - les enfants, du plus jeune au plus âgé, chacun au moins une grossesse et un
 *   allaitement après le précédent ; l'aîné est né quand ses parents étaient en âge
 *   d'être en couple et sa mère féconde, et n'est pas encore adulte.
 */
import { spawnAdultAges } from '../core/data/people';
import type { SpawnGroupCommand } from '../core/protocol';
import type { RandomStream } from '../core/rng';
import { inheritGenome, pureAncestry, randomGenome } from './genetics';
import {
  FEMALE,
  GENOME_WORDS,
  MALE,
  NONE,
  NEVER,
  type NewPerson,
  type Population,
} from './population';
import { MONTHS_PER_YEAR } from './people';
import { NAMING_RULES, type Group, type NamingRule } from './society';
import { cellIndex, type SimState } from './state';
import type { SimContent } from './step';

/** Réserve de nourriture d'un groupe qui apparaît, en mois de besoin par membre. */
const STARTING_FOOD = 2;
/** Enfants d'un couple qui apparaît, au plus. */
const MAX_CHILDREN = 3;

/** Nom de famille : son code (0 : aucun), et la langue qui le rend en texte. */
export interface FamilyName {
  readonly code: number;
  readonly language: number;
}

/** Code d'un nom tiré au sort ; jamais 0, qui veut dire « aucun nom ». */
export function nameCode(random: RandomStream): number {
  return random.nextUint32() || 1;
}

/**
 * Nom de famille d'un enfant selon la règle de sa culture (IND-08) : celui de son père
 * (« les deux » y ajoute, à l'affichage, celui de sa mère), celui de sa mère, aucun, ou
 * un nom obtenu, tiré de `random` dans `language`, la langue de sa culture. Un nom hérité
 * garde sa langue : il ne change pas d'un parent à l'enfant.
 */
export function inheritedFamilyName(
  rule: NamingRule,
  mother: FamilyName,
  father: FamilyName,
  language: number,
  random: RandomStream,
): FamilyName {
  switch (rule) {
    case 'father':
    case 'both':
      return father;
    case 'mother':
      return mother;
    case 'earned':
      return { code: nameCode(random), language };
    case 'none':
      return { code: 0, language };
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

/** Un membre prévu du groupe, avant son entrée dans la population. */
interface Planned {
  readonly person: NewPerson & { readonly genome: Uint32Array };
  /** Son conjoint, par son rang dans le plan, ou -1. */
  partner: number;
  /** Pas de son dernier accouchement, ou NEVER. */
  lastBirth: number;
}

/**
 * Fait apparaître le groupe de la commande ; sans effet sur une case infranchissable
 * (eau, lit d'un fleuve, sommet : `state.cost` infini) ou hors du monde.
 *
 * Tout se tire et se calcule d'abord : langue, culture, et chaque membre, dans l'ordre où
 * il entrera dans la population. L'état ne change qu'ensuite, d'un bloc, par des écritures
 * qui ne peuvent pas échouer : une exception en cours de route le laisse intact, hors du
 * générateur (applyCommand).
 */
export function spawnGroup(state: SimState, command: SpawnGroupCommand, content: SimContent): void {
  const cell = cellIndex(state.size, command.x, command.y);
  if (cell === undefined || !Number.isFinite(state.cost[cell] ?? Number.POSITIVE_INFINITY)) return;
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
  const culture = {
    id: society.cultures.length + 1,
    language: language.id,
    naming: pickRule(content, random),
    founded: tick,
  };
  const groupId = society.nextGroupId;

  // Les membres prévus, dans l'ordre de leur entrée dans la population, qui leur donnera
  // des identifiants consécutifs à partir de firstId.
  const planned: Planned[] = [];
  const firstId = people.nextId;
  const plan = (person: Planned['person']): number => {
    planned.push({ person, partner: -1, lastBirth: NEVER });
    return planned.length - 1;
  };
  const member = (index: number): Planned => {
    const found = planned.at(index);
    if (found === undefined) throw new RangeError(`membre prévu inconnu : ${index}`);
    return found;
  };
  const ancestry = pureAncestry(subspeciesIndex);
  const months = (years: number) => years * MONTHS_PER_YEAR;
  // Le nom d'un fondateur, dans la langue de sa culture : aucun si elle n'en donne pas.
  const founderName = (): FamilyName => {
    const code = nameCode(random);
    return { code: culture.naming === 'none' ? 0 : code, language: language.id };
  };
  /** Un adulte de `age` mois, sans parents connus ; renvoie son rang dans le plan. */
  const adult = (sex: number, age: number): number => {
    const family = founderName();
    const genome = new Uint32Array(GENOME_WORDS);
    randomGenome(content.genetics, subspecies, random, genome);
    return plan({
      sex,
      birth: tick - age,
      species: speciesIndex,
      ancestry,
      genome,
      mother: NONE,
      father: NONE,
      group: groupId,
      culture: culture.id,
      givenName: random.nextUint32(),
      familyName: family.code,
      familyLanguage: family.language,
    });
  };
  const { fertility, couple } = species;
  const [youngest, eldest] = spawnAdultAges(species);
  const gap = Math.floor(months(couple.maxGap));
  // Écart minimal entre deux naissances d'une même mère : une grossesse et un allaitement.
  const interval = fertility.gestation + fertility.postpartum;
  let remaining = command.count;
  while (remaining > 0) {
    if (remaining === 1) {
      adult(random.nextInt(2) === 0 ? FEMALE : MALE, random.nextRange(youngest, eldest + 1));
      remaining--;
      continue;
    }
    // Un couple, et jusqu'à trois de leurs enfants.
    const womanAge = random.nextRange(youngest, eldest + 1);
    const manAge = random.nextRange(
      Math.max(youngest, womanAge - gap),
      Math.min(eldest, womanAge + gap) + 1,
    );
    const motherIndex = adult(FEMALE, womanAge);
    const fatherIndex = adult(MALE, manAge);
    const mother = member(motherIndex);
    const father = member(fatherIndex);
    mother.partner = fatherIndex;
    father.partner = motherIndex;
    const wanted = Math.min(remaining - 2, random.nextInt(MAX_CHILDREN + 1));
    // L'aîné est né quand ses parents étaient en âge d'être en couple, sa mère féconde,
    // et il n'est pas encore adulte.
    const oldest = Math.min(
      womanAge - Math.max(youngest, Math.ceil(months(fertility.from))),
      manAge - youngest,
      Math.ceil(months(species.maturity)) - 1,
    );
    // Âges des enfants, du plus jeune au plus âgé.
    const ages: number[] = [];
    for (let age = random.nextInt(interval); ages.length < wanted && age <= oldest;) {
      ages.push(age);
      age += interval + random.nextInt(interval);
    }
    // Ils naissent dans l'ordre, de l'aîné au plus jeune.
    for (let index = ages.length - 1; index >= 0; index--) {
      const age = ages[index] ?? 0;
      const genome = new Uint32Array(GENOME_WORDS);
      inheritGenome(
        content.genetics,
        mother.person.genome,
        0,
        father.person.genome,
        0,
        random,
        genome,
      );
      const family = inheritedFamilyName(
        culture.naming,
        { code: mother.person.familyName, language: mother.person.familyLanguage },
        { code: father.person.familyName, language: father.person.familyLanguage },
        language.id,
        random,
      );
      plan({
        sex: random.nextInt(2) === 0 ? FEMALE : MALE,
        birth: tick - age,
        species: speciesIndex,
        ancestry,
        genome,
        mother: firstId + motherIndex,
        father: firstId + fatherIndex,
        group: groupId,
        culture: culture.id,
        givenName: random.nextUint32(),
        familyName: family.code,
        familyLanguage: family.language,
      });
    }
    // Le dernier accouchement : celui du plus jeune, dont l'allaitement suit son cours.
    const last = ages.at(0);
    mother.lastBirth = last === undefined ? NEVER : tick - last;
    remaining -= 2 + ages.length;
  }

  // Le groupe prend place, d'un bloc : plus rien ne tire au sort ni ne peut échouer.
  society.languages.push(language);
  society.cultures.push(culture);
  const group: Group = {
    id: society.nextGroupId++,
    culture: culture.id,
    founded: tick,
    parent: NONE,
    leader: NONE,
    x,
    y,
    homeX: x,
    homeY: y,
    targetX: -1,
    targetY: -1,
    food: STARTING_FOOD * command.count,
  };
  society.groups.set(group.id, group);
  const slots = planned.map((entry) => people.add(entry.person));
  planned.forEach((entry, index) => {
    const slot = slots[index] ?? 0;
    if (entry.partner >= 0) people.set('partner', slot, firstId + entry.partner);
    people.set('lastBirth', slot, entry.lastBirth);
  });
  // Le meneur : l'aîné du groupe ; à âge égal, le premier dans l'ordre des emplacements.
  const members = slots.sort((a, b) => a - b);
  const eldestMember = members.reduce(
    (best, slot) => (people.get('birth', slot) < people.get('birth', best) ? slot : best),
    members[0] ?? 0,
  );
  Object.assign(group, { leader: people.get('id', eldestMember) });
  society.chronicle.push({
    tick,
    kind: 'groupAppeared',
    x,
    y,
    group: group.id,
    other: NONE,
    leader: group.leader,
    otherLeader: NONE,
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
