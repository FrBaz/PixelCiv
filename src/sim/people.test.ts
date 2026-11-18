import { describe, expect, it } from 'vitest';
import { pureAncestry } from './genetics';
import { closeKin } from './people';
import { FEMALE, GENOME_WORDS, MALE, NONE, Population } from './population';

/** Une famille construite à la main : chacun par son nom, et son emplacement. */
function family() {
  const people = new Population();
  const slots = new Map<string, number>();
  const id = (name: string) => people.get('id', slots.get(name) ?? -1);
  const add = (name: string, sex: number, mother = '', father = '') => {
    const slot = people.add({
      sex,
      birth: -240,
      species: 0,
      ancestry: pureAncestry(1),
      genome: new Uint32Array(GENOME_WORDS),
      mother: mother === '' ? NONE : id(mother),
      father: father === '' ? NONE : id(father),
      group: 1,
      culture: 1,
      givenName: 1,
      familyName: 1,
      familyLanguage: 1,
    });
    slots.set(name, slot);
  };
  const marry = (a: string, b: string) => {
    people.set('partner', slots.get(a) ?? -1, id(b));
    people.set('partner', slots.get(b) ?? -1, id(a));
  };
  // Deux grands-parents, leurs enfants Anne et Bruno ; un fils d'un autre lit de la
  // grand-mère, Denis ; Anne épouse Carl, d'une autre famille.
  add('grand-mère', FEMALE);
  add('grand-père', MALE);
  add('autre homme', MALE);
  add('Anne', FEMALE, 'grand-mère', 'grand-père');
  add('Bruno', MALE, 'grand-mère', 'grand-père');
  add('Denis', MALE, 'grand-mère', 'autre homme');
  add('Carl', MALE);
  add('Eva', FEMALE);
  marry('Anne', 'Carl');
  marry('Bruno', 'Eva');
  // Les petits-enfants : Lise, fille d'Anne et de Carl ; Marc, fils de Bruno et d'Eva.
  add('Lise', FEMALE, 'Anne', 'Carl');
  add('Marc', MALE, 'Bruno', 'Eva');
  // Une veuve et son enfant d'un premier lit : Nina, fille de Rose et de Paul ; Rose,
  // morte, avait pour conjoint Serge.
  add('Rose', FEMALE);
  add('Paul', MALE);
  add('Nina', FEMALE, 'Rose', 'Paul');
  add('Serge', MALE);
  marry('Rose', 'Serge');
  add('Théo', MALE);
  const slot = (name: string) => slots.get(name) ?? -1;
  const kin = (a: string, b: string) => closeKin(people, slot(a), slot(b));
  return { people, slot, kin };
}

describe('proches parents (tâche 2.3, couples sans inceste)', () => {
  it('interdit parent et enfant, grand-parent, frère et sœur, demi-frère et demi-sœur', () => {
    const { kin } = family();
    expect(kin('Anne', 'grand-père')).toBe(true);
    expect(kin('Lise', 'grand-père')).toBe(true);
    expect(kin('grand-mère', 'Marc')).toBe(true);
    expect(kin('Anne', 'Bruno')).toBe(true);
    expect(kin('Anne', 'Denis')).toBe(true);
  });

  it('interdit oncle et nièce, tante et neveu, demi-oncle, dans les deux sens', () => {
    const { kin } = family();
    expect(kin('Lise', 'Bruno')).toBe(true);
    expect(kin('Bruno', 'Lise')).toBe(true);
    expect(kin('Anne', 'Marc')).toBe(true);
    expect(kin('Lise', 'Denis')).toBe(true);
  });

  it('interdit le conjoint, même veuf, d’un parent', () => {
    const { people, slot, kin } = family();
    expect(kin('Nina', 'Serge')).toBe(true);
    people.remove(slot('Rose'), 0, 'disease');
    expect(kin('Nina', 'Serge')).toBe(true);
    expect(kin('Eva', 'Lise')).toBe(false);
  });

  it('lit dans l’archive les parents d’un parent mort', () => {
    const { people, slot, kin } = family();
    people.remove(slot('Anne'), 0, 'disease');
    people.remove(slot('grand-père'), 0, 'disease');
    expect(kin('Lise', 'Bruno')).toBe(true);
    expect(kin('Lise', 'Denis')).toBe(true);
    expect(kin('Marc', 'grand-mère')).toBe(true);
  });

  it('permet les cousins germains et les inconnus', () => {
    const { kin } = family();
    expect(kin('Lise', 'Marc')).toBe(false);
    expect(kin('Lise', 'Théo')).toBe(false);
    expect(kin('Nina', 'Théo')).toBe(false);
    expect(kin('Carl', 'Eva')).toBe(false);
  });
});
