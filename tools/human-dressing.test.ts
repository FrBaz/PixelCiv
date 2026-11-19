import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { geneRoles } from '../src/core/data/people';
import { BODY_KINDS } from '../src/core/data/humans';
import { loadGameData } from '../src/core/data';
import { parseRegionGrids, type RoleImage } from '../src/gen/humans';
import { humanPalette, sheetPalette, type HumanPalette } from '../src/render/humans';
import { loadHumans, sheetFrames } from './human-atlas';
import { decodeRgba } from './png';

// L'habillage au pixel près (ADR 0016, § 3) : chaque image de chaque animation des deux planches,
// au niveau de la planche à sa taille, habillée de chaque tenue sur chaque peau, comparée à la
// planche de base. Ce que le jeu peint doit être, pixel pour pixel, ce que la planche et les
// données disent : un ton gardé reste celui de la planche ; un ton de peau ou de sous-vêtement
// prend le ton de même rang du tissu de la dernière pièce qui couvre sa région (ou de son tissu
// de rechange sur cette peau), des cheveux au crâne, sinon de la palette de peau. L'oracle se
// calcule ici, des seules données, sans les fonctions du rendu.

const root = fileURLToPath(new URL('..', import.meta.url));
const humans = loadHumans(root);
const data = loadGameData();
const { appearance } = data;
const hairIds = (data.genetics.loci[geneRoles(data.genetics).loci.hair]?.alleles ?? []).map(
  (allele) => allele.id,
);
const sexes = ['female', 'male'] as const;
const sheets = Object.fromEntries(
  sexes.map((sex) => [sex, decodeRgba(readFileSync(`${root}/${humans.sheets[sex]}`))]),
) as Record<(typeof sexes)[number], ReturnType<typeof decodeRgba>>;
const frames = Object.fromEntries(
  sexes.map((sex) => [sex, sheetFrames(root, humans, sex)]),
) as Record<(typeof sexes)[number], RoleImage[][]>;
const letters = humans.regions.map((region) => region.letter).join('');
const grids = Object.fromEntries(
  sexes.map((sex) => [
    sex,
    humans.animations.map(
      (animation) =>
        parseRegionGrids(
          animation.id,
          readFileSync(`${root}/assets/humans/regions/${sex}/${animation.id}.txt`, 'utf8'),
          humans.cell.width,
          humans.cell.height,
          letters,
        ).frames,
    ),
  ]),
) as Record<(typeof sexes)[number], (readonly (readonly string[])[])[]>;

const hex = (rgba: Uint8Array, at: number) =>
  `#${[0, 1, 2].map((i) => (rgba[at + i] ?? 0).toString(16).padStart(2, '0')).join('')}`;
