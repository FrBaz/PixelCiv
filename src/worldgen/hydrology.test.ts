import { describe, expect, it } from 'vitest';
import { loadGameData } from '../core/data';
import { Fingerprint } from '../core/hash';
import { Rng } from '../core/rng';
import { WORLD_SIZES, type WorldSize } from '../core/world';
import { generateClimate } from './climate';
import { DIRECTIONS, neighborTable } from './grid';
import {
  findOcean,
  generateHydrology,
  LAKE,
  NO_DIRECTION,
  RIVER,
  type Hydrology,
} from './hydrology';
import { generateRelief } from './relief';
import { CylinderSampler } from './sampler';

const { worldgen } = loadGameData();
const SIZE = WORLD_SIZES.small;

interface World {
  readonly size: WorldSize;
  readonly elevation: Float32Array;
  readonly hydrology: Hydrology;
}

function world(seed: string, rivers = 1): World {
  const sampler = new CylinderSampler(SIZE);
  const rng = new Rng(seed);
  const elevation = generateRelief(sampler, rng, { landShare: 0.35, seaLevel: 0, relief: 0.5 });
  const ocean = findOcean(elevation, SIZE, worldgen.ocean.minShare);
  const climate = generateClimate(sampler, rng, elevation, ocean, worldgen.climate, {
    temperature: 0,
    humidity: 1,
  });
  const hydrology = generateHydrology(
    SIZE,
    elevation,
    ocean,
    climate.temperature,
    climate.precipitation,
    rng.stream('worldgen.hydrology'),
    worldgen.hydrology,
    { rivers },
  );
  return { size: SIZE, elevation, hydrology };
}

/**
 * Hydrologie d'un monde de synthèse : `land` donne l'altitude de chaque case (la mer
 * ailleurs), `climate` sa température et ses pluies.
 */
function synthetic(
  size: WorldSize,
  land: (x: number, y: number) => number | undefined,
  climate: { temperature: number; precipitation: number },
): World {
  const { width, height } = size;
  const count = width * height;
  const elevation = new Float32Array(count).fill(-2000);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const altitude = land(x, y);
      if (altitude !== undefined) elevation[y * width + x] = altitude;
    }
  }
  const ocean = findOcean(elevation, size, worldgen.ocean.minShare);
  const hydrology = generateHydrology(
    size,
    elevation,
    ocean,
    new Float32Array(count).fill(climate.temperature),
    new Float32Array(count).fill(climate.precipitation),
    new Rng('synthèse').stream('worldgen.hydrology'),
    worldgen.hydrology,
    { rivers: 1 },
  );
  return { size, elevation, hydrology };
}

