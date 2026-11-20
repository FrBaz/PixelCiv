/**
 * Contrôle des pixels des humains (ADR 0016, § 9 ; tools/human-control/LISEZMOI.md). Vitest ne
 * voit pas le shader des palettes : ce contrôle compare, pixel à pixel, des captures de Chromium
 * (capture.cjs) à ce que doit peindre chaque particule des humains, du fond vers l'avant : le
 * rôle de chaque pixel de son motif, lu dans l'atlas des rôles du build (src/render/humans.ts),
 * puis la couleur de ce rôle dans la palette de sa place, au texel de paletteTexel de la
 * texture des palettes que le CPU a écrite, à la densité k de la vue, retourné s'il le faut.
 * Hors de la suite des tests, il se lance par `npx vitest run --mode human-control`, avec
 * CONTROL_DIR, le dossier des captures : une vue par sous-dossier qui a son meta.json. Chaque
 * vue écrit son result.json à côté de ses captures.
 *
 * Il vérifie, pour chaque vue : le shader des humains posé, l'atlas des rôles de la page égal à
 * celui du build ; aucun pixel des humains qui diffère (`mismatch`, attendu à 0) ; aucun rôle
 * sans couleur dans sa palette (`undeclared`, à 0) ; et aucune erreur de la page. Il compte les
 * pixels comparés, les particules retournées et la plus haute place, pour qu'une vue vide ne
 * passe pas pour un succès ; sur l'ensemble des vues, il veut une place au-delà de 255 (la
 * texture doublée deux fois), k = 1 et k = 2, et les deux densités d'écran.
 *
 * Calque commun (tâche 2b.6, ADR 0017, § 7) : le décor est fait de particules du même conteneur,
 * dont les motifs se rangent sous ceux des humains dans la même texture des rôles. Leurs pixels
 * se comparent de même, dans l'ordre du dessin, au rôle lu dans l'atlas du décor du build
 * (src/render/decor.ts) ; seuls les pixels de leur ombre portée, que l'ombre « ground » peint
 * du ton du sol et non de la palette, ne se comparent pas : ils cachent ce qui est dessous.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  colorSlot,
  FIRST_PALETTE_ROWS,
  PALETTE_WIDTH,
  PALETTES_PER_ROW,
  paletteTexel,
} from '../../src/render/humanShader';
import { ATLAS_ROLES, humanAtlas } from '../../src/render/humans';
import { DECOR_ATLAS, SHADOW_ROLES } from '../../src/render/decor';

/** Le rôle du pixel (x, y) de la texture des rôles commune : les humains, puis le décor. */
function roleAt(x: number, y: number): number {
  if (y < humanAtlas.height) return ATLAS_ROLES[y * humanAtlas.width + x] ?? 0;
  return DECOR_ATLAS.roles[(y - humanAtlas.height) * DECOR_ATLAS.width + x] ?? 0;
}
const SHADOWS: ReadonlySet<number> = new Set(SHADOW_ROLES);
/** Un pixel qu'une ombre portée recouvre : rien ne s'y compare. */
const UNKNOWN = -2;

/** Ce que capture.cjs écrit dans le meta.json de chaque vue. */
interface Meta {
  readonly name: string;
  readonly device: string;
  readonly zoom: number;
  readonly crowd: number;
  /** Nom du programme posé sur les particules des humains, tel que PixiJS l'écrit dans sa source. */
  readonly shader: string;
  /** Tampon WebGL, en pixels physiques, et densité de l'écran. */
  readonly width: number;
  readonly height: number;
  readonly resolution: number;
  /** Rangées que lit le shader, et taille de la texture des palettes. */
  readonly rows: number;
  readonly paletteWidth: number;
  readonly paletteHeight: number;
  readonly atlasWidth: number;
  readonly atlasHeight: number;
  /**
   * Une particule par entrée, dans l'ordre du dessin : son cadre dans l'atlas des rôles (x, y,
   * largeur, hauteur), sa place (x, y, en pixels CSS), ses échelles et sa couleur.
   */
  readonly particles: readonly (readonly number[])[];
  readonly errors: readonly string[];
}

interface Result {
  readonly particles: number;
  /** Particules et pixels comparés du décor. */
  readonly objects: number;
  readonly comparedObjects: number;
  readonly compared: number;
  readonly mismatch: number;
  readonly undeclared: number;
  readonly flipped: number;
  readonly maxSlot: number;
  readonly densities: readonly number[];
  readonly samples: readonly string[];
}

const root = process.env.CONTROL_DIR ?? '';
const views = root === '' ? [] : [root, ...readdirSync(root).map((name) => path.join(root, name))];
const folders = views.filter((folder) => existsSync(path.join(folder, 'meta.json')));

const hex = (color: number) => `#${color.toString(16).padStart(6, '0')}`;

