/**
 * Langues et noms (tâche 2.6 ; LAN-01, IND-08 ; C2, D11 ; ADR 0011).
 *
 * Une langue naît d'une graine. On en tire une phonologie : un inventaire de consonnes
 * et de voyelles, chacune avec sa fréquence, des structures de syllabes, les groupes de
 * consonnes permis en attaque, les consonnes permises en fin de syllabe, et des
 * terminaisons qui marquent, ou non, le genre des prénoms. Tous les noms de la langue en
 * découlent, ce qui leur donne une identité sonore commune.
 *
 * Règles d'enchaînement, communes à toutes les langues : jamais deux voyelles de suite,
 * jamais une consonne redoublée, au plus deux consonnes de suite, et une fin de syllabe
 * prise parmi les consonnes que la langue permet à cette place.
 *
 * Un nom se désigne par un code entier, tiré à la naissance : la langue et le code
 * redonnent toujours le même nom, dans le worker comme sur le fil principal. Les
 * individus ne stockent donc que des codes, dans leurs colonnes typées.
 *
 * Fonctions pures : la même graine et le même code donnent le même résultat (CLAUDE.md).
 */
import { RandomStream, splitmix32 } from '../core/rng';

/** Une phonologie : de quoi former les mots d'une langue. */
export interface Phonology {
  readonly seed: number;
  /** Consonnes et voyelles, avec leur poids. */
  readonly consonants: readonly (readonly [string, number])[];
  readonly vowels: readonly (readonly [string, number])[];
  /** Groupes de consonnes permis en début de syllabe (« tr », « sk »…), peut-être aucun. */
  readonly clusters: readonly string[];
  /** Consonnes permises en fin de syllabe et de mot, peut-être aucune. */
  readonly codas: readonly string[];
  /** Structures de syllabes, avec leur poids : C pour une consonne, V pour une voyelle. */
  readonly syllables: readonly (readonly [string, number])[];
  /** Nombre de syllabes d'un nom : au moins, au plus. */
  readonly length: readonly [number, number];
  /** Terminaisons des prénoms féminins et masculins ; vides si la langue n'en a pas. */
  readonly feminine: readonly string[];
  readonly masculine: readonly string[];
}

/** Consonnes possibles, telles qu'un lecteur français les prononce sans peine. */
// prettier-ignore
const CONSONANTS = [
  'p', 'b', 't', 'd', 'k', 'g', 'm', 'n', 'l', 'r', 's', 'z', 'f', 'v', 'h', 'j', 'ch',
  'th', 'kh', 'w',
] as const;
/** Consonnes qui peuvent finir une syllabe, si la langue les a. */
const CODAS = ['n', 'm', 'l', 'r', 's', 'k', 't', 'th', 'ch', 'd', 'g'] as const;
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'ou', 'ai', 'ei', 'au'] as const;
// prettier-ignore
const CLUSTERS = [
  'tr', 'kr', 'pr', 'br', 'dr', 'gr', 'pl', 'bl', 'kl', 'gl', 'st', 'sk', 'sp', 'fr', 'vl',
] as const;
/** Structures : la voyelle seule ne commence qu'un mot. */
const STRUCTURES = ['CV', 'CVC', 'CCV', 'V', 'VC'] as const;
const FEMININE = ['a', 'i', 'e', 'ia', 'ra', 'na', 'is', 'el'] as const;
const MASCULINE = ['o', 'ar', 'us', 'an', 'ik', 'or', 'en', 'u'] as const;

const isVowel = (letter: string | undefined) =>
  letter !== undefined && letter !== '' && 'aeiou'.includes(letter);

/** Flux tiré d'une suite d'entiers : la graine d'une langue, un usage, un code. */
function streamOf(...words: number[]): RandomStream {
  let seed = 0x2545f491;
  for (const word of words) seed = splitmix32((seed ^ (word >>> 0)) >>> 0)();
  const next = splitmix32(seed);
  const state: [number, number, number, number] = [next(), next(), next(), next()];
  if (state.every((word) => word === 0)) state[0] = 1;
  return new RandomStream(state);
}

