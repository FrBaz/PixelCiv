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
  });

  it('sin près de ses zéros', () => {
    for (let k = -30; k <= 30; k++) {
      expect(Math.abs(sin(k * Math.PI) - Math.sin(k * Math.PI))).toBeLessThan(1e-29);
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

  it('pow, à 1e-13 près en relatif', () => {
    const random = new Rng('dmath').stream('pow');
    for (let i = 0; i < 20_000; i++) {
      const x = random.nextFloat() * 100;
      const y = (random.nextFloat() - 0.5) * 20;
      const expected = Math.pow(x, y);
      expect(Math.abs(pow(x, y) - expected)).toBeLessThanOrEqual(1e-13 * expected);
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
  });
});
