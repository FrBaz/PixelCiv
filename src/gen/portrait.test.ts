import { describe, expect, it } from 'vitest';
import { loadGameData, type FaceShape, type NoseShape } from '../core/data';
import { FACE_BOUNDS, geneRoles, NOSE_BOUNDS } from '../core/data/people';
import { ageClass, type LifeAges } from '../core/life';
import { ROLE } from '../core/visual';
import { PORTRAIT_SIZE, portraitRoles, type PortraitInput } from './portrait';

const data = loadGameData();
const roles = geneRoles(data.genetics);
const human: LifeAges = data.species.entries[0] ?? missing();

function missing(): never {
  throw new Error('donnée absente');
}

/** Forme du visage, ou du nez, d'un allèle de data/genetics.json. */
function face(id: string): FaceShape {
  const locus = data.genetics.loci.at(roles.loci.face);
  return locus?.alleles.find((allele) => allele.id === id)?.face ?? missing();
}

function nose(id: string): NoseShape {
  const locus = data.genetics.loci.at(roles.loci.nose);
  return locus?.alleles.find((allele) => allele.id === id)?.nose ?? missing();
}

const FACES = ['oval', 'round', 'square', 'long'];

const adult: PortraitInput = {
  sex: 0,
  age: 30,
  stage: 'adult',
  species: human,
  face: face('oval'),
  nose: nose('straight'),
  variant: 12345,
};

/** Le portrait de `input`, à `age` ans, de la classe d'âge que son espèce donne à cet âge. */
function aged(input: PortraitInput, age: number): Uint8Array {
  return portraitRoles({ ...input, age, stage: ageClass(input.species, age) });
}

/** Pixels d'un rôle. */
function count(roles: Uint8Array, role: number): number {
  return roles.reduce((total, value) => total + (value === role ? 1 : 0), 0);
}

/** Silhouette de la peau : les pixels de peau, d'ombre et de lumière comprises. */
function skin(roles: Uint8Array): number[] {
  const skinRoles: number[] = [ROLE.skin, ROLE.skinShadow, ROLE.skinLight];
  return Array.from(roles, (role) => (skinRoles.includes(role) ? 1 : 0));
}

