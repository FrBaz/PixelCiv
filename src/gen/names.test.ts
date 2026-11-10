import { describe, expect, it } from 'vitest';
import { familyName, givenName, MAX_NAME_LENGTH, phonology, wordOf } from './names';

const SEEDS = Array.from({ length: 40 }, (_, index) => (index + 1) * 2654435761);

/** Lettres que permettent les sons d'une langue. */
function letters(seed: number): Set<string> {
  const language = phonology(seed);
  const sounds = [
    ...language.consonants.map(([sound]) => sound),
    ...language.vowels.map(([sound]) => sound),
    ...language.clusters,
    ...language.codas,
    ...language.feminine,
    ...language.masculine,
  ];
  return new Set(sounds.join(''));
}

function names(seed: number, count: number): string[] {
  const language = phonology(seed);
  return Array.from({ length: count }, (_, code) =>
    code % 3 === 0
      ? givenName(language, 0, code)
      : code % 3 === 1
        ? givenName(language, 1, code)
        : familyName(language, code),
  );
}

describe('langues et noms (LAN-01, IND-08)', () => {
  it('redonnent les mêmes noms pour la même graine et le même code', () => {
    const a = phonology(12345);
    const b = phonology(12345);
    expect(a).toEqual(b);
    expect(givenName(a, 0, 7)).toBe(givenName(b, 0, 7));
    expect(familyName(a, 99)).toBe(familyName(b, 99));
    expect(wordOf(a, 3)).toBe(wordOf(b, 3));
  });

  it('donnent des noms variés, lisibles, qui commencent par une majuscule', () => {
    for (const seed of SEEDS) {
      const list = names(seed, 300);
      // Quelques prénoms reviennent, comme dans toute langue, mais rarement.
      expect(new Set(list).size).toBeGreaterThan(0.85 * list.length);
      for (const name of list) {
        expect(name).toMatch(/^[A-Z][a-z]+$/);
        expect(name.length).toBeGreaterThanOrEqual(3);
        expect(name.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
        // Jamais trois voyelles de suite, ni une consonne redoublée.
        expect(name.toLowerCase()).not.toMatch(/[aeiou]{3}/);
        expect(name.toLowerCase()).not.toMatch(/([^aeiou])\1/);
      }
    }
  });

  it("ne forment leurs noms qu'avec les sons de leur langue", () => {
    for (const seed of SEEDS) {
      const allowed = letters(seed);
      for (const name of names(seed, 100)) {
        for (const letter of name.toLowerCase()) expect(allowed.has(letter)).toBe(true);
      }
    }
  });

  it("donnent à chaque langue son identité sonore : deux langues n'ont pas les mêmes sons", () => {
    let distinct = 0;
    let pairs = 0;
    for (let a = 0; a < SEEDS.length; a++) {
      for (let b = a + 1; b < SEEDS.length; b++) {
        pairs++;
        const sounds = (seed: number) =>
          phonology(seed)
            .consonants.map(([sound]) => sound)
            .join(' ');
        if (sounds(SEEDS[a] ?? 0) !== sounds(SEEDS[b] ?? 0)) distinct++;
      }
    }
    expect(distinct / pairs).toBeGreaterThan(0.98);
  });

  it('marquent le genre des prénoms dans les langues qui le font', () => {
    let gendered = 0;
    for (const seed of SEEDS) {
      const language = phonology(seed);
      if (language.feminine.length === 0) continue;
      gendered++;
      for (let code = 0; code < 50; code++) {
        const female = givenName(language, 0, code).toLowerCase();
        const male = givenName(language, 1, code).toLowerCase();
        expect(language.feminine.some((ending) => female.endsWith(ending))).toBe(true);
        expect(language.masculine.some((ending) => male.endsWith(ending))).toBe(true);
      }
    }
    expect(gendered).toBeGreaterThan(SEEDS.length / 2);
  });
});
