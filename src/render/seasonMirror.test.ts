import { describe, expect, it } from 'vitest';
import { loadGameData } from '../core/data';
import { SEASON_STATES } from '../core/data/schemas';
import { FOLIAGE_BYTES, foliageShares, leafThreshold, worldFoliage } from '../core/foliage';
import { Fingerprint } from '../core/hash';
import { seasonFactor } from '../core/seasons';
import { phaseDay } from '../core/snow';
import { DAYS_PER_MONTH } from '../core/time';
import { WORLD_SIZES } from '../core/world';
import { defaultWorldParams } from '../core/worldParams';
import { generateWorld } from '../worldgen/generate';
import {
  bakeBiomes,
  bakeChunk,
  CHUNK_PX,
  IDENTITY,
  parseColor,
  TINT,
  type BakeWorld,
} from './bake';
import {
  mirrorPhase,
  mirrorState,
  seasonFarPixel,
  seasonPixel,
  type SeasonTextures,
} from './seasonMirror';
import { MEAN_COLUMN, STATE_COLUMNS } from './seasonShader';
import { foliageTexels, seasonTexels, statePalettes, winterTone } from './seasons';

// Le miroir des couleurs de la saison sur la cuisson réelle de blocs d'un monde Petit (ADR 0019,
// § 8) : ce que le shader peut écrire, rapporté aux palettes déclarées dans les données.
const data = loadGameData();
const size = WORLD_SIZES.small;
const biomes = bakeBiomes(data.biomes.entries);
const riverBiome = data.biomes.indexOf('river') ?? -1;
const transition = data.seasons.minTransition;
/** Les uniformes des saisons au jour `day` : uSeason, le facteur de saison du nord, en f32. */
const seasonUniforms = (day: number, light: boolean) => ({
  day,
  season: Math.fround(seasonFactor(day / DAYS_PER_MONTH)),
  transition,
  light,
  dry: data.decor.foliage,
});
const SEEDS = ['pixelciv', 'graine', 'autre'] as const;
/** Des blocs du nord (rangées 0 et 1) et du sud (2 et 3), de part et d'autre de la couture. */
const CHUNKS = [
  [0, 0],
  [3, 1],
  [7, 1],
  [5, 2],
  [2, 3],
] as const;

interface Baked {
  readonly column: number;
  readonly row: number;
  readonly pixels: Uint8Array;
  readonly identity: Uint8Array;
}

const worlds = SEEDS.map((seed) => {
  const layers = generateWorld(
    { ...defaultWorldParams(data.worldgen.parameters, seed, 'small'), size },
    data,
  );
  const world: BakeWorld = { size, layers, biomes, riverBiome };
  const foliage = worldFoliage(size, layers, {
    foliage: data.decor.foliage,
    seasons: data.seasons,
  });
  const textures: SeasonTextures = {
    columns: size.width,
    rows: size.height,
    data: seasonTexels(size, layers, data.biomes.entries),
    foliage: foliageTexels(foliage, layers, data.biomes.entries),
    states: statePalettes(data.biomes.entries, data.seasons.light),
  };
  const chunks: Baked[] = CHUNKS.map(([column, row]) => {
    const identity = new Uint8Array(CHUNK_PX * CHUNK_PX);
    return { column, row, pixels: bakeChunk(world, column, row, identity), identity };
  });
  return { seed, layers, foliage, textures, chunks };
});

/** Chaque pixel de terre d'un bloc cuit, avec son code d'identité. */
function* landPixels(chunk: Baked) {
  for (let y = 0; y < CHUNK_PX; y++) {
    for (let x = 0; x < CHUNK_PX; x++) {
      const at = y * CHUNK_PX + x;
      if (((chunk.pixels[at * 4] ?? 0) & 1) === 0) continue;
      yield {
        x,
        y,
        at,
        code: chunk.identity[at] ?? 0,
        texel: chunk.pixels.subarray(at * 4, at * 4 + 4),
      };
    }
  }
}