describe('portraits (REN-07)', () => {
  it('dessine un portrait de 64 × 64 rôles, toujours le même pour un même individu', () => {
    const roles = portraitRoles(adult);
    expect(roles).toHaveLength(PORTRAIT_SIZE * PORTRAIT_SIZE);
    expect(Array.from(portraitRoles(adult))).toEqual(Array.from(roles));
    expect(count(roles, ROLE.outline)).toBeGreaterThan(50);
    expect(count(roles, ROLE.eye)).toBe(8);
    expect(Math.max(...roles)).toBeLessThanOrEqual(ROLE.mouth);
  });

  it('suit les gènes : la forme du visage change avec son allèle, pas avec le reste', () => {
    const round = portraitRoles({ ...adult, face: face('round') });
    const long = portraitRoles({ ...adult, face: face('long') });
    expect(skin(round)).not.toEqual(skin(long));
    // Deux nez différents sur un même visage : la silhouette ne change presque pas.
    const broad = portraitRoles({ ...adult, nose: nose('broad') });
    const differences = skin(broad).filter(
      (value, index) => value !== skin(portraitRoles(adult))[index],
    );
    expect(differences.length).toBeLessThan(8);
  });

  it('vieillit : rides et cheveux du dessus changent, le visage reste le sien', () => {
    const young = aged({ ...adult, sex: 1, variant: 48 }, 25);
    const old = aged({ ...adult, sex: 1, variant: 48 }, 70);
    expect(Array.from(old)).not.toEqual(Array.from(young));
    // La calvitie dégarnit le sommet du crâne : moins de cheveux.
    const hair = (roles: Uint8Array) =>
      count(roles, ROLE.hair) + count(roles, ROLE.hairShadow) + count(roles, ROLE.hairLight);
    expect(hair(old)).toBeLessThan(hair(young));
    // Un enfant a une tête plus petite.
    const child = aged(adult, 4);
    expect(skin(child).reduce((a, b) => a + b, 0)).toBeLessThan(
      skin(portraitRoles(adult)).reduce((a, b) => a + b, 0),
    );
  });

  it('ride le front et creuse les pattes d’oie des deux côtés, chevelu ou non (A-2)', () => {
    // Pixels d'ombre de peau au milieu du front, au-dessus des sourcils (rangée 22 chez
    // l'adulte), loin du côté de l'ombre du visage.
    const forehead = (roles: Uint8Array) => {
      let total = 0;
      for (let y = 10; y <= 21; y++) {
        for (let x = 27; x <= 37; x++)
          if (roles[y * PORTRAIT_SIZE + x] === ROLE.skinShadow) total++;
      }
      return total;
    };
    // Pixels changés d'un âge à l'autre autour des yeux, d'un côté du visage.
    const eyes = (before: Uint8Array, after: Uint8Array, side: -1 | 1) => {
      let total = 0;
      for (let y = 22; y <= 28; y++) {
        for (let x = 16; x <= 48; x++) {
          const index = y * PORTRAIT_SIZE + x;
          if (Math.sign(x - 31.5) === side && before[index] !== after[index]) total++;
        }
      }
      return total;
    };
    // Femmes et hommes de chaque visage ; variantes à cheveux longs ou courts, à frange, à
    // barbe, à calvitie.
    for (const sex of [0, 1]) {
      for (const id of FACES) {
        for (const variant of [0, 1, 7, 8, 48, 64, 128, 192, 0x2c5f3e91]) {
          const at = (age: number) => aged({ ...adult, sex, face: face(id), variant }, age);
          const where = `sexe ${String(sex)}, ${id}, variante ${String(variant)}`;
          expect(forehead(at(40)), where).toBeGreaterThan(forehead(at(39)));
          expect(forehead(at(60)), where).toBeGreaterThan(forehead(at(40)));
          expect(forehead(at(30)), where).toBe(0);
          expect(eyes(at(44), at(45), -1), where).toBeGreaterThan(0);
          expect(eyes(at(44), at(45), 1), where).toBeGreaterThan(0);
        }
      }
    }
  });

  it('dessine la forme que porte un allèle, même nouveau, sans rien en nommer (A-10)', () => {
    // Un visage en cœur et un nez busqué, inconnus du code : ils se dessinent, chacun à
    // part de toutes les formes des données.
    const heart: FaceShape = { width: 13, height: 16, power: 2, jaw: 0.45 };
    const hooked: NoseShape = { length: 3, hump: true, wing: 3, base: false };
    const drawn = portraitRoles({ ...adult, face: heart, nose: hooked });
    for (const id of FACES)
      expect(skin(drawn)).not.toEqual(skin(portraitRoles({ ...adult, face: face(id) })));
    for (const id of ['straight', 'broad', 'aquiline', 'small']) {
      const known = portraitRoles({ ...adult, face: heart, nose: nose(id) });
      expect(Array.from(drawn)).not.toEqual(Array.from(known));
    }
    // La mâchoire plus étroite du cœur affine le bas du visage : moins de peau sous le nez.
    const below = (roles: Uint8Array) =>
      skin(roles)
        .slice(34 * PORTRAIT_SIZE)
        .reduce((a, b) => a + b, 0);
    expect(below(drawn)).toBeLessThan(below(portraitRoles({ ...adult, nose: hooked })));
  });

  it('garde, aux bornes des formes du schéma, les traits de l’adulte dans la tête (A-10)', () => {
    // Les coins du domaine des visages et des nez que data/genetics.json peut décrire : les
    // yeux, leur blanc, la bouche et les narines de l'adulte restent entiers, aucun ne
    // touche le bord de la tête, et rien ne sort par le haut du canevas.
    const { width, height, jaw } = FACE_BOUNDS;
    // Les narines de l'adulte : sous le bout du nez (cy + 6, cy = 26), à `wing` pixels de
    // part et d'autre du milieu (cx = 32).
    const nostrils = (roles: Uint8Array, shape: NoseShape) => {
      const y = 26 + 6;
      return [32 - shape.wing + 1, 32 + shape.wing].map((x) => roles[y * PORTRAIT_SIZE + x]);
    };
    let drawn = 0;
    for (const w of width)
      for (const h of height)
        for (const power of [2, 4] as const)
          for (const j of jaw)
            for (const wing of NOSE_BOUNDS.wing)
              for (const sex of [0, 1])
                for (const variant of [0, 8, 48, 0xffffffff]) {
                  const shape: NoseShape = { length: 4, hump: false, wing, base: true };
                  const input = {
                    ...adult,
                    sex,
                    variant,
                    face: { width: w, height: h, power, jaw: j },
                    nose: shape,
                  };
                  const where = JSON.stringify({ sex, variant, face: input.face, nose: shape });
                  const roles = aged(input, 70);
                  const same = aged({ ...input, face: adult.face, nose: adult.nose }, 70);
                  for (const role of [ROLE.eye, ROLE.white, ROLE.mouth]) {
                    expect(count(roles, role), where).toBe(count(same, role));
                  }
                  expect(nostrils(roles, shape), where).toEqual([ROLE.skinShadow, ROLE.skinShadow]);
                  expect(
                    roles.subarray(0, PORTRAIT_SIZE).every((role) => role === ROLE.transparent),
                    where,
                  ).toBe(true);
                  drawn++;
                }
    expect(drawn).toBe(256);
  });

  it('dessine chacun des paramètres de forme du visage et du nez', () => {
    const roles = (input: PortraitInput) => Array.from(portraitRoles(input));
    const base = face('oval');
    const faces: FaceShape[] = [
      { ...base, width: base.width + 1 },
      { ...base, height: base.height + 1 },
      { ...base, power: 4 },
      { ...base, jaw: 0.5 },
    ];
    for (const shape of faces) expect(roles({ ...adult, face: shape })).not.toEqual(roles(adult));
    const straight = nose('straight');
    const noses: NoseShape[] = [
      { ...straight, length: 2 },
      { ...straight, hump: true },
      { ...straight, wing: 3 },
      { ...straight, base: true },
    ];
    for (const shape of noses) expect(roles({ ...adult, nose: shape })).not.toEqual(roles(adult));
    // Chaque longueur d'arête et chaque largeur de narines que le schéma permet se dessine
    // autrement chez l'adulte : aucune ne se confond avec une autre.
    for (const parameter of ['length', 'wing'] as const) {
      const bounds: readonly [number, number] = NOSE_BOUNDS[parameter];
      const [from, to] = bounds;
      const drawn = new Set<string>();
      for (let value = from; value <= to; value++) {
        drawn.add(roles({ ...adult, nose: { ...straight, [parameter]: value } }).join());
      }
      expect(drawn.size, parameter).toBe(to - from + 1);
    }
  });

  it('suit les âges de son espèce : enfant jusqu’à sa maturité, sans barbe ni rides (D-6)', () => {
    // Une espèce qui mûrit à 30 ans et vit 400 ans, aux âges de la barbe et des rides des
    // humains : à 20 ans, encore enfant, elle n'a pas de barbe, et en a une à 30 ans.
    const elf: LifeAges = {
      maturity: 30,
      ages: { ...human.ages, baby: 6, elder: 300, grey: [250, 380] },
    };
    // Un homme aux cheveux courts, qui porte la barbe adulte.
    const man = { ...adult, sex: 1, variant: 9 };
    // Les poils sous la bouche : la barbe, rien d'autre chez un homme aux cheveux courts.
    const beard = (roles: Uint8Array) =>
      Array.from(roles.subarray(36 * PORTRAIT_SIZE)).filter(
        (role) => role === ROLE.hair || role === ROLE.hairShadow || role === ROLE.hairLight,
      ).length;
    expect(beard(aged(man, 20))).toBeGreaterThan(10);
    expect(beard(aged({ ...man, species: elf }, 20))).toBe(0);
    expect(beard(aged({ ...man, species: elf }, 30))).toBeGreaterThan(10);
    // Une tête d'enfant, plus petite que celle de l'adulte qu'il deviendra.
    const area = (roles: Uint8Array) => skin(roles).reduce((a, b) => a + b, 0);
    expect(area(aged({ ...adult, species: elf }, 20))).toBeLessThan(
      area(aged({ ...adult, species: elf }, 30)),
    );
    // Elle grandit jusqu'à la maturité de son espèce, et non jusqu'à 15 ans.
    expect(area(aged({ ...adult, species: elf }, 15))).toBeLessThan(
      area(aged({ ...adult, species: elf }, 29)),
    );
    // Un enfant n'a ni barbe, ni calvitie, ni rides, même passé les âges où elles viennent :
    // son portrait est celui d'une espèce où elles ne viennent jamais.
    const late: LifeAges = { maturity: 70, ages: { ...human.ages, elder: 80, grey: [75, 90] } };
    const never: LifeAges = {
      ...late,
      ages: {
        ...late.ages,
        beard: 999,
        bald: 999,
        wrinkles: { forehead: 999, eyes: 999, mouth: 999, deep: 999 },
      },
    };
    for (const variant of [9, 48, 56, 0x2c5f3e91]) {
      const child = { ...adult, sex: 1, variant, species: late };
      expect(Array.from(aged(child, 65))).toEqual(
        Array.from(aged({ ...child, species: never }, 65)),
      );
    }
  });

  it('ride, dégarnit et barbe un adulte aux âges de son espèce, pas à ceux des humains', () => {
    // Une espèce dont les adultes n'ont jamais ni barbe, ni calvitie, ni rides : à 70 ans,
    // leur portrait est celui de leurs 30 ans. Celui d'un humain a changé.
    const smooth: LifeAges = {
      maturity: human.maturity,
      ages: {
        ...human.ages,
        elder: 90,
        beard: 999,
        bald: 999,
        wrinkles: { forehead: 999, eyes: 999, mouth: 999, deep: 999 },
      },
    };
    for (const sex of [0, 1]) {
      for (const variant of [0, 8, 9, 48, 56, 0x2c5f3e91]) {
        const person = { ...adult, sex, variant };
        const where = `sexe ${String(sex)}, variante ${String(variant)}`;
        expect(Array.from(aged(person, 70)), where).not.toEqual(Array.from(aged(person, 30)));
        const other = { ...person, species: smooth };
        expect(Array.from(aged(other, 70)), where).toEqual(Array.from(aged(other, 30)));
      }
    }
    // Chaque âge compte, à l'année près : à 70 ans, un homme qui porte barbe et calvitie
    // (variante 56) les montre, ou ses rides, si son espèce les lui donne à 70 ans, et non
    // si elle les lui donne à 71.
    const man = { ...adult, sex: 1, variant: 56 };
    const never = smooth.ages.wrinkles;
    const at = (ages: Partial<LifeAges['ages']>) =>
      Array.from(aged({ ...man, species: { ...smooth, ages: { ...smooth.ages, ...ages } } }, 70));
    const thresholds: ((age: number) => Partial<LifeAges['ages']>)[] = [
      (age) => ({ wrinkles: { ...never, forehead: age } }),
      (age) => ({ wrinkles: { ...never, eyes: age } }),
      (age) => ({ wrinkles: { ...never, mouth: age } }),
      (age) => ({ wrinkles: { ...never, forehead: 20, deep: age } }),
      (age) => ({ bald: age }),
      (age) => ({ beard: age }),
    ];
    for (const threshold of thresholds) {
      const where = JSON.stringify(threshold(70));
      expect(at(threshold(70)), where).not.toEqual(at(threshold(71)));
    }
  });
});