/** Usages des flux d'une langue : chacun a le sien, pour que l'un ne décale pas l'autre. */
const PHONOLOGY = 1;
const GIVEN = 2;
const FAMILY = 3;
const WORD = 4;

/** `count` éléments distincts d'une liste, au hasard, dans l'ordre de la liste. */
function subset<T>(items: readonly T[], count: number, random: RandomStream): T[] {
  const chosen = random
    .shuffle([...items.keys()])
    .slice(0, count)
    .sort((a, b) => a - b);
  return chosen.flatMap((index) => {
    const item = items[index];
    return item === undefined ? [] : [item];
  });
}

/** Poids tirés au sort et décroissants : quelques sons dominent, sans écraser les autres. */
function weights<T>(items: readonly T[], random: RandomStream): (readonly [T, number])[] {
  const ranks = random.shuffle([...items.keys()]);
  return items.map((item, index) => [item, 1 / (1 + 0.4 * (ranks[index] ?? 0))] as const);
}

function weightedPick<T>(items: readonly (readonly [T, number])[], random: RandomStream): T {
  const total = items.reduce((sum, [, weight]) => sum + weight, 0);
  let target = random.nextFloat() * total;
  for (const [item, weight] of items) {
    target -= weight;
    if (target < 0) return item;
  }
  const last = items.at(-1);
  if (last === undefined) throw new RangeError('liste vide');
  return last[0];
}

/** Phonologie de la langue de graine `seed`. */
export function phonology(seed: number): Phonology {
  const random = streamOf(seed, PHONOLOGY);
  const consonants = subset(CONSONANTS, random.nextRange(9, 15), random);
  // « a » et « i » sont presque universels ; le reste de l'inventaire varie. Les voyelles
  // doubles sont plus rares que les simples.
  const others = subset(
    VOWELS.filter((vowel) => vowel !== 'a' && vowel !== 'i'),
    random.nextRange(1, 5),
    random,
  );
  const vowels = weights(['a', 'i', ...others], random).map(
    ([vowel, weight]) => [vowel, vowel.length > 1 ? weight / 3 : weight] as const,
  );
  const clusters = random.nextBool(0.6)
    ? subset(
        CLUSTERS.filter((cluster) => consonants.some((c) => c === cluster.charAt(0))),
        random.nextRange(1, 4),
        random,
      )
    : [];
  const codas = subset(
    CODAS.filter((coda) => consonants.some((c) => c === coda)),
    random.nextRange(0, 5),
    random,
  );
  const structures: string[] = subset(STRUCTURES, random.nextRange(2, 5), random).filter(
    (structure) =>
      (clusters.length > 0 || !structure.includes('CC')) &&
      (codas.length > 0 || !structure.endsWith('C')),
  );
  if (!structures.includes('CV')) structures.unshift('CV');
  // La syllabe ouverte domine toutes les langues.
  const syllables = weights(structures, random).map(
    ([structure, weight]) => [structure, structure === 'CV' ? weight + 1 : weight] as const,
  );
  const gendered = random.nextBool(0.75);
  return {
    seed,
    consonants: weights(consonants, random),
    vowels,
    clusters,
    codas,
    syllables,
    length: [2, 3],
    feminine: gendered ? subset(FEMININE, 2, random) : [],
    masculine: gendered ? subset(MASCULINE, 2, random) : [],
  };
}

/** Ajoute un son à un mot, en respectant les règles d'enchaînement ; vrai s'il est ajouté. */
function append(parts: string[], sound: string): boolean {
  const word = parts.join('');
  const last = word.at(-1);
  const vowel = isVowel(sound.charAt(0));
  if (vowel && isVowel(last)) return false;
  if (!vowel && last !== undefined && last === sound.charAt(0)) return false;
  // Au plus deux consonnes de suite.
  if (!vowel && word.length >= 2 && !isVowel(last) && !isVowel(word.at(-2))) return false;
  parts.push(sound);
  return true;
}