const colorOf = (palette: HumanPalette, role: number) => {
  const color = palette[role];
  return color === undefined
    ? undefined
    : `#${color.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
};

/** Rang de chaque ton de peau ou de sous-vêtement de la base ; les tons gardés. */
const { outline, eye, kept, skin, under, skinAlso, underAlso } = humans.tones;
const rankOf = new Map<string, number>([
  ...[...skin, ...under].map((tone, index): [string, number] => [tone, index % 4]),
  ...Object.entries(skinAlso),
  ...Object.entries(underAlso),
]);
const keptTones = new Set([...outline, ...eye, ...kept]);
const hairRegion = humans.regions.find((region) => region.hair === true)?.id;

/** Les tons qu'attend chaque région d'une tenue sur un corps et une peau, d'après les données. */
function expected(outfit: number, body: (typeof BODY_KINDS)[number], skinPalette: number) {
  const palette = appearance.skinPalettes[skinPalette];
  const pieces = appearance.outfits[outfit]?.[body] ?? [];
  const tones = new Map<string, readonly string[]>();
  for (const region of humans.regions) {
    const piece = pieces.findLast((candidate) => candidate.regions.includes(region.id));
    if (piece === undefined) {
      const hair = appearance.hair[hairIds[1] ?? ''] ?? [];
      tones.set(
        region.id,
        region.id === hairRegion ? [hair[0], hair[1], hair[2], hair[2]].map(String) : palette.tones,
      );
      continue;
    }
    const fabric = appearance.fabrics.find((entry) => entry.id === piece.fabric);
    const spare = fabric?.onSkin?.[palette.id];
    const worn =
      spare === undefined ? fabric : appearance.fabrics.find((entry) => entry.id === spare);
    tones.set(region.id, worn?.tones ?? []);
  }
  return tones;
}

describe('habillage des planches, pixel pour pixel (ADR 0016, § 3)', () => {
  it('redonne la planche de l’auteur sans tenue, crâne en peau : chaque pixel, chaque image', () => {
    const palette = sheetPalette();
    for (const sex of sexes) {
      const { rgba, width } = sheets[sex];
      let wrong = 0;
      let checked = 0;
      humans.animations.forEach((animation, a) => {
        frames[sex][a]?.forEach((image, f) => {
          for (let y = 0; y < image.height; y++) {
            for (let x = 0; x < image.width; x++) {
              const at =
                ((animation.row * humans.cell.height + y) * width + f * humans.cell.width + x) * 4;
              const role = image.roles[y * image.width + x] ?? 0;
              if ((rgba[at + 3] ?? 0) === 0) {
                if (role !== 0) wrong++;
                continue;
              }
              checked++;
              const tone = hex(rgba, at);
              // Les joues et le point du haut prennent le ton de leur rang : les seuls écarts.
              const also = Object.hasOwn(skinAlso, tone)
                ? skinAlso[tone]
                : Object.hasOwn(underAlso, tone)
                  ? underAlso[tone]
                  : undefined;
              const want =
                also === undefined
                  ? tone
                  : Object.hasOwn(skinAlso, tone)
                    ? skin[also]
                    : under[also];
              if (colorOf(palette, role) !== want) wrong++;
            }
          }
        });
      });
      expect(wrong, sex).toBe(0);
      expect(checked, sex).toBeGreaterThan(15_000);
    }
  });

  it('habille chaque image, de chaque tenue, sur chaque peau : tons gardés intacts, tissu ou peau au rang de la planche', () => {
    const brown = hairIds.indexOf(hairIds[1] ?? '');
    for (const sex of sexes) {
      const { rgba, width } = sheets[sex];
      appearance.outfits.forEach((_, outfit) => {
        appearance.skinPalettes.forEach((__, skinPalette) => {
          const palette = humanPalette(appearance, hairIds, {
            skin: skinPalette,
            hair: brown,
            grey: 0,
            outfit,
            body: sex,
          });
          const tones = expected(outfit, sex, skinPalette);
          const problems: string[] = [];
          humans.animations.forEach((animation, a) => {
            frames[sex][a]?.forEach((image, f) => {
              const grid = grids[sex][a]?.[f] ?? [];
              for (let y = 0; y < image.height; y++) {
                for (let x = 0; x < image.width; x++) {
                  const at =
                    ((animation.row * humans.cell.height + y) * width + f * humans.cell.width + x) *
                    4;
                  if ((rgba[at + 3] ?? 0) === 0) continue;
                  const tone = hex(rgba, at);
                  const actual = colorOf(palette, image.roles[y * image.width + x] ?? 0);
                  let want: string | undefined;
                  if (keptTones.has(tone)) want = tone;
                  else {
                    const region = humans.regions[letters.indexOf(grid[y]?.[x] ?? '.')]?.id ?? '';
                    want = tones.get(region)?.[rankOf.get(tone) ?? -1];
                  }
                  if (actual !== want && problems.length < 5) {
                    problems.push(
                      `${animation.id} ${String(f)} (${String(x)}, ${String(y)}) : ${String(actual)} au lieu de ${String(want)}`,
                    );
                  }
                }
              }
            });
          });
          expect(
            problems,
            `${sex}, ${appearance.outfits[outfit]?.id ?? ''}, ${appearance.skinPalettes[skinPalette]?.id ?? ''}`,
          ).toEqual([]);
        });
      });
    }
  });

  it('ne laisse jamais voir le sous-vêtement des planches, ni sur la planche ni réduit', () => {
    const underTones = new Set(under.concat(Object.keys(underAlso)));
    for (const sex of sexes) {
      appearance.outfits.forEach((outfit, index) => {
        const palette = humanPalette(appearance, hairIds, {
          skin: 2,
          hair: 0,
          grey: 0,
          outfit: index,
          body: sex,
        });
        const shown = new Set<string>();
        for (const animation of frames[sex]) {
          for (const image of animation) {
            for (const role of image.roles) {
              const color = colorOf(palette, role);
              if (color !== undefined && underTones.has(color)) shown.add(color);
            }
          }
        }
        expect([...shown], `${sex}, ${outfit.id}`).toEqual([]);
      });
    }
  });
});
