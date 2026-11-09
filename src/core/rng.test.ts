import { describe, expect, it } from 'vitest';
import { RandomStream, Rng, splitmix32, streamSeed } from './rng';

// Les valeurs de référence viennent d'une implémentation indépendante, en Python ; celles
// de xoshiro128** pour l'état [1, 2, 3, 4] sont aussi celles de l'implémentation de
// référence en C de ses auteurs.
describe('xoshiro128**', () => {
  it('suit la suite de référence', () => {
    const stream = new RandomStream([1, 2, 3, 4]);
    expect(Array.from({ length: 6 }, () => stream.nextUint32())).toEqual([
      11520, 0, 5927040, 70819200, 2031721883, 1637235492,
    ]);
  });

  it('suit splitmix32', () => {
    const next = splitmix32(0);
    expect([next(), next(), next()]).toEqual([2462723854, 1020716019, 454327756]);
  });
});

describe('flux nommés', () => {
  it('dérivent de la graine et du nom', () => {
    expect(streamSeed('pixelciv', 'test')).toEqual([
      4223895104, 1930739204, 3115440649, 2438938805,
    ]);
    const stream = new Rng('pixelciv').stream('test');
    expect(Array.from({ length: 5 }, () => stream.nextUint32())).toEqual([
      1387485975, 2330183891, 1110477297, 3425203909, 1047342338,
    ]);
  });

  it("ne dépendent pas de l'ordre de création", () => {
    const first = new Rng('graine');
    const a1 = first.stream('a').nextUint32();
    const b1 = first.stream('b').nextUint32();
    const second = new Rng('graine');
    const b2 = second.stream('b').nextUint32();
    const a2 = second.stream('a').nextUint32();
    expect([a1, b1]).toEqual([a2, b2]);
    expect(a1).not.toBe(b1);
  });

  it("reprennent à l'identique depuis leur état", () => {
    const rng = new Rng('graine');
    for (let i = 0; i < 10; i++) rng.stream('pluie').nextUint32();
    const restored = new Rng('graine', rng.states());
    const expected = Array.from({ length: 5 }, () => rng.stream('pluie').nextUint32());
    expect(Array.from({ length: 5 }, () => restored.stream('pluie').nextUint32())).toEqual(
      expected,
    );
  });
});

describe('tirages', () => {
  const stream = () => new Rng('tirages').stream('test');

  it('restent dans leurs bornes', () => {
    const random = stream();
    for (let i = 0; i < 10_000; i++) {
      const float = random.nextFloat();
      expect(float >= 0 && float < 1).toBe(true);
      const value = random.nextRange(-3, 4);
      expect(value >= -3 && value < 4 && Number.isInteger(value)).toBe(true);
    }
  });

  it('sont à peu près uniformes', () => {
    const random = stream();
    const counts = new Array<number>(6).fill(0);
    const draws = 60_000;
    for (let i = 0; i < draws; i++) {
      const face = random.nextInt(6);
      counts[face] = (counts[face] ?? 0) + 1;
    }
    // Khi-deux à 5 degrés de liberté : 20,5 n'est dépassé qu'une fois sur mille.
    const expected = draws / 6;
    const chi2 = counts.reduce(
      (sum, count) => sum + ((count - expected) * (count - expected)) / expected,
      0,
    );
    expect(chi2).toBeLessThan(20.5);
  });

  it('refusent une borne invalide', () => {
    const random = stream();
    expect(() => random.nextInt(0)).toThrow(RangeError);
    expect(() => random.nextInt(1.5)).toThrow(RangeError);
    expect(() => random.nextInt(4294967297)).toThrow(RangeError);
    expect(random.nextInt(1)).toBe(0);
    expect(() => random.pick([])).toThrow(RangeError);
  });

  it('mélangent sans perdre ni dupliquer', () => {
    const items = Array.from({ length: 50 }, (_, index) => index);
    const shuffled = stream().shuffle([...items]);
    expect(shuffled).not.toEqual(items);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(items);
  });
});