/** La case qui prête le ton du pixel (x, y) d'un bloc, d'après son code d'identité. */
function sourceCell(chunk: Baked, x: number, y: number, code: number): number {
  const lender = Math.floor((code - 1) / IDENTITY.ranks);
  const wx = chunk.column * CHUNK_PX + x;
  const wy = chunk.row * CHUNK_PX + y;
  const sx = Math.floor((wx + 0.5) / 4 - 0.5) + (lender % 2);
  const sy = Math.floor((wy + 0.5) / 4 - 0.5) + Math.floor(lender / 2);
  return (
    Math.min(size.height - 1, Math.max(0, sy)) * size.width +
    (((sx % size.width) + size.width) % size.width)
  );
}

/** Mi-octobre, mi-janvier, mi-avril, mi-juillet, et le cœur de l'automne au sud. */
const DAYS = [285, 15, 105, 195, 105 + 15];

describe('miroir des couleurs de la saison (ADR 0019, § 2, 3 et 8)', () => {
  it('ne donne à un pixel que le ton de même rang d’une palette déclarée, sous son ombrage et sa teinte', () => {
    const rankNames = ['shadow', 'base', 'light'] as const;
    const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
    let changed = 0;
    for (const world of worlds) {
      for (const chunk of world.chunks) {
        for (const day of DAYS) {
          const uniforms = seasonUniforms(day, true);
          for (const pixel of landPixels(chunk)) {
            const color = seasonPixel(
              world.textures,
              uniforms,
              chunk.column * 64,
              chunk.row * 64,
              pixel.x,
              pixel.y,
              pixel.texel,
              pixel.code,
              false,
            );
            if (color === undefined) continue;
            changed++;
            const cell = sourceCell(chunk, pixel.x, pixel.y, pixel.code);
            const biome = data.biomes.entries.at(world.layers.biome[cell] ?? 0);
            if (biome === undefined) throw new Error('biome inconnu');
            const rank = rankNames[(pixel.code - 1) % IDENTITY.ranks] ?? 'base';
            // Les tons que les données déclarent pour ce rang : chaque état, et l'hiver (la
            // règle de la lumière sur sa palette d'été).
            // Le ton que les données déclarent pour l'état du pixel et son rang : la palette de
            // l'état, ou, pour l'hiver, la règle de la lumière sur sa palette d'été.
            const south = ((world.textures.data[cell * 4 + 2] ?? 0) & 1) === 1;
            const state = mirrorState(
              world.textures.foliage,
              cell * FOLIAGE_BYTES,
              mirrorPhase(day, south),
              leafThreshold(chunk.column * CHUNK_PX + pixel.x, chunk.row * CHUNK_PX + pixel.y),
              uniforms,
              south,
            );
            const name = SEASON_STATES.at(state);
            const palette = name === undefined ? undefined : biome.seasons.states?.[name];
            const declared = [
              state === 3
                ? winterTone(parseColor(biome.palette[rank]), data.seasons.light)
                : parseColor(palette?.[rank] ?? '#000000'),
            ];
            expect(state === 3 || palette !== undefined, `${biome.id}, état ${String(state)}`).toBe(
              true,
            );
            const shade = pixel.texel[3] / 255 + 0.5;
            const temperature = (world.textures.data[cell * 4] ?? 0) / 2 - 64;
            const warm = clamp01((temperature - TINT.warmFrom) / TINT.warmSpan);
            const cold = clamp01(-temperature / TINT.coldSpan);
            const tint = [
              1 + TINT.red * warm - TINT.red * cold,
              1 + TINT.green * warm,
              1 - TINT.blue * warm + TINT.blue * cold,
            ];
            const matches = declared.some((tone) =>
              tone.every(
                (value, channel) =>
                  Math.abs(
                    Math.min(255, Math.round(value * shade * (tint[channel] ?? 1))) -
                      (color[channel] ?? 0),
                  ) <= 1,
              ),
            );
            expect(matches, `${world.seed}, ${biome.id}, jour ${String(day)}`).toBe(true);
          }
        }
      }
    }
    expect(changed).toBeGreaterThan(100_000);
  });

  it('laisse la carte de ses tuiles au cœur de l’été de chaque hémisphère', () => {
    for (const world of worlds) {
      for (const chunk of world.chunks) {
        // Le jour le plus chaud de l'hémisphère du bloc, et dix jours de part et d'autre.
        const warmest = chunk.row < 2 ? 195 : 15;
        for (const day of [warmest - 10, warmest, warmest + 10]) {
          const uniforms = seasonUniforms(day, true);
          for (const pixel of landPixels(chunk)) {
            const color = seasonPixel(
              world.textures,
              uniforms,
              chunk.column * 64,
              chunk.row * 64,
              pixel.x,
              pixel.y,
              pixel.texel,
              pixel.code,
              false,
            );
            expect(color, `${world.seed}, jour ${String(day)}`).toBeUndefined();
          }
        }
      }
    }
  });

  it('reconnaît plus de 99 % des pixels de terre des biomes à états', () => {
    for (const world of worlds) {
      let land = 0;
      let known = 0;
      for (const chunk of world.chunks) {
        for (const pixel of landPixels(chunk)) {
          const cy = Math.floor((chunk.row * CHUNK_PX + pixel.y) / 4);
          const cx = Math.floor((chunk.column * CHUNK_PX + pixel.x) / 4);
          const biome = data.biomes.entries.at(world.layers.biome[cy * size.width + cx] ?? 0);
          if (biome?.seasons.states === undefined) continue;
          land++;
          if (pixel.code !== IDENTITY.none) known++;
        }
      }
      expect(land, world.seed).toBeGreaterThan(10_000);
      expect(known / land, world.seed).toBeGreaterThan(0.99);
    }
  });

  it('au cran atténué, ne mêle jamais deux états dans une case hors de ses transitions', () => {
    // La critique (requis 3) : le cran du milieu tramait la moitié des pixels toute la saison. Il
    // n'a plus de force : la végétation sans la lumière d'hiver. Une case dont aucun état n'est en
    // transition a tous ses pixels au même état ; et aucun pixel ne prend la lumière d'hiver.
    let cells = 0;
    for (const world of worlds) {
      for (const chunk of world.chunks) {
        for (const day of [...DAYS, 45, 330]) {
          const uniforms = seasonUniforms(day, false);
          const states = new Map<number, Set<number>>();
          for (const pixel of landPixels(chunk)) {
            if (pixel.code === IDENTITY.none) continue;
            const cell = sourceCell(chunk, pixel.x, pixel.y, pixel.code);
            const south = ((world.textures.data[cell * 4 + 2] ?? 0) & 1) === 1;
            const phase = phaseDay(day, south);
            const shares = foliageShares(
              world.textures.foliage,
              cell * FOLIAGE_BYTES,
              phase,
              transition,
              data.decor.foliage,
            );
            const settled = [shares.autumn, shares.bare, shares.dry].every(
              (share) => share === 0 || share === 1,
            );
            if (!settled) continue;
            const wx = chunk.column * CHUNK_PX + pixel.x;
            const wy = chunk.row * CHUNK_PX + pixel.y;
            const state = mirrorState(
              world.textures.foliage,
              cell * FOLIAGE_BYTES,
              Math.fround(phase),
              leafThreshold(wx, wy),
              uniforms,
              south,
            );
            expect(state).not.toBe(3);
            let seen = states.get(cell);
            if (seen === undefined) {
              seen = new Set();
              states.set(cell, seen);
            }
            seen.add(state);
          }
          for (const seen of states.values()) {
            expect(seen.size).toBe(1);
            cells++;
          }
        }
      }
    }
    expect(cells).toBeGreaterThan(50_000);
  });

  it('de loin, ne change la teinte d’aucun pixel d’eau, de rivière ni de rive, et suit les tons moyens', () => {
    // La relecture de 2b.7 (problème 2) : de loin, le rapport des tons moyens s'appliquait à tout
    // texel d'une case de terre, et le bleu des rivières et des côtes virait au rose, au rouge ou
    // au violet. Sur les mêmes blocs, au niveau 0 des mipmaps (une échelle entre 0,71 et 1) : un
    // pixel sans ton de terre (eau, rivière, rive d'une côte) garde son texel, comme toute sa case ;
    // ailleurs, chaque canal prend le rapport des tons moyens de l'état et de l'été du biome.
    let changed = 0;
    let kept = 0;
    for (const world of worlds) {
      for (const chunk of world.chunks) {
        for (const day of [DAYS[0] ?? 0, 290, 15]) {
          const uniforms = seasonUniforms(day, true);
          for (let y = 0; y < CHUNK_PX; y++) {
            for (let x = 0; x < CHUNK_PX; x++) {
              const at = y * CHUNK_PX + x;
              const texel = chunk.pixels.subarray(at * 4, at * 4 + 4);
              const color = seasonFarPixel(
                world.textures,
                uniforms,
                chunk.column * 64,
                chunk.row * 64,
                x,
                y,
                texel,
                chunk.identity,
                false,
              );
              if (color === undefined) continue;
              changed++;
              // Toute la case porte des tons de terre, et le pixel aussi.
              expect(chunk.identity[at]).not.toBe(IDENTITY.none);
              const cell = (chunk.row * 64 + (y >> 2)) * size.width + chunk.column * 64 + (x >> 2);
              const row = (world.textures.data[cell * 4 + 3] ?? 0) * STATE_COLUMNS;
              const south = ((world.textures.data[cell * 4 + 2] ?? 0) & 1) === 1;
              const state = mirrorState(
                world.textures.foliage,
                cell * FOLIAGE_BYTES,
                mirrorPhase(day, south),
                leafThreshold(chunk.column * 64 + (x >> 2), chunk.row * 64 + (y >> 2)),
                uniforms,
                south,
              );
              for (let k = 0; k < 3; k++) {
                const mean = world.textures.states[(row + MEAN_COLUMN + 1 + state) * 4 + k] ?? 0;
                const summer = world.textures.states[(row + MEAN_COLUMN) * 4 + k] ?? 0;
                const want = ((texel[k] ?? 0) * mean) / Math.max(summer, 1);
                expect(Math.abs((color[k] ?? 0) - Math.min(255, want))).toBeLessThanOrEqual(1);
              }
            }
          }
          // Les pixels sans ton de terre des cases de terre : jamais changés.
          for (let y = 0; y < CHUNK_PX; y++) {
            for (let x = 0; x < CHUNK_PX; x++) {
              const at = y * CHUNK_PX + x;
              if ((chunk.identity[at] ?? 0) !== IDENTITY.none) continue;
              const color = seasonFarPixel(
                world.textures,
                uniforms,
                chunk.column * 64,
                chunk.row * 64,
                x,
                y,
                chunk.pixels.subarray(at * 4, at * 4 + 4),
                chunk.identity,
                false,
              );
              expect(color).toBeUndefined();
              kept++;
            }
          }
        }
      }
    }
    expect(changed).toBeGreaterThan(100_000);
    expect(kept).toBeGreaterThan(10_000);
  });

  it('fige le motif du miroir sur ces blocs, aux jours de l’année', () => {
    const fingerprint = new Fingerprint();
    const world = worlds.at(0);
    if (world === undefined) throw new Error('monde absent');
    for (const chunk of world.chunks) {
      for (const day of DAYS) {
        for (const light of [false, true]) {
          for (const pixel of landPixels(chunk)) {
            const color = seasonPixel(
              world.textures,
              seasonUniforms(day, light),
              chunk.column * 64,
              chunk.row * 64,
              pixel.x,
              pixel.y,
              pixel.texel,
              pixel.code,
              false,
            );
            if (color === undefined) continue;
            fingerprint.uint32(pixel.at).uint32((color[0] << 16) | (color[1] << 8) | color[2]);
          }
        }
      }
    }
    expect(fingerprint.hex()).toBe('571c697f');
  });
});