/** Un mot de la langue, de `syllables` syllabes, tiré du flux. */
function makeWord(language: Phonology, syllables: number, random: RandomStream): string {
  const parts: string[] = [];
  for (let index = 0; index < syllables; index++) {
    let structure = weightedPick(language.syllables, random);
    // Une voyelle seule ne commence qu'un mot.
    if (index > 0 && structure.startsWith('V')) structure = `C${structure}`;
    for (let slot = 0; slot < structure.length; slot++) {
      const kind = structure[slot];
      const final = slot === structure.length - 1 && slot > 0;
      if (kind === 'C' && structure[slot + 1] === 'C') {
        append(parts, random.pick(language.clusters));
        slot++;
      } else if (kind === 'C' && final) {
        append(parts, random.pick(language.codas));
      } else {
        const sounds = kind === 'C' ? language.consonants : language.vowels;
        // Un son refusé (redoublé, troisième consonne de suite) en appelle un autre.
        for (let attempt = 0; attempt < 4; attempt++) {
          if (append(parts, weightedPick(sounds, random))) break;
        }
      }
    }
  }
  return parts.join('');
}

/** Un mot d'au moins trois lettres, dont une consonne. */
function sturdy(language: Phonology, word: string, random: RandomStream): string {
  let result = word;
  while (result.length < 3 || /^[aeiou]*$/.test(result)) {
    const parts = [result];
    for (const sound of makeWord(language, 1, random).match(/[aeiou]+|[^aeiou]+/g) ?? []) {
      append(parts, sound);
    }
    result = parts.join('');
  }
  return result;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function syllableCount(language: Phonology, random: RandomStream): number {
  const [min, max] = language.length;
  return random.nextRange(min, max + 1);
}

/** Longueur maximale d'un nom, en lettres. */
export const MAX_NAME_LENGTH = 12;

/**
 * Nom formé par `build` : il est reformé, sur deux syllables, tant qu'il dépasse
 * MAX_NAME_LENGTH lettres ; le dernier essai est coupé après une voyelle.
 */
function bounded(
  language: Phonology,
  random: RandomStream,
  build: (syllables: number) => string,
): string {
  let name = sturdy(language, build(syllableCount(language, random)), random);
  for (let attempt = 0; attempt < 4 && name.length > MAX_NAME_LENGTH; attempt++) {
    name = sturdy(language, build(2), random);
  }
  if (name.length > MAX_NAME_LENGTH) {
    const cut = name.slice(0, MAX_NAME_LENGTH);
    name = cut.replace(/[^aeiou]+$/, '') || cut;
  }
  return capitalize(name);
}

/** Mot de la langue désigné par un code : racine de nom de lieu, de peuple… */
export function wordOf(language: Phonology, code: number): string {
  const random = streamOf(language.seed, WORD, code);
  return bounded(language, random, (syllables) =>
    makeWord(language, syllables, random),
  ).toLowerCase();
}

/**
 * Prénom désigné par un code, pour une femme (sex 0) ou un homme (sex 1). Une langue
 * qui marque le genre termine les prénoms par l'une de ses terminaisons.
 */
export function givenName(language: Phonology, sex: number, code: number): string {
  const random = streamOf(language.seed, GIVEN, code);
  const endings = sex === 0 ? language.feminine : language.masculine;
  const ending = endings.length > 0 ? random.pick(endings) : undefined;
  return bounded(language, random, (syllables) => {
    let name = makeWord(language, syllables, random);
    if (ending !== undefined) {
      // La terminaison remplace la voyelle finale, et suit toujours une consonne.
      name = name.replace(/[aeiou]+$/, '');
      if (!isVowel(ending.charAt(0)) || name === '') name += language.vowels[0]?.[0] ?? 'a';
      name += ending;
    }
    return name;
  });
}

/** Nom de famille désigné par un code. */
export function familyName(language: Phonology, code: number): string {
  const random = streamOf(language.seed, FAMILY, code);
  return bounded(language, random, (syllables) => makeWord(language, syllables, random));
}
