import { describe, expect, it } from 'vitest';
import { altitudeLevelIndex } from '../core/altitude';
import { loadGameData } from '../core/data';
import { Fingerprint } from '../core/hash';
import { Rng } from '../core/rng';
import { WORLD_SIZES } from '../core/world';
import { components } from './grid';
import {
  generateRelief,
  mountainShare,
  reliefFields,
  reliefSettings,
  seaThreshold,
  toElevation,
  type ReliefParams,
} from './relief';
import { CylinderSampler } from './sampler';

const data = loadGameData();
const SETTINGS = reliefSettings(data.worldgen, data.altitudeLevels.entries);
const DEFAULTS: ReliefParams = { landShare: 0.35, seaLevel: 0, relief: 0.5 };
const SIZE = WORLD_SIZES.small;

/** Bas d'un niveau d'altitude de data/altitude-levels.json, en mètres. */
function levelFloor(id: string): number {
  return data.altitudeLevels.entries.find((level) => level.id === id)?.min ?? Number.NaN;
}
const MID_MOUNTAIN = levelFloor('mid-mountain');
const HIGH_MOUNTAIN = levelFloor('high-mountain');
const SUMMIT = levelFloor('summit');

function relief(seed: string, params: Partial<ReliefParams> = {}): Float32Array {
  return generateRelief(
    new CylinderSampler(SIZE),
    new Rng(seed),
    { ...DEFAULTS, ...params },
    SETTINGS,
  );
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

/** Plus grande étendue, en colonnes ou en lignes, des taches d'au moins `meters`. */
function longestExtent(elevation: Float32Array, meters: number): number {
  const found = components(
    elevation.map((value) => (value >= meters ? 1 : 0)),
    SIZE,
  );
  const columns = found.sizes.map(() => new Set<number>());
  const rows = found.sizes.map(() => new Set<number>());
  found.labels.forEach((label, index) => {
    if (label === 0) return;
    columns[label]?.add(index % SIZE.width);
    rows[label]?.add(Math.floor(index / SIZE.width));
  });
  return Math.max(
    0,
    ...found.sizes.slice(1).map((_, label) => {
      return Math.max(columns[label + 1]?.size ?? 0, rows[label + 1]?.size ?? 0);
    }),
  );
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
    expect(MID_MOUNTAIN).toBe(1800);
    for (const elevation of worlds.values()) {
      const above = landAbove(elevation, MID_MOUNTAIN);
      expect(above).toBeGreaterThanOrEqual(0.03);
      expect(above).toBeLessThanOrEqual(0.06);
    }
  });

  it('suit le paramètre « relief », de plat à montagneux', () => {
    const flat = landAbove(relief('pixelciv', { relief: 0 }), MID_MOUNTAIN);
    const steep = landAbove(relief('pixelciv', { relief: 1 }), MID_MOUNTAIN);
    expect(flat).toBeCloseTo(mountainShare(SETTINGS, 0), 2);
    expect(steep).toBeCloseTo(mountainShare(SETTINGS, 1), 2);
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
      expect(highest).toBeLessThanOrEqual(SETTINGS.maxAltitude);
      expect(highest).toBeGreaterThan(HIGH_MOUNTAIN);
      expect(deepest).toBeGreaterThanOrEqual(-SETTINGS.maxDepth);
      expect(ambiguous).toBe(0);
    }
  });

  it('dresse des chaînes continues, entrecoupées de cols', () => {
    const { width } = SIZE;
    for (const elevation of worlds.values()) {
      // Les chaînes : cases de basse montagne ou plus, reliées entre elles ; leurs massifs :
      // les cases au-dessus de la moyenne montagne.
      const chains = components(
        elevation.map((meters) => (meters >= 1000 ? 1 : 0)),
        SIZE,
      );
      const peaks = components(
        elevation.map((meters) => (meters >= MID_MOUNTAIN ? 1 : 0)),
        SIZE,
      );
      const columns = chains.sizes.map(() => new Set<number>());
      const rows = chains.sizes.map(() => new Set<number>());
      const massifs = chains.sizes.map(() => new Set<number>());
      chains.labels.forEach((label, index) => {
        if (label === 0) return;
        columns[label]?.add(index % width);
        rows[label]?.add(Math.floor(index / width));
        const peak = peaks.labels[index] ?? 0;
        if (peak !== 0 && (peaks.sizes[peak] ?? 0) >= 4) massifs[label]?.add(peak);
      });
      const extent = (label: number) => Math.max(columns[label]?.size ?? 0, rows[label]?.size ?? 0);
      const labels = chains.sizes.map((_, label) => label).slice(1);
      // Des chaînes longues de dizaines de cases…
      expect(Math.max(...labels.map(extent))).toBeGreaterThanOrEqual(40);
      // … dont l'une au moins porte plusieurs massifs : des cols les séparent.
      const separated = labels.filter(
        (label) => extent(label) >= 30 && (massifs[label]?.size ?? 0) >= 2,
      );
      expect(separated.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('dresse ses crêtes sur les chaînes, et les entaille de cols (D12)', () => {
    for (const seed of seeds) {
      const fields = reliefFields(new CylinderSampler(SIZE), new Rng(seed), DEFAULTS.relief);
      const sea = seaThreshold(fields.height, DEFAULTS);
      const elevation = toElevation(fields.height, sea, DEFAULTS.relief, SETTINGS);
      // Altitude moyenne des terres hors des chaînes, des crêtes intactes, et des cols.
      const groups = { plain: [0, 0], crest: [0, 0], pass: [0, 0] };
      let land = 0;
      for (let cell = 0; cell < elevation.length; cell++) {
        const meters = elevation[cell] ?? 0;
        if (meters < 0) continue;
        land++;
        const crest = fields.crest[cell] ?? 0;
        const pass = fields.pass[cell] ?? 1;
        const group =
          crest === 0
            ? groups.plain
            : crest < 0.5
              ? undefined
              : pass === 1
                ? groups.crest
                : pass <= 0.3
                  ? groups.pass
                  : undefined;
        if (group === undefined) continue;
        group[0] = (group[0] ?? 0) + meters;
        group[1] = (group[1] ?? 0) + 1;
      }
      const mean = ([sum = 0, count = 0]: number[]) => sum / count;
      const crests = groups.crest[1] ?? 0;
      const passes = groups.pass[1] ?? 0;
      // Des crêtes sur une part des terres, bien plus hautes que les plaines alentour…
      expect(crests + passes).toBeGreaterThan(0.002 * land);
      expect(mean(groups.crest)).toBeGreaterThan(2.5 * mean(groups.plain));
      // … et des cols de place en place, où la crête retombe.
      expect(passes / (crests + passes)).toBeGreaterThan(0.05);
      expect(passes / (crests + passes)).toBeLessThan(0.4);
      expect(mean(groups.pass)).toBeLessThan(0.4 * mean(groups.crest));
    }
  });

  it("n'élève pas de murailles : les cols coupent les sommets, même au relief le plus fort", () => {
    // Le sommet est infranchissable aux armées (D11) : ses taches restent courtes.
    for (const seed of seeds) {
      expect(longestExtent(relief(seed, { relief: 1 }), SUMMIT)).toBeLessThanOrEqual(45);
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
