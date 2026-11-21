/**
 * Contrôle des pixels des couleurs de la saison (ADR 0019, § 8 ; tools/season-control/LISEZMOI.md).
 * Vitest ne voit pas le shader : ce contrôle compare, pixel à pixel, des captures de Chromium
 * (capture.cjs) au miroir TypeScript du code des saisons (src/render/seasonMirror.ts), appliqué à
 * la cuisson réelle du même monde et à sa carte d'identité des tons. Hors de la suite des tests,
 * il se lance par `npx vitest run --mode season-control`, avec CONTROL_DIR, le dossier des
 * captures : une vue par sous-dossier qui a son meta.json. Chaque vue écrit son result.json.
 *
 * Il vérifie, pour chaque vue :
 * - que le cran coupé rend la carte d'avant le second temps de 2b.7 à l'identique
 *   (`offVersusBase.differ`, attendu à 0), si la vue en a une capture ;
 * - que chaque pixel des crans plein et atténué vaut ce que dit le miroir : le ton de l'état ou de
 *   l'hiver, de même rang, sous l'ombrage et la teinte de la cuisson, ou le pixel du cran coupé ;
 *   un pixel que couvrent la neige ou la glace garde sa couverture. Le produit du ton, de
 *   l'ombrage et de la teinte tombe parfois sur une demie : le GPU et le miroir l'arrondissent
 *   alors chacun de son côté, d'une unité au plus (`mismatch`, compté) ; au-delà, rien
 *   (`far`, attendu à 0) ;
 * - que le cran atténué ne montre jamais la lumière d'hiver (`reducedLight`, attendu à 0).
 * Il compte les pixels que le miroir change, pour qu'une vue sans saison ne passe pas pour un
 * succès : au cœur de l'été, aucun ne change, et la vue doit le dire.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../src/core/data';
import { worldFoliage } from '../../src/core/foliage';
import { seasonFactor } from '../../src/core/seasons';
import { DAYS_PER_MONTH } from '../../src/core/time';
import { WORLD_SIZES } from '../../src/core/world';
import { defaultWorldParams } from '../../src/core/worldParams';
import { bakeBiomes, bakeRegion } from '../../src/render/bake';
import {
  mirrorPhase,
  mirrorState,
  seasonFarPixel,
  seasonPixel,
} from '../../src/render/seasonMirror';
import { EXACT_SCALE } from '../../src/render/seasonShader';
import { foliageTexels, seasonTexels, statePalettes } from '../../src/render/seasons';
import { leafThreshold } from '../../src/core/foliage';
import { generateWorld } from '../../src/worldgen/generate';
import { decodePng, type RgbImage } from '../wave-control/png';

/** Ce que capture.cjs écrit dans le meta.json de chaque vue. */
interface Meta {
  readonly seed: string;
  readonly month: number;
  /** Le zoom des captures : 1, ou moins pour une vue de loin (la branche des mipmaps). */
  readonly zoom?: number;
  readonly cam: {
    readonly x: number;
    readonly y: number;
    readonly vw: number;
    readonly vh: number;
    readonly scale: number;
  };
  readonly shots: {
    readonly full: { readonly file: string };
    readonly reduced: { readonly file: string };
    readonly off: { readonly file: string };
    readonly base?: { readonly file: string };
  };
}

const root = process.env.CONTROL_DIR ?? '';
const views = root === '' ? [] : [root, ...readdirSync(root).map((name) => path.join(root, name))];
const folders = views.filter((folder) => existsSync(path.join(folder, 'meta.json')));

const image = (folder: string, file: string): RgbImage =>
  decodePng(readFileSync(path.join(folder, file)));

