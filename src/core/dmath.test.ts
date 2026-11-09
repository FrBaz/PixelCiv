import { describe, expect, it } from 'vitest';
import { cos, exp, log, pow, sin } from './dmath';
import { Rng } from './rng';

/** Écart en ulp entre deux doubles de même signe ou nuls. */
function ulps(a: number, b: number): number {
  if (Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b))) return 0;
  const view = new DataView(new ArrayBuffer(16));
  view.setFloat64(0, a);
  view.setFloat64(8, b);
  const order = (offset: number) => {
    const bits = view.getBigInt64(offset);
    return bits < 0n ? -(bits & 0x7fffffffffffffffn) : bits;
  };
  const distance = order(0) - order(8);
  return Number(distance < 0n ? -distance : distance);
}

/** Plus grand écart en ulp avec la fonction du moteur, sur des points tirés au sort. */
function worst(
  ours: (...args: number[]) => number,
  engine: (...args: number[]) => number,
  draw: (random: ReturnType<Rng['stream']>) => number[],
): number {
  const random = new Rng('dmath').stream(ours.name);
  let max = 0;
  for (let i = 0; i < 20_000; i++) {
    const args = draw(random);
    max = Math.max(max, ulps(ours(...args), engine(...args)));
  }
  return max;
}

// Les fonctions du moteur sont elles-mêmes approchées, à 1 ulp près en général : les
// seuils ci-dessous cumulent les deux erreurs.
describe('précision', () => {
  it('sin et cos, à 3 ulp près', () => {
    expect(worst(sin, Math.sin, (r) => [(r.nextFloat() - 0.5) * 200])).toBeLessThanOrEqual(3);
    expect(worst(cos, Math.cos, (r) => [(r.nextFloat() - 0.5) * 200])).toBeLessThanOrEqual(3);
    expect(worst(sin, Math.sin, (r) => [(r.nextFloat() - 0.5) * 2e5])).toBeLessThanOrEqual(3);
    // Jusqu'à la limite de la réduction exacte, 2^20 × π/2.
    expect(worst(cos, Math.cos, (r) => [(r.nextFloat() - 0.5) * 3.2e6])).toBeLessThanOrEqual(3);
  });

  it('sin et cos, à 3 ulp près de leurs zéros', () => {
    // Près d'un zéro, le résultat est minuscule : seule une réduction complète, reste de
    // π/2 compris, le garde exact à l'ulp.
    let max = 0;
    for (let k = -100_000; k <= 100_000; k += 97) {
      max = Math.max(max, ulps(sin(k * Math.PI), Math.sin(k * Math.PI)));
      const half = (k + 0.5) * Math.PI;
      max = Math.max(max, ulps(cos(half), Math.cos(half)));
    }
    expect(max).toBeLessThanOrEqual(3);
  });

  it('restent dans [-1, 1] au-delà du domaine précis', () => {
    for (const x of [1e7, 1e18, 1e100, 1e300, Number.MAX_VALUE, -1e300]) {
      for (const value of [sin(x), cos(x)]) {
        expect(Math.abs(value), String(x)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('exp, à 2 ulp près, sous-normaux compris', () => {
    expect(worst(exp, Math.exp, (r) => [(r.nextFloat() - 0.5) * 1400])).toBeLessThanOrEqual(2);
    expect(worst(exp, Math.exp, (r) => [-708 - r.nextFloat() * 37])).toBeLessThanOrEqual(2);
  });

  it('log, à 3 ulp près, sous-normaux compris', () => {
    const logUniform = (r: ReturnType<Rng['stream']>) => [exp((r.nextFloat() - 0.5) * 1380)];
    expect(worst(log, Math.log, logUniform)).toBeLessThanOrEqual(3);
    expect(worst(log, Math.log, (r) => [0.5 + r.nextFloat() * 1.5])).toBeLessThanOrEqual(3);
    expect(worst(log, Math.log, (r) => [r.nextFloat() * 2.2e-308])).toBeLessThanOrEqual(3);
  });

  it('pow, à 1e-14 près en relatif pour un résultat modéré', () => {
    const random = new Rng('dmath').stream('pow');
    for (let i = 0; i < 20_000; i++) {
      const x = random.nextFloat() * 100;
      const y = (random.nextFloat() - 0.5) * 20;
      const expected = Math.pow(x, y);
      expect(Math.abs(pow(x, y) - expected)).toBeLessThanOrEqual(1e-14 * expected);
    }
  });

  it('pow, à 3e-13 près en relatif près des débordements', () => {
    const random = new Rng('dmath').stream('pow.grand');
    for (let i = 0; i < 20_000; i++) {
      const x = 1 + random.nextFloat() * 99;
      const y = (random.nextFloat() * 709) / Math.log(x);
      const expected = Math.pow(x, y);
      if (!Number.isFinite(expected)) continue;
      expect(Math.abs(pow(x, y) - expected)).toBeLessThanOrEqual(3e-13 * expected);
    }
  });
});

describe('valeurs particulières', () => {
  it('suivent celles de Math', () => {
    const cases: [(x: number) => number, (x: number) => number, number[]][] = [
      [sin, Math.sin, [0, -0, NaN, Infinity, -Infinity]],
      [cos, Math.cos, [0, -0, NaN, Infinity]],
      [exp, Math.exp, [0, -0, NaN, Infinity, -Infinity, 710, 1000, -746, -1000]],
      [log, Math.log, [0, -0, 1, -1, NaN, Infinity, -Infinity, 5e-324]],
    ];
    for (const [ours, engine, inputs] of cases) {
      for (const input of inputs) {
        expect(ours(input), `${ours.name}(${Object.is(input, -0) ? '-0' : input})`).toBe(
          engine(input),
        );
      }
    }
  });

  it('suivent la norme ECMAScript pour pow', () => {
    const bases = [NaN, -Infinity, -3, -2, -1, -0.5, -0, 0, 0.5, 1, 2, 3, Infinity];
    const exponents = [NaN, -Infinity, -3, -2, -0.5, -0, 0, 0.5, 1, 2, 3, Infinity];
    for (const x of bases) {
      for (const y of exponents) {
        const expected = Math.pow(x, y);
        const actual = pow(x, y);
        if (Number.isFinite(expected) && expected !== 0) {
          expect(Math.abs(actual - expected), `pow(${x}, ${y})`).toBeLessThanOrEqual(
            1e-15 * Math.abs(expected),
          );
        } else {
          expect(actual, `pow(${x}, ${y})`).toBe(expected);
        }
      }
    }
  });

  it('garde un résultat représentable malgré un débordement intermédiaire', () => {
    expect(pow(10, -320)).toBeGreaterThan(0);
    expect(Math.abs(pow(10, -320) - 1e-320)).toBeLessThanOrEqual(5e-324);
    expect(pow(0.3, 600)).toBe(Math.pow(0.3, 600));
  });

  it('rend exactes les petites puissances entières et les puissances de deux', () => {
    expect(pow(10, 15)).toBe(1e15);
    expect(pow(3, 20)).toBe(3486784401);
    expect(pow(-3, 3)).toBe(-27);
    expect(pow(0.5, -3)).toBe(8);
    expect(pow(2, -1074)).toBe(5e-324);
    expect(pow(0.5, 1074)).toBe(5e-324);
    expect(pow(2, -1075)).toBe(0);
    expect(pow(5e-324, 1)).toBe(5e-324);
    expect(pow(5e-324, -1)).toBe(Infinity);
    // Un exposant démesuré ne fait pas boucler le calcul.
    expect(pow(2, 1e300)).toBe(Infinity);
    expect(pow(2, -1e300)).toBe(0);
  });

  it('rend x pour pow(x, 1), et le produit arrondi pour pow(x, 2), sous-normaux compris', () => {
    const random = new Rng('dmath').stream('pow.entier');
    for (let i = 0; i < 20_000; i++) {
      // De 1e-320 à 1e300 : nombres normaux et sous-normaux.
      const x = exp((random.nextFloat() - 0.5) * 1380 - 45);
      expect(pow(x, 1)).toBe(x);
      expect(pow(x, 2)).toBe(x * x);
    }
    expect(pow(1e-154, 2)).toBe(1e-154 * 1e-154);
  });

  it('garde les puissances entières précises, petites ou grandes', () => {
    const random = new Rng('dmath').stream('pow.produits');
    for (let i = 0; i < 20_000; i++) {
      const n = 2 + Math.floor(random.nextFloat() * 1022);
      // Bases telles que le résultat reste entre 10^-30 et 10^30.
      const x = exp(((random.nextFloat() - 0.5) * 138) / n);
      const expected = Math.pow(x, n);
      // Produits jusqu'à n = 64 (5e-15 mesuré), exp(n ln x) au-delà (2,5e-14 mesuré).
      expect(Math.abs(pow(x, n) - expected), `pow(${x}, ${n})`).toBeLessThanOrEqual(
        (n <= 64 ? 1e-14 : 3e-14) * expected,
      );
    }
    const big = Math.pow(1.0086887393737078, 1023);
    expect(Math.abs(pow(1.0086887393737078, 1023) - big)).toBeLessThanOrEqual(1e-14 * big);
  });

  it("déborde vers l'infini quand le vrai résultat dépasse le plus grand double", () => {
    expect(pow(2, 1024)).toBe(Infinity);
    expect(pow(4, 512)).toBe(Infinity);
    expect(pow(16, 256)).toBe(Infinity);
    expect(pow(0.5, -1024)).toBe(Infinity);
    expect(pow(-2, 1025)).toBe(-Infinity);
    expect(pow(2, 1023)).toBe(2 ** 1023);
  });
});
