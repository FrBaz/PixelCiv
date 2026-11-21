/**
 * Contrôle des pixels de la mer animée (ADR 0015, § 10 ; tools/wave-control/LISEZMOI.md).
 * Vitest ne voit pas le shader : ce contrôle compare, pixel à pixel, des captures de Chromium
 * (capture.cjs) au miroir TypeScript du shader (src/render/waves.ts), appliqué à la cuisson
 * réelle du même monde, couture comprise. Hors de la suite des tests, il se lance par
 * `npx vitest run --mode wave-control`, avec CONTROL_DIR, le dossier des captures : une vue par
 * sous-dossier qui a son meta.json. Chaque vue écrit son result.json à côté de ses captures.
 *
 * Il vérifie, pour chaque vue :
 * - à chaque pas capturé, que chaque pixel de l'écran vaut ce que dit le miroir : le ton que
 *   l'onde donne au pixel, ou sa couleur au repos (`mismatch`, attendu à 0) ;
 * - au repos (onde éteinte par le mouvement réduit), que les pixels d'eau libre montrent leur
 *   couleur cuite (`restMismatch`, attendu à 0) : la capture et la cuisson se superposent ;
 * - avec une capture de la construction de 2b.3 au même endroit, que l'onde éteinte la rend à
 *   l'identique (`offVersusBase.differ`, attendu à 0).
 * Il compte aussi les pixels que le miroir fait bouger, et ceux qu'il compare en calme partiel,
 * pour qu'une vue sans mer ni gel ne passe pas pour un succès.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../src/core/data';
import { seasonFactor } from '../../src/core/seasons';
import { DAYS_PER_MONTH } from '../../src/core/time';
import { iceAt, worldCalendars } from '../../src/core/snow';
import { WORLD_SIZES } from '../../src/core/world';
import { defaultWorldParams } from '../../src/core/worldParams';
import { bakeBiomes, bakeRegion } from '../../src/render/bake';
import { seasonTexels } from '../../src/render/seasons';
import {
  waterCover32,
  waterRamp,
  waveCovers,
  waveNoise,
  wavePixel,
  waveStill,
  waveTable,
  type WavePixel,
} from '../../src/render/waves';
import { generateWorld } from '../../src/worldgen/generate';
import { decodePng, type RgbImage } from './png';

/** Ce que capture.cjs écrit dans le meta.json de chaque vue. */
interface Meta {
  readonly seed: string;
  readonly month: number;
  /** Centre de l'écran en pixels de carte, et taille de l'écran en pixels physiques. */
  readonly cam: {
    readonly x: number;
    readonly y: number;
    readonly vw: number;
    readonly vh: number;
  };
  /** Phase de l'onde que montre chaque capture, lue dans les uniformes du shader. */
  readonly steps: readonly { readonly phase: readonly number[]; readonly file: string }[];
  /** Capture de la construction de 2b.3 au même endroit, s'il y en a une. */
  readonly base?: string;
}

const root = process.env.CONTROL_DIR ?? '';
const views = root === '' ? [] : [root, ...readdirSync(root).map((name) => path.join(root, name))];
const folders = views.filter((folder) => existsSync(path.join(folder, 'meta.json')));

const image = (folder: string, file: string): RgbImage =>
  decodePng(readFileSync(path.join(folder, file)));

