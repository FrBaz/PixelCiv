import { beforeAll, describe, expect, it } from 'vitest';
import { loadGameData } from '../core/data';
import type { Biome } from '../core/data/schemas';
import { COVER_RAMPS, seasonFactor, type CoverRamp } from '../core/seasons';
import { bakedWaterTone, MAX_CREST_LENGTH, MAX_CREST_THICKNESS } from '../core/waves';
import { chunkGrid, WORLD_SIZES, type WorldLayers } from '../core/world';
import { defaultWorldParams } from '../core/worldParams';
import { generateWorld } from '../worldgen/generate';
import { bakeBiomes, bakeChunk, bakeRegion, CHUNK_PX, type BakeWorld } from './bake';
import { bakedReply } from './bakeProtocol';
import { seasonTexels } from './seasons';
import {
  bayer,
  calm32,
  CALM_SPAN,
  CREST_CYCLE,
  CREST_LIFE,
  CREST_ROW,
  crestAt,
  monthly32,
  RIPPLE_CYCLE,
  rippleAt,
  SEA_TILE,
  seaInRect,
  seaMask,
  seaTones,
  WAVE_BLOCK,
  WAVE_NOISE,
  WAVE_PERIOD_Y,
  waveNoise,
  wavePhase,
  wavePixel,
  waveStill,
  waveTable,
  type WaveBiome,
  type WaveFrame,
  type WavePixel,
  type WaveTable,
  type WaveView,
} from './waves';

// Le miroir du shader de la mer animée (ADR 0015), sur quelques blocs choisis de la cuisson
// réelle d'un monde Petit : haute mer, océan, côte et son rivage, lacs et rivières, banquise.
// Les blocs se choisissent d'après les biomes, pas d'après leur place : une retouche de la
// génération change les blocs, pas les propriétés vérifiées.

const data = loadGameData();
const biomes = data.biomes.entries;
const size = WORLD_SIZES.small;
const W = size.width * 4;
const noise = waveNoise();
const table = waveTable(biomes, 1);
const index = (id: string) => biomes.findIndex((biome) => biome.id === id);
const byId = (id: string) => {
  const biome = biomes.find((entry) => entry.id === id);
  if (biome === undefined) throw new Error(`biome ${id} absent`);
  return biome;
};
const tonesOf = (id: string) => {
  const biome = table.biomes.find((entry) => entry.id === id);
  if (biome === undefined) throw new Error(`biome animé ${id} absent`);
  return biome;
};
const deep = tonesOf('deep-ocean');
const ocean = tonesOf('ocean');
const coastal = tonesOf('coastal-ocean');
/** Été au nord, hiver au sud, sans gel en mer libre : juillet. */
const JULY = 6.5;

const frameAt = (step: number, waves: WaveTable = table): WaveFrame => ({
  table: waves,
  noise,
  phase: wavePhase(step, W),
  worldPx: W,
});
const viewAt = (month: number): WaveView => ({
  season: Math.fround(seasonFactor(month)),
  fine: true,
  natural: true,
  streams: true,
});

/** Luminance d'un ton 0xrrggbb : plus clair, plus sombre. */
const luminance = (tone: number) =>
  0.3 * (tone >>> 16) + 0.59 * ((tone >>> 8) & 255) + 0.11 * (tone & 255);

interface Sample {
  readonly column: number;
  readonly row: number;
  readonly pixels: Uint8Array;
  /** Pixel local (lx, ly) du bloc, avec le texel de sa case. */
  readonly at: (lx: number, ly: number) => WavePixel;
}

let layers: WorldLayers;
let texels: Uint8Array;
let world: BakeWorld;
const samples = new Map<string, Sample>();
/** Un mois où le calme de la banquise est partiel dans le bloc de banquise, et un où elle le couvre. */
let calmMonth = 0;
let coverMonth = 0;

function sample(column: number, row: number): Sample {
  const pixels = bakeChunk(world, column, row);
  return {
    column,
    row,
    pixels,
    at: (lx, ly) => {
      const o = (ly * CHUNK_PX + lx) * 4;
      const cell =
        (Math.floor((row * CHUNK_PX + ly) / 4) * size.width +
          Math.floor((column * CHUNK_PX + lx) / 4)) *
        4;
      return {
        red: pixels[o] ?? 0,
        green: pixels[o + 1] ?? 0,
        blue: pixels[o + 2] ?? 0,
        temperature: texels[cell] ?? 0,
        amplitude: texels[cell + 1] ?? 0,
        flags: texels[cell + 2] ?? 0,
      };
    },
  };
}