/** Compare la capture d'une vue à ce que doit peindre chacune de ses particules. */
function compare(meta: Meta, frame: Uint8Array, palettes: Uint8Array): Result {
  const { width, height, resolution } = meta;
  const expected = new Int32Array(width * height).fill(-1);
  /** Le pixel attendu vient-il d'un objet du décor ? */
  const fromObject = new Uint8Array(width * height);
  let objects = 0;
  let undeclared = 0;
  let flipped = 0;
  let maxSlot = 0;
  const densities = new Set<number>();
  for (const particle of meta.particles) {
    const [fx = 0, fy = 0, fw = 0, fh = 0, x = 0, y = 0, scaleX = 1, , color = 0] = particle;
    const slot = colorSlot(color);
    const object = fy >= humanAtlas.height;
    if (object) objects++;
    maxSlot = Math.max(maxSlot, slot);
    const k = Math.round(Math.abs(scaleX) * resolution);
    densities.add(k);
    const flip = scaleX < 0;
    if (flip) flipped++;
    // Un motif retourné s'étend vers la gauche de sa place, autour de son bord droit.
    const left = Math.round((flip ? x + fw * scaleX : x) * resolution);
    const top = Math.round(y * resolution);
    for (let v = 0; v < fh; v++) {
      for (let u = 0; u < fw; u++) {
        const role = roleAt(fx + u, fy + v);
        if (role === 0) continue;
        const { column, row } = paletteTexel(slot, role);
        const at = (row * PALETTE_WIDTH + column) * 4;
        const shadow = object && SHADOWS.has(role);
        if (!shadow && (palettes[at + 3] ?? 0) !== 255) undeclared++;
        const rgb = shadow
          ? UNKNOWN
          : ((palettes[at] ?? 0) << 16) | ((palettes[at + 1] ?? 0) << 8) | (palettes[at + 2] ?? 0);
        const sx = left + (flip ? fw - 1 - u : u) * k;
        const sy = top + v * k;
        for (let dy = 0; dy < k; dy++) {
          for (let dx = 0; dx < k; dx++) {
            const px = sx + dx;
            const py = sy + dy;
            if (px >= 0 && px < width && py >= 0 && py < height) {
              expected[py * width + px] = rgb;
              fromObject[py * width + px] = object ? 1 : 0;
            }
          }
        }
      }
    }
  }
  let compared = 0;
  let comparedObjects = 0;
  let mismatch = 0;
  const samples: string[] = [];
  for (let index = 0; index < width * height; index++) {
    const want = expected[index] ?? -1;
    if (want < 0) continue;
    compared++;
    if (fromObject[index] === 1) comparedObjects++;
    const got =
      ((frame[index * 4] ?? 0) << 16) |
      ((frame[index * 4 + 1] ?? 0) << 8) |
      (frame[index * 4 + 2] ?? 0);
    if (got === want) continue;
    mismatch++;
    if (samples.length < 8) {
      samples.push(
        `(${String(index % width)}, ${String(Math.floor(index / width))}) ${hex(got)} au lieu de ${hex(want)}`,
      );
    }
  }
  return {
    particles: meta.particles.length,
    objects,
    comparedObjects,
    compared,
    mismatch,
    undeclared,
    flipped,
    maxSlot,
    densities: [...densities].sort((a, b) => a - b),
    samples,
  };
}

describe('pixels des humains dans Chromium (ADR 0016, § 9)', () => {
  it('a des captures à comparer (CONTROL_DIR)', () => {
    expect(folders.length, 'CONTROL_DIR : aucune vue capturée').toBeGreaterThan(0);
  });

  const all: { meta: Meta; result: Result }[] = [];
  for (const folder of folders) {
    it(`peint chaque pixel des humains de la couleur de son rôle dans sa palette : ${path.basename(folder)}`, () => {
      const meta = JSON.parse(readFileSync(path.join(folder, 'meta.json'), 'utf8')) as Meta;
      const frame = readFileSync(path.join(folder, 'frame.rgba'));
      const palettes = readFileSync(path.join(folder, 'palettes.rgba'));
      expect(meta.errors).toEqual([]);
      expect(meta.shader).toMatch(/^pixelciv-humans-fragment/);
      // La texture des rôles commune : les humains, puis le décor (ADR 0017, § 7).
      expect([meta.atlasWidth, meta.atlasHeight]).toEqual([
        humanAtlas.width,
        humanAtlas.height + DECOR_ATLAS.height,
      ]);
      expect([meta.paletteWidth, meta.paletteHeight]).toEqual([PALETTE_WIDTH, meta.rows]);
      expect(frame.length).toBe(meta.width * meta.height * 4);
      expect(palettes.length).toBe(PALETTE_WIDTH * meta.rows * 4);
      const result = compare(meta, frame, palettes);
      writeFileSync(path.join(folder, 'result.json'), JSON.stringify(result, null, 1));
      all.push({ meta, result });
      expect(result.samples).toEqual([]);
      expect(result.mismatch).toBe(0);
      expect(result.undeclared).toBe(0);
      expect(result.particles).toBeGreaterThan(50);
      expect(result.compared).toBeGreaterThan(5000);
      // Le décor de la vue, en mode naturel, comparé comme les humains.
      expect(result.objects).toBeGreaterThan(20);
      expect(result.comparedObjects).toBeGreaterThan(5000);
      expect(result.flipped).toBeGreaterThan(0);
      expect(result.maxSlot).toBeLessThan(meta.rows * PALETTES_PER_ROW);
    });
  }

  it('couvre des places au-delà de 255, k = 1 et k = 2, et les deux densités d’écran', () => {
    expect(all.length).toBe(folders.length);
    const slots = Math.max(...all.map(({ result }) => result.maxSlot));
    expect(slots).toBeGreaterThan(255);
    expect(Math.max(...all.map(({ meta }) => meta.rows))).toBeGreaterThanOrEqual(
      FIRST_PALETTE_ROWS * 4,
    );
    const densities = new Set(all.flatMap(({ result }) => result.densities));
    expect(densities.has(1) && densities.has(2)).toBe(true);
    expect(new Set(all.map(({ meta }) => meta.resolution)).size).toBeGreaterThan(1);
  });
});
