import { describe, expect, it } from 'vitest';
import { familyName, givenName } from '../gen/names';
import { pureAncestry } from './genetics';
import { FEMALE, GENOME_WORDS, MALE, NONE, Population, type NewPerson } from './population';
import { personName, phonologyOf } from './records';
import { emptySociety, NAMING_RULES, type NamingRule } from './society';

/** Une société d'une langue et d'une culture par règle de nommage, dans l'ordre. */
function society() {
  const result = emptySociety();
  NAMING_RULES.forEach((naming, index) => {
    const id = index + 1;
    result.languages.push({ id, seed: 104729 * id });
    result.cultures.push({ id, language: id, naming, founded: 0 });
  });
  return result;
}

const culture = (rule: NamingRule) => NAMING_RULES.indexOf(rule) + 1;
const words = (language: number) => phonologyOf(104729 * language);

function add(people: Population, changes: Partial<NewPerson>): number {
  const slot = people.add({
    sex: FEMALE,
    birth: -240,
    species: 0,
    ancestry: pureAncestry(1),
    genome: new Uint32Array(GENOME_WORDS),
    mother: NONE,
    father: NONE,
    group: NONE,
    culture: 1,
    givenName: 5,
    familyName: 0,
    familyLanguage: changes.culture ?? 1,
    ...changes,
  });
  return people.get('id', slot);
}

describe('noms (IND-08 ; C2, D2 et D11)', () => {
  it('rend le prénom dans la langue de la culture, le nom de famille dans la sienne', () => {
    const people = new Population();
    const names = society();
    const father = culture('father');
    const both = culture('both');
    // Un homme de la culture « père », dont le nom vient de la langue de la culture « les deux ».
    const id = add(people, {
      sex: MALE,
      culture: father,
      givenName: 9,
      familyName: 77,
      familyLanguage: both,
    });
    expect(personName(people, names, id)).toBe(
      `${givenName(words(father), MALE, 9)} ${familyName(words(both), 77)}`,
    );
  });

  it('suit chaque règle de nommage', () => {
    const people = new Population();
    const names = society();
    const mother = add(people, {
      culture: culture('father'),
      familyName: 31,
      familyLanguage: culture('father'),
    });
    const child = (rule: NamingRule, code: number, language = culture(rule)) =>
      personName(
        people,
        names,
        add(people, {
          culture: culture(rule),
          mother,
          givenName: 6,
          familyName: code,
          familyLanguage: language,
        }),
      );
    const given = (rule: NamingRule) => givenName(words(culture(rule)), FEMALE, 6);
    const own = (code: number, rule: NamingRule) => familyName(words(culture(rule)), code);
    const maternal = familyName(words(culture('father')), 31);
    // Père, mère, nom obtenu : un nom de famille, celui de son code, dans sa langue.
    for (const rule of ['father', 'mother', 'earned'] as const) {
      expect(child(rule, 42)).toBe(`${given(rule)} ${own(42, rule)}`);
    }
    // Aucun nom de famille : le prénom seul.
    expect(child('none', 0)).toBe(given('none'));
    // « Les deux » : le nom du père, puis celui de la mère, chacun dans sa langue (D-11).
    expect(child('both', 42)).toBe(`${given('both')} ${own(42, 'both')} ${maternal}`);
    // Le nom de la mère n'est pas répété quand c'est aussi le sien.
    expect(child('both', 31, culture('father'))).toBe(`${given('both')} ${maternal}`);
    // Sans mère connue, ou sans nom de famille, le nom du père seul, ou le prénom seul.
    const orphan = add(people, { culture: culture('both'), familyName: 42 });
    expect(personName(people, names, orphan)).toBe(
      `${givenName(words(culture('both')), FEMALE, 5)} ${own(42, 'both')}`,
    );
    expect(child('both', 0)).toBe(given('both'));
  });

  it('nomme aussi les morts, et rien pour un inconnu', () => {
    const people = new Population();
    const names = society();
    const id = add(people, { familyName: 12 });
    const name = personName(people, names, id);
    people.remove(people.slotOf(id) ?? -1, 3, 'accident');
    expect(personName(people, names, id)).toBe(name);
    expect(personName(people, names, 999)).toBe('');
  });
});