describe('contrôle des pixels des couleurs de la saison (ADR 0019)', () => {
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
    const identity = new Uint8Array(vw * (regionBottom - regionTop));
    const region = bakeRegion(
      world,
      ((left % W) + W) % W,
      regionTop,
      vw,
      regionBottom - regionTop,
      identity,
    );
    const foliage = worldFoliage(size, layers, {
      foliage: data.decor.foliage,
      seasons: data.seasons,
    });
    const textures = {
      columns: size.width,
      rows: size.height,
      data: seasonTexels(size, layers, data.biomes.entries),
      foliage: foliageTexels(foliage, layers, data.biomes.entries),
      states: statePalettes(data.biomes.entries, data.seasons.light),
    };
    const day = Math.fround(meta.month * DAYS_PER_MONTH);
    // uSeason, le facteur de saison que la carte envoie (map.ts, setSeason), en flottant de 32 bits.
    const season = Math.fround(seasonFactor(meta.month));
    const dry = data.decor.foliage;
    const transition = data.seasons.minTransition;
    const shots = {
      full: image(folder, meta.shots.full.file),
      reduced: image(folder, meta.shots.reduced.file),
      off: image(folder, meta.shots.off.file),
    };
    if ((meta.zoom ?? 1) < 1) {
      // De loin (relecture de 2b.7, problème 2) : chaque pixel de l'écran lit, au niveau 0 des
      // mipmaps (une échelle entre 0,71 et 1), un pixel de carte que la caméra situe à un pixel
      // près. Un pixel changé doit venir d'un pixel qui porte un ton de terre, et valoir ce que dit
      // le miroir (de près dès EXACT_SCALE, de loin sous elle) pour l'un des pixels possibles.
      const { scale } = meta.cam;
      const margin = 3;
      const spanX = Math.ceil(vw / scale) + 2 * margin;
      const farLeft = Math.floor(meta.cam.x - vw / 2 / scale) - margin;
      const farTop = Math.max(0, Math.floor(meta.cam.y - vh / 2 / scale) - margin);
      const farBottom = Math.min(H, Math.ceil(meta.cam.y + vh / 2 / scale) + margin);
      const rows = farBottom - farTop;
      const farIdentity = new Uint8Array(spanX * rows);
      const farRegion = bakeRegion(
        world,
        ((farLeft % W) + W) % W,
        farTop,
        spanX,
        rows,
        farIdentity,
      );
      const local = (wx: number) => (((wx - farLeft) % W) + W) % W;
      const codeAt = (wx: number, wy: number) => {
        const lx = local(wx);
        if (lx >= spanX || wy < farTop || wy >= farBottom) return 0;
        return farIdentity[(wy - farTop) * spanX + lx] ?? 0;
      };
      const texelAt = (wx: number, wy: number) => {
        const o = ((wy - farTop) * spanX + local(wx)) * 4;
        return farRegion.subarray(o, o + 4);
      };
      const counts = { changed: 0, matched: 0, waterChanged: 0, blueChanged: 0 };
      const examples: unknown[] = [];
      for (const [level, light] of [
        ['full', true],
        ['reduced', false],
      ] as const) {
        const shot = shots[level];
        const uniforms = { day, season, transition, light, dry };
        for (let sy = 0; sy < vh; sy++) {
          for (let sx = 0; sx < vw; sx++) {
            const i = (sy * vw + sx) * 3;
            const got = [shot.rgb[i] ?? 0, shot.rgb[i + 1] ?? 0, shot.rgb[i + 2] ?? 0];
            const off = [
              shots.off.rgb[i] ?? 0,
              shots.off.rgb[i + 1] ?? 0,
              shots.off.rgb[i + 2] ?? 0,
            ];
            if (got.every((byte, k) => byte === off[k])) continue;
            counts.changed++;
            if ((off[2] ?? 0) > (off[0] ?? 0) + 40 && (off[2] ?? 0) > (off[1] ?? 0)) {
              counts.blueChanged++;
            }
            const mx = Math.floor(meta.cam.x + (sx + 0.5 - vw / 2) / scale);
            const my = Math.floor(meta.cam.y + (sy + 0.5 - vh / 2) / scale);
            let land = false;
            let matched = false;
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const wx = (((mx + dx) % W) + W) % W;
                const wy = my + dy;
                if (wy < farTop || wy >= farBottom) continue;
                const texel = texelAt(wx, wy);
                // De EXACT_SCALE à 1, le GPU lit des pixels cuits et le code des saisons passe par
                // la carte d'identité, comme de près ; plus loin, par les tons moyens.
                const color =
                  scale >= EXACT_SCALE
                    ? seasonPixel(textures, uniforms, 0, 0, wx, wy, texel, codeAt(wx, wy), false)
                    : seasonFarPixel(textures, uniforms, 0, 0, wx, wy, texel, codeAt, false);
                if (color === undefined) continue;
                land = true;
                if (color.every((byte, k) => Math.abs(byte - (got[k] ?? 0)) <= 1)) matched = true;
              }
            }
            if (!land) {
              counts.waterChanged++;
              if (examples.length < 12) examples.push({ level, sx, sy, mx, my, got, off });
            }
            if (matched) counts.matched++;
          }
        }
      }
      const farResult = {
        seed: meta.seed,
        month: meta.month,
        zoom: meta.zoom,
        ...counts,
        examples,
      };
      writeFileSync(path.join(folder, 'result.json'), JSON.stringify(farResult, null, 1));
      // Aucun pixel d'eau, de rivière ni de rive (aucune case sans tons de terre) ne change, et
      // aucun pixel bleu du cran coupé ; presque tous valent le miroir de loin.
      expect(counts.changed).toBeGreaterThan(0);
      expect({ water: counts.waterChanged, blue: counts.blueChanged }).toEqual({
        water: 0,
        blue: 0,
      });
      expect(counts.matched).toBeGreaterThanOrEqual(counts.changed * 0.99);
      return;
    }
    const result: Record<string, unknown> = { seed: meta.seed, month: meta.month, left, top };
    const base = meta.shots.base;
    if (base !== undefined) {
      const before = image(folder, base.file);
      let differ = 0;
      for (let i = 0; i < vw * vh * 3; i++) if (before.rgb[i] !== shots.off.rgb[i]) differ++;
      result.offVersusBase = { differ, of: vw * vh * 3 };
    }
    const examples: unknown[] = [];
    const counts = { compared: 0, changed: 0, mismatch: 0, far: 0, covered: 0, reducedLight: 0 };
    for (const [level, light] of [
      ['full', true],
      ['reduced', false],
    ] as const) {
      const shot = shots[level];
      for (let sy = 0; sy < vh; sy++) {
        const y = top + sy;
        if (y < 0 || y >= H) continue;
        for (let sx = 0; sx < vw; sx++) {
          const x = (((left + sx) % W) + W) % W;
          const o = ((y - regionTop) * vw + sx) * 4;
          const texel = region.subarray(o, o + 4);
          const i = (sy * vw + sx) * 3;
          const off = [shots.off.rgb[i] ?? 0, shots.off.rgb[i + 1] ?? 0, shots.off.rgb[i + 2] ?? 0];
          // Un pixel de terre que la neige ou la glace couvre ne montre pas son ton cuit.
          const land = (texel[0] & 1) === 1;
          const covered = land && off.some((byte, k) => byte !== texel[k]);
          if (covered) counts.covered++;
          const code = identity[(y - regionTop) * vw + sx] ?? 0;
          const color = seasonPixel(
            textures,
            { day, season, transition, light, dry },
            0,
            0,
            x,
            y,
            texel,
            code,
            covered,
          );
          const want = color ?? off;
          const got = [shot.rgb[i] ?? 0, shot.rgb[i + 1] ?? 0, shot.rgb[i + 2] ?? 0];
          counts.compared++;
          if (color !== undefined) counts.changed++;
          if (got.some((byte, k) => byte !== want[k])) {
            counts.mismatch++;
            const far = got.some((byte, k) => Math.abs(byte - (want[k] ?? 0)) > 1);
            if (far) counts.far++;
            if (far || examples.length < 6) {
              if (examples.length < 12)
                examples.push({ level, sx, sy, x, y, got, want, code, off });
            }
          }
          // Le cran atténué ne montre jamais la lumière d'hiver.
          if (level === 'reduced' && land && !covered && code !== 0) {
            const cell = (Math.floor(y / 4) * size.width + Math.floor(x / 4)) * 4;
            const south = ((textures.data[cell + 2] ?? 0) & 1) === 1;
            const state = mirrorState(
              textures.foliage,
              cell,
              mirrorPhase(day, south),
              leafThreshold(x, y),
              { day, season, transition, light: false, dry },
              south,
            );
            if (state === 3) counts.reducedLight++;
          }
        }
      }
    }
    Object.assign(result, counts, { examples });
    writeFileSync(path.join(folder, 'result.json'), JSON.stringify(result, null, 1));
    expect(counts.compared).toBeGreaterThan(0);
    expect({ far: counts.far, reducedLight: counts.reducedLight }).toEqual({
      far: 0,
      reducedLight: 0,
    });
    // Les demies arrondies d'un côté ou de l'autre restent rares.
    expect(counts.mismatch).toBeLessThanOrEqual(Math.max(16, counts.changed * 0.005));
    if (base !== undefined) expect(result.offVersusBase).toMatchObject({ differ: 0 });
  });
});
