import { describe, expect, it } from 'vitest';
import { altitudeLevelIndex } from '../core/altitude';
import { loadGameData } from '../core/data';
import { Fingerprint } from '../core/hash';
import { Rng } from '../core/rng';
import { WORLD_SIZES } from '../core/world';
import { components } from './grid';
import { generateRelief, mountainShare, type ReliefParams } from './relief';
import { CylinderSampler } from './sampler';

const DEFAULTS: ReliefParams = { landShare: 0.35, seaLevel: 0, relief: 0.5 };
const SIZE = WORLD_SIZES.small;

function relief(seed: string, params: Partial<ReliefParams> = {}): Float32Array {
  return generateRelief(new CylinderSampler(SIZE), new Rng(seed), { ...DEFAULTS, ...params });
}

function share(elevation: Float32Array, test: (meters: number) => boolean): number {
  let count = 0;
  for (const meters of elevation) if (test(meters)) count++;
  return count / elevation.length;
}

/** Part des terres au-dessus de `meters`. */
function landAbove(elevation: Float32Array, meters: number): number {
  return share(elevation, (value) => value >= meters) / share(elevation, (value) => value >= 0);
}

describe('relief', () => {
  const seeds = ['pixelciv', 'alpha', 'beta', 'gamma'];
  const worlds = new Map(seeds.map((seed) => [seed, relief(seed)]));

  it('est déterministe : même graine, même relief', () => {
    const fingerprint = (elevation: Float32Array) => new Fingerprint().typedArray(elevation).hex();
    expect(fingerprint(relief('pixelciv'))).toBe(
      fingerprint(worlds.get('pixelciv') ?? new Float32Array()),
    );
    expect(fingerprint(worlds.get('alpha') ?? new Float32Array())).not.toBe(
      fingerprint(worlds.get('pixelciv') ?? new Float32Array()),
    );
  });

  it('émerge la part des terres demandée, que le niveau de la mer relève ou abaisse', () => {
    for (const elevation of worlds.values()) {
      expect(share(elevation, (meters) => meters >= 0)).toBeCloseTo(0.35, 2);
    }
    const land = (params: Partial<ReliefParams>) =>
      share(relief('pixelciv', params), (meters) => meters >= 0);
    expect(land({ landShare: 0.5 })).toBeCloseTo(0.5, 2);
    expect(land({ seaLevel: 1 })).toBeLessThan(0.3);
    expect(land({ seaLevel: -1 })).toBeGreaterThan(0.4);
  });

  it('place de 3 à 6 % des terres au-dessus de la moyenne montagne (C1, D12)', () => {
    for (const elevation of worlds.values()) {
      const above = landAbove(elevation, 1800);
      expect(above).toBeGreaterThanOrEqual(0.03);
      expect(above).toBeLessThanOrEqual(0.06);
    }
  });

  it('suit le paramètre « relief », de plat à montagneux', () => {
    const flat = landAbove(relief('pixelciv', { relief: 0 }), 1800);
    const steep = landAbove(relief('pixelciv', { relief: 1 }), 1800);
    expect(flat).toBeCloseTo(mountainShare(0), 2);
    expect(steep).toBeCloseTo(mountainShare(1), 2);
    expect(steep).toBeGreaterThan(flat * 5);
  });

  it("reste dans les bornes de D11 : jusqu'à 7 000 m, et 5 500 m de fond", () => {
    for (const elevation of worlds.values()) {
      let highest = Number.NEGATIVE_INFINITY;
      let deepest = Number.POSITIVE_INFINITY;
      let ambiguous = 0;
      for (const meters of elevation) {
        highest = Math.max(highest, meters);
        deepest = Math.min(deepest, meters);
        // Une case de mer a au moins un mètre de fond : altitude et mer ne se confondent pas.
        if (meters < 0 && meters > -1) ambiguous++;
      }
      expect(highest).toBeLessThanOrEqual(7000);
      expect(highest).toBeGreaterThan(2600);
      expect(deepest).toBeGreaterThanOrEqual(-5500);
      expect(ambiguous).toBe(0);
    }
  });

  it('dresse des chaînes continues, entrecoupées de cols', () => {
    const { width } = SIZE;
    for (const elevation of worlds.values()) {
      // Les chaînes : cases de basse montagne ou plus, reliées entre elles.
      const chains = components(
        elevation.map((meters) => (meters >= 1000 ? 1 : 0)),
        SIZE,
      );
      const peaks = components(
        elevation.map((meters) => (meters >= 1800 ? 1 : 0)),
        SIZE,
      );
      // Étendue de la plus grande chaîne : des dizaines de cases.
      const largest = chains.sizes.indexOf(Math.max(...chains.sizes.slice(1)));
      const columns = new Set<number>();
      const rows = new Set<number>();
      const peaksInLargest = new Set<number>();
      chains.labels.forEach((label, index) => {
        if (label !== largest) return;
        columns.add(index % width);
        rows.add(Math.floor(index / width));
        const peak = peaks.labels[index] ?? 0;
        if (peak !== 0 && (peaks.sizes[peak] ?? 0) >= 4) peaksInLargest.add(peak);
      });
      expect(Math.max(columns.size, rows.size)).toBeGreaterThanOrEqual(40);
      // Plusieurs massifs au-dessus de 1 800 m sur une même chaîne : des cols les séparent.
      expect(peaksInLargest.size).toBeGreaterThanOrEqual(2);
    }
  });

  it('se referme sans couture : la couture est une paire de colonnes comme les autres', () => {
    const { width, height } = SIZE;
    for (const elevation of worlds.values()) {
      // Écart moyen entre les colonnes x et x + 1, la dernière paire passant la couture.
      const gaps = Array.from({ length: width }, (_, x) => {
        let sum = 0;
        for (let y = 0; y < height; y++) {
          const row = y * width;
          sum += Math.abs((elevation[row + ((x + 1) % width)] ?? 0) - (elevation[row + x] ?? 0));
        }
        return sum / height;
      });
      const seam = gaps[width - 1] ?? 0;
      const others = gaps.slice(0, width - 1);
      expect(seam).toBeGreaterThanOrEqual(Math.min(...others));
      expect(seam).toBeLessThanOrEqual(Math.max(...others));
    }
  });
});

describe("niveaux d'altitude (D11)", () => {
  const { altitudeLevels } = loadGameData();
  const levels = altitudeLevels.entries;

  it('comptent les 20 niveaux de C1, dont 5 profondeurs et 2 rivages', () => {
    expect(levels).toHaveLength(20);
    expect(levels.filter((level) => level.family === 'water')).toHaveLength(5);
    expect(levels.filter((level) => level.family === 'shore')).toHaveLength(2);
    expect(levels.filter((level) => level.family === 'plain')).toHaveLength(5);
    expect(levels.filter((level) => level.family === 'hill')).toHaveLength(3);
    expect(levels.filter((level) => level.family === 'low-mountain')).toHaveLength(2);
  });

  it("retrouvent le niveau d'une altitude, bornes inférieures comprises", () => {
    const id = (meters: number) => levels[altitudeLevelIndex(levels, meters)]?.id;
    expect(id(-6000)).toBe('abyss');
    expect(id(-4000)).toBe('ocean');
    expect(id(-1)).toBe('foreshore');
    expect(id(0)).toBe('backshore');
    expect(id(5)).toBe('plain-one');
    expect(id(399)).toBe('plain-five');
    expect(id(1800)).toBe('mid-mountain');
    expect(id(3799)).toBe('high-mountain');
    expect(id(3800)).toBe('summit');
    expect(id(7000)).toBe('summit');
  });
});