function chosen(name: string): Sample {
  const found = samples.get(name);
  if (found === undefined) throw new Error(`bloc ${name} introuvable`);
  return found;
}

/** Chaque pixel d'un bloc, en coordonnées du monde. */
function* pixelsOf(block: Sample): Generator<{ x: number; y: number; pixel: WavePixel }> {
  for (let ly = 0; ly < CHUNK_PX; ly++) {
    for (let lx = 0; lx < CHUNK_PX; lx++) {
      yield {
        x: block.column * CHUNK_PX + lx,
        y: block.row * CHUNK_PX + ly,
        pixel: block.at(lx, ly),
      };
    }
  }
}

const colorOf = (pixel: WavePixel) => (pixel.red << 16) | (pixel.green << 8) | pixel.blue;

beforeAll(() => {
  layers = generateWorld(
    { ...defaultWorldParams(data.worldgen.parameters, 'pixelciv', 'small'), size },
    data,
  );
  texels = seasonTexels(size, layers, biomes);
  world = { size, layers, biomes: bakeBiomes(biomes), riverBiome: index('river') };
  const grid = chunkGrid(size);
  const counts = (
    column: number,
    row: number,
    wanted: (biome: number, cell: number) => boolean,
  ) => {
    let count = 0;
    for (let y = row * 64; y < row * 64 + 64; y++) {
      for (let x = column * 64; x < column * 64 + 64; x++) {
        const cell = y * size.width + x;
        if (wanted(layers.biome[cell] ?? 0, cell)) count++;
      }
    }
    return count;
  };
  const best = (score: (column: number, row: number) => number) => {
    let top = { column: 0, row: 0, score: -1 };
    for (let row = 0; row < grid.rows; row++) {
      for (let column = 0; column < grid.columns; column++) {
        const value = score(column, row);
        if (value > top.score) top = { column, row, score: value };
      }
    }
    return top;
  };
  const is = (id: string) => (biome: number) => biome === index(id);
  const land = (biome: number) => biomes[biome]?.family !== 'water';
  const choices = {
    deep: best((c, r) => counts(c, r, is('deep-ocean'))),
    ocean: best((c, r) => counts(c, r, is('ocean'))),
    coast: best((c, r) => Math.min(counts(c, r, is('coastal-ocean')), counts(c, r, land))),
    fresh: best(
      (c, r) =>
        counts(c, r, is('lake')) +
        counts(c, r, (biome, cell) => land(biome) && (layers.drainage[cell] ?? 0) >= 32),
    ),
  };
  // La banquise : le bloc qui a le plus de mer côtière gelée au mois le plus froid.
  const frozen = (column: number, row: number, month: number) => {
    const season = Math.fround(seasonFactor(month));
    return counts(column, row, (biome, cell) => {
      if (biome !== index('coastal-ocean')) return false;
      const monthly = monthly32(
        {
          red: 0,
          green: 0,
          blue: 0,
          temperature: texels[cell * 4] ?? 0,
          amplitude: texels[cell * 4 + 1] ?? 0,
          flags: texels[cell * 4 + 2] ?? 0,
        },
        season,
      );
      return monthly < COVER_RAMPS['sea-ice'].onset + CALM_SPAN;
    });
  };
  const ice = best((c, r) => Math.max(frozen(c, r, 0.5), frozen(c, r, JULY)));
  for (const [name, at] of Object.entries({ ...choices, ice }))
    samples.set(name, sample(at.column, at.row));
  // Les mois du bloc de banquise : calme le plus partiel, couverture la plus grande.
  const ramp = COVER_RAMPS['sea-ice'];
  let calmBest = -1;
  let coverBest = -1;
  for (let month = 0; month < 12; month += 0.25) {
    const view = viewAt(month);
    let calmed = 0;
    let moving = 0;
    let covered = 0;
    for (const { x, y, pixel } of pixelsOf(chosen('ice'))) {
      if (!coastal.tones.includes(colorOf(pixel))) continue;
      const still = waveStill(view, x, y, pixel);
      if (still === 'calm') calmed++;
      else if (still === 'covered') covered++;
      else if (still === undefined && calm32(ramp, monthly32(pixel, view.season)) > 0) moving++;
    }
    if (Math.min(calmed, moving) > calmBest) {
      calmBest = Math.min(calmed, moving);
      calmMonth = month;
    }
    if (covered > coverBest) {
      coverBest = covered;
      coverMonth = month;
    }
  }
}, 60_000);