describe('hydrologie', () => {
  const worlds = ['pixelciv', 'alpha', 'beta', 'gamma'].map((seed) => world(seed));

  it('est déterministe', () => {
    const fingerprint = ({ hydrology }: World) =>
      new Fingerprint()
        .typedArray(hydrology.receiver)
        .typedArray(hydrology.lake)
        .typedArray(hydrology.river)
        .typedArray(hydrology.flow)
        .hex();
    expect(fingerprint(world('pixelciv'))).toBe(fingerprint(world('pixelciv')));
    expect(fingerprint(world('alpha'))).not.toBe(fingerprint(world('pixelciv')));
  });

  it("ne compte comme mer que l'eau reliée à l'océan mondial (D1)", () => {
    const size = { width: 256, height: 128 };
    // Un continent percé d'une mer fermée de 10 × 10 cases (0,3 % de la carte, sous le seuil
    // de D1), sous le niveau de la mer.
    const closed = synthetic(
      size,
      (x, y) => {
        if (!(x >= 60 && x < 200 && y >= 20 && y < 108)) return undefined;
        return x >= 125 && x < 135 && y >= 59 && y < 69 ? -300 : 200;
      },
      { temperature: 15, precipitation: 800 },
    );
    const at = (x: number, y: number) => y * size.width + x;
    expect(closed.hydrology.ocean[at(10, 10)]).toBe(1);
    expect(closed.hydrology.ocean[at(130, 64)]).toBe(0);
    // Ce bassin fermé relève des lacs (D2) : selon son bilan, lac ou salar, qui en couvre
    // au moins le fond.
    let lakes = 0;
    for (let y = 59; y < 69; y++) {
      for (let x = 125; x < 135; x++) if (closed.hydrology.lake[at(x, y)] !== LAKE.none) lakes++;
    }
    expect(lakes).toBeGreaterThan(0);
  });

  it('draine chaque case vers la mer ou un lac, sans boucle, couture comprise', () => {
    for (const { size, hydrology } of worlds) {
      const count = size.width * size.height;
      // 0 : inconnu, 1 : en cours de parcours, 2 : mène à la mer ou à un lac.
      const state = new Uint8Array(count);
      const path: number[] = [];
      let failures = 0;
      for (let start = 0; start < count; start++) {
        let cell = start;
        while (state[cell] === 0) {
          if (hydrology.ocean[cell] || hydrology.lake[cell] !== LAKE.none) break;
          state[cell] = 1;
          path.push(cell);
          const next = hydrology.receiver[cell] ?? -1;
          if (next < 0) break;
          cell = next;
        }
        // Une case déjà en cours de parcours trahirait une boucle ; une case sans aval
        // hors de la mer et des lacs, une eau qui ne mène nulle part.
        const ends =
          state[cell] === 2 || hydrology.ocean[cell] === 1 || hydrology.lake[cell] !== LAKE.none;
        if (!ends) failures++;
        for (const visited of path) state[visited] = 2;
        path.length = 0;
      }
      expect(failures).toBe(0);
    }
  });

  it('mène toute rivière à la mer ou à un lac, sans interruption (D3)', () => {
    for (const { size, hydrology } of worlds) {
      const count = size.width * size.height;
      for (let start = 0; start < count; start++) {
        if (hydrology.river[start] === RIVER.none) continue;
        let cell = start;
        for (;;) {
          if (hydrology.ocean[cell] || hydrology.lake[cell] !== LAKE.none) break;
          // Tant qu'elle n'a pas atteint la mer ou un lac, la rivière reste une rivière.
          expect(hydrology.river[cell]).not.toBe(RIVER.none);
          cell = hydrology.receiver[cell] ?? -1;
          expect(cell).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('code la direction de chaque case vers sa case aval', () => {
    const { size, hydrology } = worlds[0] ?? world('pixelciv');
    const neighbors = neighborTable(size);
    for (let index = 0; index < size.width * size.height; index++) {
      const direction = hydrology.direction[index] ?? NO_DIRECTION;
      const receiver = hydrology.receiver[index] ?? -1;
      if (receiver < 0) expect(direction).toBe(NO_DIRECTION);
      else expect(neighbors[index * 8 + direction]).toBe(receiver);
    }
    expect(DIRECTIONS).toHaveLength(8);
  });

  it('range les rivières en trois classes selon leur débit (D3)', () => {
    const [riverFrom, majorFrom] = worldgen.hydrology.riverClasses;
    expect([riverFrom, majorFrom]).toEqual([4, 16]);
    for (const rivers of [1, 2]) {
      const { size, hydrology } = world('alpha', rivers);
      const threshold = worldgen.hydrology.riverThreshold / rivers;
      const classes = [0, 0, 0, 0];
      for (let index = 0; index < size.width * size.height; index++) {
        const river = hydrology.river[index] ?? 0;
        const flow = hydrology.flow[index] ?? 0;
        classes[river] = (classes[river] ?? 0) + 1;
        if (river === RIVER.stream) expect(flow).toBeLessThan(riverFrom * threshold);
        if (river === RIVER.river) {
          expect(flow).toBeGreaterThanOrEqual(riverFrom * threshold);
          expect(flow).toBeLessThan(majorFrom * threshold);
        }
        if (river === RIVER.major) expect(flow).toBeGreaterThanOrEqual(majorFrom * threshold);
        if (river !== RIVER.none) expect(flow).toBeGreaterThanOrEqual(threshold);
      }
      // Chaque classe existe, et la densité du réseau suit le paramètre « rivières ».
      expect(classes.slice(1).every((value) => value > 0)).toBe(true);
    }
    const sparse = world('alpha', 0.5).hydrology.river.filter((river) => river !== 0).length;
    const dense = world('alpha', 2).hydrology.river.filter((river) => river !== 0).length;
    expect(dense).toBeGreaterThan(sparse * 2);
  });

  it('ne trace aucune rivière rectiligne', () => {
    for (const { size, hydrology } of worlds) {
      let longest = 0;
      // Les trois lignes du bord polaire, sans voisins au-delà, sont laissées de côté : une
      // calotte glaciaire les couvre, où l'étape des biomes efface les rivières.
      const polar = 3 * size.width;
      for (let start = polar; start < size.width * size.height - polar; start++) {
        if (hydrology.river[start] === RIVER.none) continue;
        const direction = hydrology.direction[start];
        let run = 1;
        let cell = hydrology.receiver[start] ?? -1;
        while (
          cell >= 0 &&
          hydrology.river[cell] !== RIVER.none &&
          hydrology.direction[cell] === direction
        ) {
          run++;
          cell = hydrology.receiver[cell] ?? -1;
        }
        longest = Math.max(longest, run);
      }
      // Sur une carte Petit, une case couvre près de 80 km : douze cases font 950 km.
      expect(longest).toBeLessThanOrEqual(12);
    }
  });

  it('forme des lacs par bilan hydrique : eau douce, lac salé ou salar (D2)', () => {
    const size = { width: 256, height: 128 };
    // Une cuvette de 29 × 29 cases, profonde de 490 m, au cœur d'un plateau qui descend
    // vers la mer ; elle déborde vers le sud par un col à 590 m.
    const basin = (x: number, y: number) => {
      if (!(x >= 40 && x < 216 && y >= 14 && y < 114)) return undefined;
      const r = Math.max(Math.abs(x - 128), Math.abs(y - 64));
      if (r < 15) return 100 + 30 * r;
      if (x === 128 && y > 64) return 590 - 2 * (r - 15);
      return 700 - 4 * (r - 15);
    };
    const at = 64 * size.width + 128;
    // Apport et évaporation du bassin : ruissellement contre évaporation d'un lac.
    const wet = synthetic(size, basin, { temperature: 10, precipitation: 3000 });
    const dry = synthetic(size, basin, { temperature: 25, precipitation: 1500 });
    const desert = synthetic(size, basin, { temperature: 30, precipitation: 60 });
    expect(wet.hydrology.lake[at]).toBe(LAKE.fresh);
    expect(dry.hydrology.lake[at]).toBe(LAKE.salt);
    expect(desert.hydrology.lake[at]).toBe(LAKE.saltFlat);
    const lakeCells = (world: World, kind: number) =>
      world.hydrology.lake.filter((lake) => lake === kind).length;
    // Le lac salé ne remplit que le fond du bassin, que le lac d'eau douce remplit tout entier.
    expect(lakeCells(dry, LAKE.salt)).toBeLessThan(lakeCells(wet, LAKE.fresh));
    // Le lac d'eau douce s'écoule par son exutoire ; le lac salé garde son eau.
    const outlet = (world: World) => {
      let largest = 0;
      world.hydrology.flow.forEach((flow, index) => {
        if (world.hydrology.lake[index] === LAKE.none && !world.hydrology.ocean[index]) {
          largest = Math.max(largest, flow);
        }
      });
      return largest;
    };
    expect(outlet(wet)).toBeGreaterThan(0);
    // La surface d'un lac d'eau douce est son niveau de débordement, au-dessus de son fond.
    const surface = wet.hydrology.lakeSurface[at];
    expect(surface).toBeGreaterThan(wet.hydrology.elevation[at] ?? 0);
    expect(Number.isNaN(dry.hydrology.lakeSurface[0])).toBe(true);
  });

  it('draine les petites cuvettes, qui accueilleront des zones humides (D2, D5)', () => {
    const size = { width: 256, height: 128 };
    // Une cuvette de 3 × 3 cases, profonde de 30 m : trop petite pour un lac.
    const small = synthetic(
      size,
      (x, y) => {
        if (!(x >= 40 && x < 216 && y >= 14 && y < 114)) return undefined;
        return Math.abs(x - 128) <= 1 && Math.abs(y - 64) <= 1 ? 170 : 200 + Math.abs(x - 128);
      },
      { temperature: 10, precipitation: 1500 },
    );
    const at = 64 * size.width + 128;
    expect(small.hydrology.lake[at]).toBe(LAKE.none);
    expect(small.hydrology.smallDepression[at]).toBe(1);
  });

  it('laisse aux lacs une part raisonnable des terres', () => {
    for (const { size, hydrology } of worlds) {
      let land = 0;
      let lakes = 0;
      for (let index = 0; index < size.width * size.height; index++) {
        if (hydrology.ocean[index]) continue;
        land++;
        if (hydrology.lake[index] === LAKE.fresh || hydrology.lake[index] === LAKE.salt) lakes++;
      }
      expect(lakes / land).toBeGreaterThan(0.005);
      expect(lakes / land).toBeLessThan(0.1);
    }
  });

  it('fait couler les rivières à travers la couture', () => {
    const size = { width: 256, height: 128 };
    // Un continent à cheval sur la couture, qui penche vers l'est : ses rivières la passent.
    const tilted = synthetic(
      size,
      (x, y) => {
        const shifted = (x + 64) % size.width;
        if (!(shifted < 160 && y >= 20 && y < 108)) return undefined;
        return 1200 - 7 * shifted + 30 * Math.sin(y * 0.9) + 20 * Math.cos(x * 1.3);
      },
      { temperature: 12, precipitation: 1200 },
    );
    const { width } = size;
    let crossings = 0;
    for (let y = 0; y < size.height; y++) {
      const last = y * width + width - 1;
      if (
        tilted.hydrology.river[last] !== RIVER.none &&
        tilted.hydrology.receiver[last] === y * width + 0
      ) {
        crossings++;
      }
      const first = y * width;
      if (
        tilted.hydrology.river[first] !== RIVER.none &&
        tilted.hydrology.receiver[first] === last
      ) {
        crossings++;
      }
    }
    expect(crossings).toBeGreaterThan(0);
    // Toutes les rivières atteignent la mer : aucune ne s'arrête à la couture.
    for (let start = 0; start < width * size.height; start++) {
      if (tilted.hydrology.river[start] === RIVER.none) continue;
      let cell = start;
      while (!tilted.hydrology.ocean[cell] && tilted.hydrology.lake[cell] === LAKE.none) {
        expect(tilted.hydrology.river[cell]).not.toBe(RIVER.none);
        cell = tilted.hydrology.receiver[cell] ?? -1;
      }
    }
  });
});
