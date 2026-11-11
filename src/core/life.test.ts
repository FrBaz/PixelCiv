import { describe, expect, it } from 'vitest';
import { loadGameData } from './data';
import { ageClass, ageCode, greyLevel, isMinor, lifeTable, type LifeAges } from './life';
import { MONTHS_PER_YEAR } from './time';
import { AGE_CLASSES, GREY_LEVELS } from './visual';

const human = loadGameData().species.entries.at(0);
if (human === undefined) throw new Error('pas d’humains');

/** Une espèce qui mûrit à 30 ans et vit 400 ans, aux âges à sa mesure. */
const elf = {
  maturity: 30,
  longevity: 400,
  ages: { ...human.ages, baby: 6, elder: 300, grey: [250, 380] as [number, number] },
};

describe('âges de la vie (D-6, A-10, U-12)', () => {
  it('range chacun par les âges de son espèce : nourrisson, enfant, adulte, aîné', () => {
    const { ages, maturity } = human;
    const classes = (species: LifeAges, years: readonly number[]) =>
      years.map((age) => ageClass(species, age));
    expect(
      classes(human, [0, ages.baby - 0.01, ages.baby, maturity - 0.01, maturity, ages.elder]),
    ).toEqual(['baby', 'baby', 'child', 'child', 'adult', 'elder']);
    // Une espèce longévive : enfant à 20 ans, adulte à 60, aînée à 300.
    expect(classes(elf, [5, 20, 60, 299, 300])).toEqual([
      'baby',
      'child',
      'adult',
      'adult',
      'elder',
    ]);
    for (const age of [0, 4, 20, 60, 350]) {
      expect(AGE_CLASSES[ageCode(elf, age)]).toBe(ageClass(elf, age));
    }
    expect(['baby', 'child', 'adult', 'elder'].map((stage) => isMinor(stage as never))).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it('grisonne par crans entre les deux âges de `ages.grey`', () => {
    const [from, to] = human.ages.grey;
    expect(greyLevel(human, from - 10)).toBe(0);
    expect(greyLevel(human, from)).toBe(0);
    expect(greyLevel(human, to)).toBe(GREY_LEVELS - 1);
    expect(greyLevel(human, to + 30)).toBe(GREY_LEVELS - 1);
    // De 40 à 70 ans chez les humains : un cran à 45 ans, deux à 55, trois à 65.
    expect([44, 45, 54, 55, 64, 65].map((age) => greyLevel(human, age))).toEqual([
      0, 1, 1, 2, 2, 3,
    ]);
    // L'elfe de 60 ans n'a pas un cheveu gris.
    expect(greyLevel(elf, 60)).toBe(0);
  });

  it('tabule par mois d’âge ce que donnent les deux fonctions, jusqu’à la longévité', () => {
    for (const species of [human, elf]) {
      const table = lifeTable(species);
      expect(table).toHaveLength(Math.ceil(species.longevity * MONTHS_PER_YEAR) + 1);
      expect(lifeTable(species)).toBe(table);
      table.forEach((looks, months) => {
        const years = months / MONTHS_PER_YEAR;
        expect(looks & 3).toBe(ageCode(species, years));
        expect(looks >> 2).toBe(greyLevel(species, years));
      });
    }
  });
});