describe('mer animée : le miroir du shader (ADR 0015)', () => {
  it('ne change que des pixels de mer au repos, vers un ton de leur palette', () => {
    const counts = { crest: 0, ripple: 0, perBlock: new Map<string, number>() };
    for (const [name, block] of samples) {
      const month = name === 'ice' ? calmMonth : JULY;
      const view = viewAt(month);
      // Les clapots durent 2 pas sur 64 : 64 pas pour la côte, un pixel sur deux ; 8 ailleurs.
      const steps = name === 'coast' ? RIPPLE_CYCLE : 8;
      for (let step = 0; step < steps; step++) {
        const frame = frameAt(step);
        for (const { x, y, pixel } of pixelsOf(block)) {
          if ((pixel.red & 1) === 1 || (name === 'coast' && (x + y) % 2 === 1)) continue;
          const tone = wavePixel(frame, view, x, y, pixel);
          if (tone === undefined) continue;
          counts.perBlock.set(name, (counts.perBlock.get(name) ?? 0) + 1);
          // Un pixel d'eau libre, ni couvert ni calmé, d'un biome animé, dont le ton nouveau
          // est un autre ton de la même palette.
          expect(waveStill(view, x, y, pixel)).toBeUndefined();
          const owner = table.biomes.find((biome) => biome.tones.includes(colorOf(pixel)));
          expect(owner).toBeDefined();
          expect(owner?.tones).toContain(tone);
          expect(tone).not.toBe(colorOf(pixel));
          if (owner === undefined) continue;
          if (crestAt(frame, owner, x, y)) {
            counts.crest++;
            expect(luminance(tone)).toBeGreaterThan(luminance(colorOf(pixel)));
            expect(tone).not.toBe(owner.tones[0]);
          } else {
            expect(rippleAt(frame, owner, x, y)).toBe(true);
            counts.ripple++;
            expect(tone).toBe(owner.tones[0]);
            expect(luminance(tone)).toBeLessThan(luminance(colorOf(pixel)));
          }
        }
      }
    }
    // Rien de vide : des crêtes et des clapots, dans chaque bloc de mer.
    expect(counts.crest).toBeGreaterThan(1000);
    expect(counts.ripple).toBeGreaterThan(0);
    for (const name of ['deep', 'ocean', 'coast', 'ice']) {
      expect(counts.perBlock.get(name) ?? 0).toBeGreaterThan(0);
    }
  });

  it('laisse immobiles terres, ruisseaux, lacs, rivières et pixels couverts', () => {
    const still = { land: 0, stream: 0, lake: 0, river: 0, covered: 0, moved: 0 };
    const fresh = new Set(
      biomes
        .filter((biome) => ['lake', 'river', 'salt-lake'].includes(biome.id))
        .flatMap((biome) => [biome.palette.shadow, biome.palette.base, biome.palette.light])
        .map(bakedWaterTone),
    );
    for (const [name, month] of [
      ['fresh', JULY],
      ['coast', JULY],
      ['ice', coverMonth],
    ] as const) {
      const view = viewAt(month);
      for (let step = 0; step < CREST_CYCLE; step += 5) {
        const frame = frameAt(step);
        for (const { x, y, pixel } of pixelsOf(chosen(name))) {
          const reason = waveStill(view, x, y, pixel);
          const tone = wavePixel(frame, view, x, y, pixel);
          if (reason === 'land') still.land++;
          if (reason === 'land' && (pixel.green & 1) === 1) still.stream++;
          if (reason === 'covered') still.covered++;
          if (reason === undefined && fresh.has(colorOf(pixel))) {
            if (((pixel.flags >> 6) & 1) === 1) still.lake++;
            else still.river++;
          }
          if ((reason !== undefined || fresh.has(colorOf(pixel))) && tone !== undefined) {
            still.moved++;
          }
        }
      }
    }
    // Aucun n'a bougé, et chaque cas a bien été rencontré.
    expect(still.moved).toBe(0);
    expect(still.land).toBeGreaterThan(0);
    expect(still.stream).toBeGreaterThan(0);
    expect(still.lake).toBeGreaterThan(0);
    expect(still.river).toBeGreaterThan(0);
    expect(still.covered).toBeGreaterThan(0);
  });

  it('se raccorde à la couture : le motif ne dépend que du pixel du monde', () => {
    // Les deux bords de la couture, cuits d'un tenant à travers elle, et bloc par bloc.
    const across = bakeRegion(world, W - 64, 512, 128, 64);
    const east = bakeChunk(world, size.width / 64 - 1, 2);
    const west = bakeChunk(world, 0, 2);
    const view = viewAt(JULY);
    let changed = 0;
    let differ = 0;
    for (let step = 0; step < 8; step++) {
      const frame = frameAt(step);
      for (let ly = 0; ly < 64; ly++) {
        for (let lx = 0; lx < 128; lx++) {
          const x = (W - 64 + lx) % W;
          const y = 512 + ly;
          const o = (ly * 128 + lx) * 4;
          const chunk = lx < 64 ? east : west;
          const c = ((y - 512) * CHUNK_PX + (lx < 64 ? CHUNK_PX - 64 + lx : lx - 64)) * 4;
          if (
            chunk[c] !== across[o] ||
            chunk[c + 1] !== across[o + 1] ||
            chunk[c + 2] !== across[o + 2]
          ) {
            differ++;
          }
          const cell = (Math.floor(y / 4) * size.width + Math.floor(x / 4)) * 4;
          const pixel = {
            red: across[o] ?? 0,
            green: across[o + 1] ?? 0,
            blue: across[o + 2] ?? 0,
            temperature: texels[cell] ?? 0,
            amplitude: texels[cell + 1] ?? 0,
            flags: texels[cell + 2] ?? 0,
          };
          const tone = wavePixel(frame, view, x, y, pixel);
          if (tone !== undefined) changed++;
          // x, x + W et x − W : le même pixel.
          if (wavePixel(frame, view, x + W, y, pixel) !== tone) differ++;
          if (wavePixel(frame, view, x - W, y, pixel) !== tone) differ++;
          for (const biome of table.biomes) {
            if (crestAt(frame, biome, x + W, y) !== crestAt(frame, biome, x, y)) differ++;
            if (rippleAt(frame, biome, x - W, y) !== rippleAt(frame, biome, x, y)) differ++;
          }
        }
      }
    }
    expect(differ).toBe(0);
    expect(changed).toBeGreaterThan(0);
  });

  it('garde chaque crête entière dans son bloc, aux longueur et épaisseur maximales', () => {
    // Un bruit où seul le bloc (2, 2) du cadre porte une crête, à chaque départ possible. Le
    // shader ne dessine une crête que dans son bloc : si elle n'y tenait pas, elle serait
    // tronquée. Elle doit donc y paraître entière, de toute sa longueur et son épaisseur.
    const widest: WaveBiome = {
      ...coastal,
      crestThreshold: 1,
      length: MAX_CREST_LENGTH,
      thickness: MAX_CREST_THICKNESS,
    };
    const lone = new Uint8Array(WAVE_NOISE * WAVE_NOISE * 4).fill(255);
    const at = ((2 + CREST_ROW) * WAVE_NOISE + 2) * 4;
    let longest = 0;
    let wrong = 0;
    // Chaque départ possible : le plus petit octet qui y mène, et 255 pour le plus lointain.
    const bytes = (span: number) => [
      ...Array.from({ length: span }, (_, k) => Math.ceil((k * 256) / span)),
      255,
    ];
    for (const b of bytes(10)) {
      for (const a of bytes(12)) {
        lone.set([0, 0, b, a], at);
        for (let tau = 0; tau < CREST_CYCLE; tau++) {
          // Cadre immobile (phase en x et en y nulles), crête à la phase tau.
          const frame: WaveFrame = { table, noise: lone, phase: [0, 0, tau, 0], worldPx: W };
          let pixels = 0;
          for (let y = WAVE_BLOCK; y < 4 * WAVE_BLOCK; y++) {
            for (let x = WAVE_BLOCK; x < 4 * WAVE_BLOCK; x++) {
              if (!crestAt(frame, widest, x, y)) continue;
              pixels++;
              if (Math.floor(x / WAVE_BLOCK) !== 2 || Math.floor(y / WAVE_BLOCK) !== 2) wrong++;
            }
          }
          const length =
            tau < CREST_LIFE ? Math.min(MAX_CREST_LENGTH, tau + 1, CREST_LIFE - tau) : 0;
          if (pixels !== length * MAX_CREST_THICKNESS) wrong++;
          longest = Math.max(longest, pixels);
        }
      }
    }
    expect(wrong).toBe(0);
    expect(longest).toBe(MAX_CREST_LENGTH * MAX_CREST_THICKNESS);
  });

  it("se décale d'un pixel vers l'est et d'un vers le nord à chaque pas, et ne change que de longueur", () => {
    // Dans le cadre qui glisse, une crête ne bouge pas : d'un pas au suivant, ses pixels sont
    // les mêmes, au bout près. Au pas s, le pixel q du cadre est le pixel (q.x + s, q.y − s)
    // du monde : un pixel vers l'est et un vers le nord à chaque pas.
    let grown = 0;
    let shrunk = 0;
    for (const biome of [deep, ocean, coastal]) {
      for (let step = 0; step < 2 * CREST_CYCLE; step++) {
        const sets = [step, step + 1].map((s) => {
          const frame = frameAt(s);
          const byBlock = new Map<number, Set<number>>();
          for (let qy = 40 * WAVE_BLOCK; qy < 48 * WAVE_BLOCK; qy++) {
            for (let qx = W - 4 * WAVE_BLOCK; qx < W + 4 * WAVE_BLOCK; qx++) {
              const x = (((qx + s) % W) + W) % W;
              if (!crestAt(frame, biome, x, qy - s)) continue;
              const block = Math.floor(qy / WAVE_BLOCK) * 1000 + Math.floor((qx % W) / WAVE_BLOCK);
              const pixels = byBlock.get(block) ?? new Set<number>();
              pixels.add(qy * 100_000 + (qx % W));
              byBlock.set(block, pixels);
            }
          }
          return byBlock;
        });
        const [before, after] = sets as [Map<number, Set<number>>, Map<number, Set<number>>];
        for (const block of new Set([...before.keys(), ...after.keys()])) {
          const a = before.get(block) ?? new Set<number>();
          const b = after.get(block) ?? new Set<number>();
          const aInB = [...a].every((pixel) => b.has(pixel));
          const bInA = [...b].every((pixel) => a.has(pixel));
          expect(aInB || bInA).toBe(true);
          expect(Math.abs(a.size - b.size)).toBeLessThanOrEqual(biome.thickness);
          if (b.size > a.size) grown++;
          if (b.size < a.size) shrunk++;
        }
      }
    }
    expect(grown).toBeGreaterThan(0);
    expect(shrunk).toBeGreaterThan(0);
  });

  it('se calme avant la glace, sur les rampes de core/seasons.ts, et seulement là où l’eau gèle', () => {
    // La part des pixels d'une case qui peuvent bouger, sur une tuile de Bayer de 4 × 4, quand
    // la température du mois descend : toute au-dessus du seuil + CALM_SPAN, nulle au seuil.
    const share = (flags: number, celsius: number) => {
      const pixel = {
        red: coastal.tones[2] >>> 16,
        green: (coastal.tones[2] >>> 8) & 255,
        blue: coastal.tones[2] & 255,
        temperature: Math.round((celsius + 64) * 2),
        amplitude: 0,
        flags,
      };
      let moving = 0;
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++)
          if (waveStill(viewAt(JULY), x, y, pixel) === undefined) moving++;
      }
      return moving / 16;
    };
    const ramps: [string, number, CoverRamp][] = [
      ['banquise, mer côtière', 64 | (3 << 4), COVER_RAMPS['sea-ice']],
      ['glace, lac', 64 | (2 << 4), COVER_RAMPS.ice],
      ["glace, eau d'une case de terre", 1 << 4, COVER_RAMPS.ice],
      ["glace, eau d'une case de terre sans neige", 0, COVER_RAMPS.ice],
    ];
    for (const [, flags, ramp] of ramps) {
      let previous = -1;
      let partial = 0;
      for (let celsius = ramp.onset - 4; celsius <= ramp.onset + CALM_SPAN + 2; celsius += 0.5) {
        const moving = share(flags, celsius);
        if (celsius <= ramp.onset) expect(moving).toBe(0);
        if (celsius >= ramp.onset + CALM_SPAN) expect(moving).toBe(1);
        if (moving > 0 && moving < 1) partial++;
        expect(moving).toBeGreaterThanOrEqual(previous);
        previous = moving;
      }
      expect(partial).toBeGreaterThan(0);
    }
    // La haute mer et l'océan ne gèlent pas : ils bougent par le plus grand froid.
    expect(share(64, -40)).toBe(1);
    // Au mois où la banquise couvre le bloc choisi, aucun pixel couvert ni calmé ne bouge,
    // et d'autres, dans des cases en calme partiel, bougent encore.
    const view = viewAt(calmMonth);
    let partialMoving = 0;
    let partialCalm = 0;
    for (const { x, y, pixel } of pixelsOf(chosen('ice'))) {
      if (!coastal.tones.includes(colorOf(pixel))) continue;
      const calm = calm32(COVER_RAMPS['sea-ice'], monthly32(pixel, view.season));
      if (calm <= 0 || calm >= 1 || ((pixel.flags >> 4) & 3) !== 3) continue;
      if (waveStill(view, x, y, pixel) === undefined) partialMoving++;
      else partialCalm++;
    }
    expect(partialMoving).toBeGreaterThan(0);
    expect(partialCalm).toBeGreaterThan(0);
  });

  it('compte la température et le calme en flottants de 32 bits, comme le shader', () => {
    const pixel = { red: 0, green: 0, blue: 0, temperature: 117, amplitude: 133, flags: 1 };
    const season = Math.fround(seasonFactor(1.37));
    const f = Math.fround;
    const temperature = f(f(f(f(117 / 255) * 255) / 2) - 64);
    const amplitude = f(f(f(133 / 255) * 255) / 8);
    const expected = f(temperature + f(f(amplitude * season) * -1));
    expect(monthly32(pixel, season)).toBe(expected);
    expect(Math.fround(monthly32(pixel, season))).toBe(monthly32(pixel, season));
    // Calme partiel : entre 0 et 1, en flottant de 32 bits.
    const calm = calm32(COVER_RAMPS.ice, 0.3);
    expect(calm).toBe(f(f(f(-1 + CALM_SPAN) - 0.3) / CALM_SPAN));
    expect(calm).toBeGreaterThan(0);
    expect(calm).toBeLessThan(1);
    expect(bayer(0, 0)).toBe(0.5 / 16);
    expect(bayer(W + 1, 3)).toBe(bayer(1, 3));
  });

  it('bouge moins en haute mer que sur l’océan, et sur l’océan qu’à la côte', () => {
    const rate = new Map<string, { changed: number; pixels: number }>();
    for (const name of ['deep', 'ocean', 'coast']) {
      const block = chosen(name);
      for (let step = 0; step < CREST_CYCLE; step++) {
        const frame = frameAt(step);
        for (const { x, y, pixel } of pixelsOf(block)) {
          if ((x + y) % 2 === 1) continue;
          const owner = table.biomes.find((biome) => biome.tones.includes(colorOf(pixel)));
          if (owner === undefined) continue;
          const entry = rate.get(owner.id) ?? { changed: 0, pixels: 0 };
          entry.pixels++;
          if (wavePixel(frame, viewAt(JULY), x, y, pixel) !== undefined) entry.changed++;
          rate.set(owner.id, entry);
        }
      }
    }
    const share = (id: string) => {
      const entry = rate.get(id);
      return entry === undefined ? Number.NaN : entry.changed / entry.pixels;
    };
    expect(share('deep-ocean')).toBeGreaterThan(0);
    expect(share('deep-ocean')).toBeLessThan(share('ocean'));
    expect(share('ocean')).toBeLessThan(share('coastal-ocean'));
  });

  it('revient au bout de ppcm(largeur, 8 192) pas, sur les quatre tailles de monde', () => {
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    const pattern = (step: number, worldPx: number) => {
      const frame: WaveFrame = { table, noise, phase: wavePhase(step, worldPx), worldPx };
      const on: boolean[] = [];
      for (let y = 300; y < 364; y++) {
        for (let x = worldPx - 32; x < worldPx + 32; x++) {
          on.push(
            crestAt(frame, coastal, x % worldPx, y) || rippleAt(frame, coastal, x % worldPx, y),
          );
        }
      }
      return on;
    };
    for (const { width } of Object.values(WORLD_SIZES)) {
      const worldPx = width * 4;
      const loop = (worldPx * WAVE_PERIOD_Y) / gcd(worldPx, WAVE_PERIOD_Y);
      for (const step of [0, 12_345, 2 ** 40 + 7]) {
        expect(wavePhase(step + loop, worldPx)).toEqual(wavePhase(step, worldPx));
        expect(pattern(step + loop, worldPx)).toEqual(pattern(step, worldPx));
      }
    }
    // La période du cadre en y est bien de 8 192 pas : à mi-chemin, le motif diffère.
    expect(pattern(5 + WAVE_PERIOD_Y / 2, 2048)).not.toEqual(pattern(5, 2048));
    // Sur un monde Moyen, 3 072 pixels de large, 8 192 pas ne suffisent pas.
    expect(wavePhase(8192, 3072)).not.toEqual(wavePhase(0, 3072));
    expect(pattern(5 + 8192, 3072)).not.toEqual(pattern(5, 3072));
    // Les phases restent de petits entiers, exacts en flottant 32 bits, après des heures.
    for (const value of wavePhase(Number.MAX_SAFE_INTEGER, 8192)) {
      expect(Number.isInteger(value) && value >= 0 && value < 8192).toBe(true);
    }
  });

  it('sous une force de 1, éteint des crêtes et des clapots sans en allumer d’autres ; à 0, rien', () => {
    const half = waveTable(biomes, 0.5);
    const none = waveTable(biomes, 0);
    expect(half.biomes.map((biome) => biome.crestThreshold)).toEqual(
      table.biomes.map(({ id }) => Math.round(256 * (byId(id).waves?.crest.share ?? 0) * 0.5)),
    );
    expect(none.biomes.every((biome) => biome.crestThreshold + biome.rippleThreshold === 0)).toBe(
      true,
    );
    let kept = 0;
    let lost = 0;
    const block = chosen('coast');
    for (let step = 0; step < 8; step++) {
      const full = frameAt(step);
      const weak = frameAt(step, half);
      for (const { x, y, pixel } of pixelsOf(block)) {
        if ((x + 2 * y) % 3 !== 0) continue;
        expect(wavePixel(frameAt(step, none), viewAt(JULY), x, y, pixel)).toBeUndefined();
        table.biomes.forEach((strong, rank) => {
          const faint = half.biomes[rank] ?? strong;
          const crest = crestAt(weak, faint, x, y);
          const ripple = rippleAt(weak, faint, x, y);
          if (crest) expect(crestAt(full, strong, x, y)).toBe(true);
          if (ripple) expect(rippleAt(full, strong, x, y)).toBe(true);
          if (crestAt(full, strong, x, y)) {
            if (crest) kept++;
            else lost++;
          }
        });
      }
    }
    expect(kept).toBeGreaterThan(0);
    expect(lost).toBeGreaterThan(0);
  });

  it('tire sa table des données, aux tons cuits distincts, et refuse deux eaux confondues', () => {
    expect(table.biomes.map((biome) => biome.id)).toEqual(['deep-ocean', 'ocean', 'coastal-ocean']);
    // Les réglages de chaque mer, tels que les données les donnent : les seuils, sur 256, valent
    // la part multipliée par 256, arrondie, à la force 1.
    for (const entry of table.biomes) {
      const { palette, waves } = byId(entry.id);
      expect(entry.crestThreshold).toBe(Math.round(256 * (waves?.crest.share ?? Number.NaN)));
      expect(entry.rippleThreshold).toBe(Math.round(256 * (waves?.ripple.share ?? Number.NaN)));
      expect([entry.length, entry.thickness]).toEqual([
        waves?.crest.length,
        waves?.crest.thickness,
      ]);
      expect(entry.crestTone).toBe(waves?.crest.tone === 'light' ? 2 : 1);
      expect(entry.tones).toEqual(
        [palette.shadow, palette.base, palette.light].map(bakedWaterTone),
      );
    }
    const tones = seaTones(table);
    expect(tones).toHaveLength(3 * table.biomes.length);
    expect(new Set(tones).size).toBe(tones.length);
    // Le ton cuit d'une eau : les bits faibles du rouge et du vert à 0, comme la cuisson.
    expect(bakedWaterTone('#3564a3')).toBe(0x3464a3);
    expect(bakedWaterTone('#3463a3')).toBe(0x3462a3);
    const lake = biomes[index('lake')] ?? biomes[0];
    const light = Number.parseInt(byId('coastal-ocean').palette.light.slice(1), 16);
    const twin: Biome = {
      ...lake,
      palette: { ...lake.palette, light: `#${(light ^ 0x010100).toString(16).padStart(6, '0')}` },
    };
    expect(() => waveTable([...biomes, twin], 1)).toThrow(
      /coastal-ocean et lake partagent un ton cuit/,
    );
    // Les tons, tels que la cuisson les écrit dans les pixels d'eau de la côte.
    const written = new Set<number>();
    for (const { pixel } of pixelsOf(chosen('coast'))) {
      if ((pixel.red & 1) === 0) written.add(colorOf(pixel));
    }
    expect(coastal.tones.filter((tone) => written.has(tone))).toEqual([...coastal.tones]);
  });

  it('repère la mer animée d’un bloc cuit, tuile par tuile', () => {
    const tones = seaTones(table);
    const tiles = CHUNK_PX / SEA_TILE;
    /** Tuiles qui ont un pixel d'eau aux tons animés, comptées pixel à pixel. */
    const expected = (pixels: Uint8Array, wanted: readonly number[]) => {
      const mask = new Uint8Array(tiles * tiles);
      for (let y = 0; y < CHUNK_PX; y++) {
        for (let x = 0; x < CHUNK_PX; x++) {
          const o = (y * CHUNK_PX + x) * 4;
          const red = pixels[o] ?? 1;
          const tone = (red << 16) | ((pixels[o + 1] ?? 0) << 8) | (pixels[o + 2] ?? 0);
          if ((red & 1) === 0 && wanted.includes(tone)) {
            mask[Math.floor(y / SEA_TILE) * tiles + Math.floor(x / SEA_TILE)] = 1;
          }
        }
      }
      return mask;
    };
    const marked = (mask: Uint8Array) => mask.reduce((sum, tile) => sum + tile, 0);
    for (const name of ['deep', 'ocean', 'coast', 'fresh']) {
      const { pixels } = chosen(name);
      expect(seaMask(pixels, tones, CHUNK_PX)).toEqual(expected(pixels, tones));
    }
    // Au large, la mer partout ; à la côte, une partie des tuiles seulement.
    expect(marked(seaMask(chosen('deep').pixels, tones, CHUNK_PX))).toBe(tiles * tiles);
    const coast = seaMask(chosen('coast').pixels, tones, CHUNK_PX);
    expect(marked(coast)).toBeGreaterThan(0);
    expect(marked(coast)).toBeLessThan(tiles * tiles);
    // Sans tons animés, un bloc tout en terre, la même eau sans ses tons animés : rien.
    expect(marked(seaMask(chosen('deep').pixels, [], CHUNK_PX))).toBe(0);
    const land = new Uint8Array(CHUNK_PX * CHUNK_PX * 4).fill(1);
    expect(marked(seaMask(land, tones, CHUNK_PX))).toBe(0);
    const lakeOnly = Uint8Array.from(chosen('fresh').pixels);
    for (let o = 0; o < lakeOnly.length; o += 4) {
      const tone =
        ((lakeOnly[o] ?? 0) << 16) | ((lakeOnly[o + 1] ?? 0) << 8) | (lakeOnly[o + 2] ?? 0);
      if (((lakeOnly[o] ?? 0) & 1) === 0 && tones.includes(tone)) lakeOnly[o] = 1;
    }
    expect(marked(seaMask(lakeOnly, tones, CHUNK_PX))).toBe(0);
    // Un seul pixel de mer, au coin d'une tuile : sa tuile seule, et tout rectangle qui la touche.
    const one = Uint8Array.from(land);
    const [x, y] = [3 * SEA_TILE + SEA_TILE - 1, 5 * SEA_TILE];
    const o = (y * CHUNK_PX + x) * 4;
    one.set([coastal.tones[1] >>> 16, (coastal.tones[1] >>> 8) & 255, coastal.tones[1] & 255], o);
    const mask = seaMask(one, tones, CHUNK_PX);
    expect(marked(mask)).toBe(1);
    expect(mask[5 * tiles + 3]).toBe(1);
    expect(seaInRect(mask, CHUNK_PX, x, y, x + 1, y + 1)).toBe(true);
    expect(seaInRect(mask, CHUNK_PX, 0, 0, CHUNK_PX, CHUNK_PX)).toBe(true);
    expect(seaInRect(mask, CHUNK_PX, 3 * SEA_TILE, 5 * SEA_TILE, 4 * SEA_TILE, 6 * SEA_TILE)).toBe(
      true,
    );
    // Les tuiles voisines, bord à bord : rien. Un rectangle vide : rien.
    expect(seaInRect(mask, CHUNK_PX, 0, 0, 3 * SEA_TILE, CHUNK_PX)).toBe(false);
    expect(seaInRect(mask, CHUNK_PX, 4 * SEA_TILE, 0, CHUNK_PX, CHUNK_PX)).toBe(false);
    expect(seaInRect(mask, CHUNK_PX, 0, 0, CHUNK_PX, 5 * SEA_TILE)).toBe(false);
    expect(seaInRect(mask, CHUNK_PX, 0, 6 * SEA_TILE, CHUNK_PX, CHUNK_PX)).toBe(false);
    expect(seaInRect(mask, CHUNK_PX, x, y, x, y + 1)).toBe(false);
  });

  it('renvoie de chaque bloc cuit ses pixels et le masque de sa mer, transférés', () => {
    const request = { type: 'bake', generation: 3, column: 2, row: 1, version: 7 } as const;
    const tones = seaTones(table);
    for (const name of ['deep', 'coast', 'fresh']) {
      const pixels = Uint8Array.from(chosen(name).pixels);
      const { reply, transfer } = bakedReply(request, 3, pixels, tones);
      if (reply.type !== 'baked') throw new Error('réponse inattendue');
      expect(reply).toMatchObject({ generation: 3, column: 2, row: 1, version: 7, pixels });
      expect(reply.seaMask).toEqual(seaMask(pixels, tones, CHUNK_PX));
      expect(transfer).toEqual([pixels.buffer, reply.seaMask.buffer]);
    }
    const land = new Uint8Array(CHUNK_PX * CHUNK_PX * 4).fill(1);
    const { reply } = bakedReply(request, 3, land, tones);
    expect(reply.type === 'baked' && reply.seaMask.every((tile) => tile === 0)).toBe(true);
  });
});