describe('contrôle des pixels de la mer animée (ADR 0015)', () => {
  it('a des vues à contrôler', () => {
    expect(root, 'CONTROL_DIR : le dossier des captures de capture.cjs').not.toBe('');
    expect(folders.length).toBeGreaterThan(0);
  });

  it.each(folders)('égale le miroir pixel à pixel : %s', (folder) => {
    const meta = JSON.parse(readFileSync(path.join(folder, 'meta.json'), 'utf8')) as Meta;
    const data = loadGameData();
    const size = WORLD_SIZES.small;
    const params = { ...defaultWorldParams(data.worldgen.parameters, meta.seed, 'small'), size };
    const layers = generateWorld(params, data);
    const world = {
      size,
      layers,
      biomes: bakeBiomes(data.biomes.entries),
      riverBiome: data.biomes.indexOf('river') ?? -1,
    };
    const W = size.width * 4;
    const H = size.height * 4;
    const { vw, vh } = meta.cam;
    // Le pixel (0, 0) de l'écran, en pixels de carte : au zoom 1, une capture est la carte.
    const left = Math.floor(meta.cam.x - vw / 2);
    const top = Math.floor(meta.cam.y - vh / 2);
    const regionTop = Math.max(0, top);
    const regionBottom = Math.min(H, top + vh);
    const region = bakeRegion(world, ((left % W) + W) % W, regionTop, vw, regionBottom - regionTop);
    const texels = seasonTexels(size, layers, data.biomes.entries);
    // Les calendriers de la neige et de la glace, que le worker calcule et envoie (ADR 0019).
    const calendars = worldCalendars(size, layers, data.biomes.entries, data.seasons);
    const count = size.width * size.height;
    const season = Math.fround(seasonFactor(meta.month));
    const day = Math.fround(meta.month * DAYS_PER_MONTH);
    const covers = waveCovers(data.seasons);
    // Au zoom 1 sur PC, les ruisseaux ne se dessinent pas (STREAMS_SCALE).
    const view = { season, day, fine: true, natural: true, streams: false, covers };
    const noise = waveNoise();
    const table = waveTable(data.biomes.entries, 1);
    const rest = image(folder, 'rest.png');
    expect([rest.width, rest.height]).toEqual([vw, vh]);
    const pixelAt = (sx: number, sy: number): WavePixel | undefined => {
      const y = top + sy;
      if (y < 0 || y >= H) return undefined;
      const x = (((left + sx) % W) + W) % W;
      const o = ((y - regionTop) * vw + sx) * 4;
      const index = Math.floor(y / 4) * size.width + Math.floor(x / 4);
      const cell = index * 4;
      const at = iceAt(index, count);
      return {
        red: region[o] ?? 0,
        green: region[o + 1] ?? 0,
        blue: region[o + 2] ?? 0,
        temperature: texels[cell] ?? 0,
        amplitude: texels[cell + 1] ?? 0,
        flags: texels[cell + 2] ?? 0,
        calendar: calendars.subarray(at, at + 4),
      };
    };
    const result: Record<string, unknown> = { seed: meta.seed, month: meta.month, left, top };
    if (meta.base !== undefined) {
      const base = image(folder, meta.base);
      let differ = 0;
      for (let i = 0; i < vw * vh * 3; i += 3) {
        if (
          base.rgb[i] !== rest.rgb[i] ||
          base.rgb[i + 1] !== rest.rgb[i + 1] ||
          base.rgb[i + 2] !== rest.rgb[i + 2]
        ) {
          differ++;
        }
      }
      result.offVersusBase = { differ, of: vw * vh };
    }
    const steps: unknown[] = [];
    const examples: unknown[] = [];
    let compared = 0;
    let mismatch = 0;
    let moved = 0;
    let partial = 0;
    for (const { phase, file } of meta.steps) {
      const shot = image(folder, file);
      const [px = 0, py = 0, pc = 0, pr = 0] = phase;
      const frame = { table, noise, phase: [px, py, pc, pr] as const, worldPx: W };
      let stepMismatch = 0;
      let stepMoved = 0;
      for (let sy = 0; sy < vh; sy++) {
        for (let sx = 0; sx < vw; sx++) {
          const pixel = pixelAt(sx, sy);
          if (pixel === undefined) continue;
          const x = (((left + sx) % W) + W) % W;
          const y = top + sy;
          const i = (sy * vw + sx) * 3;
          const tone = wavePixel(frame, view, x, y, pixel);
          const want =
            tone === undefined
              ? [rest.rgb[i], rest.rgb[i + 1], rest.rgb[i + 2]]
              : [tone >>> 16, (tone >>> 8) & 255, tone & 255];
          compared++;
          if (tone !== undefined) stepMoved++;
          // Les pixels d'eau animée en calme partiel : la rampe du calme y décide.
          const color = (pixel.red << 16) | (pixel.green << 8) | pixel.blue;
          if ((pixel.red & 1) === 0 && table.biomes.some((b) => b.tones.includes(color))) {
            const ramp = waterRamp(pixel, covers);
            const calm =
              ramp === undefined ? 0 : waterCover32(pixel, ramp, season, day, covers.calmDays).calm;
            if (calm > 0 && calm < 1) partial++;
          }
          const got = [shot.rgb[i], shot.rgb[i + 1], shot.rgb[i + 2]];
          if (got.some((byte, k) => byte !== want[k])) {
            stepMismatch++;
            if (examples.length < 12) examples.push({ file, sx, sy, x, y, got, want, pixel });
          }
        }
      }
      mismatch += stepMismatch;
      moved += stepMoved;
      steps.push({ file, phase, mismatch: stepMismatch, moved: stepMoved });
    }
    // Au repos, chaque pixel d'eau libre montre sa couleur cuite : la capture est bien cadrée.
    let restMismatch = 0;
    for (let sy = 0; sy < vh; sy += 7) {
      for (let sx = 0; sx < vw; sx += 7) {
        const pixel = pixelAt(sx, sy);
        if (pixel === undefined || (pixel.red & 1) === 1) continue;
        const x = (((left + sx) % W) + W) % W;
        if (waveStill(view, x, top + sy, pixel) !== undefined) continue;
        const i = (sy * vw + sx) * 3;
        const shown = [rest.rgb[i], rest.rgb[i + 1], rest.rgb[i + 2]];
        if (shown.some((byte, k) => byte !== [pixel.red, pixel.green, pixel.blue][k])) {
          restMismatch++;
        }
      }
    }
    Object.assign(result, { compared, mismatch, moved, partial, restMismatch, steps, examples });
    writeFileSync(path.join(folder, 'result.json'), JSON.stringify(result, null, 1));
    expect(meta.steps.length).toBeGreaterThan(0);
    expect(moved).toBeGreaterThan(0);
    expect({ mismatch, restMismatch }).toEqual({ mismatch: 0, restMismatch: 0 });
    if (meta.base !== undefined) expect(result.offVersusBase).toMatchObject({ differ: 0 });
  });
});
