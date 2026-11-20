import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BODY_KINDS } from '../src/core/data/humans';
import { loadGameData } from '../src/core/data';
import { fabricTones } from '../src/render/looks';

// Les couleurs des humains sont des palettes de l'auteur, sans couleur nouvelle (ADR 0016) :
// SKIN et HAIR de son carnet, versé dans le dépôt (sprites/sprite_converter.ipynb), et CLOTH de
// Portrait64, que 2b.9 portera (avatargenerator/portrait64/palettes.py, « Palettes fournies par
// l'utilisateur, conservées sans modification »), recopié ici tel quel. Les palettes de l'auteur
// rangent leurs tons base, ombre, ombre profonde, lumière ; les données, lumière d'abord.

const root = fileURLToPath(new URL('..', import.meta.url));
const data = loadGameData();
const { appearance } = data;

/** Les dictionnaires de palettes d'une source Python : nom → tons, en minuscules. */
function pythonPalettes(source: string, name: string): Record<string, string[]> {
  const start = source.indexOf(`${name} = {`);
  if (start < 0) throw new Error(`palettes ${name} introuvables`);
  const body = source.slice(start, source.indexOf('}', start));
  const palettes: Record<string, string[]> = {};
  for (const [, key, tones] of body.matchAll(/"(\w+)":\s*\(([^)]*)\)/gu)) {
    palettes[key] = [...tones.matchAll(/#[0-9A-Fa-f]{6}/gu)].map(([tone]) => tone.toLowerCase());
  }
  return palettes;
}

const notebook = (
  JSON.parse(readFileSync(`${root}/sprites/sprite_converter.ipynb`, 'utf8')) as {
    cells: { source: string[] }[];
  }
).cells
  .map((cell) => cell.source.join(''))
  .join('\n');
const SKIN = pythonPalettes(notebook, 'SKIN');
const HAIR = pythonPalettes(notebook, 'HAIR');
const CLOTH = pythonPalettes(
  `CLOTH = {
    "foret": ("#647752", "#42543B", "#293A30", "#8D9D70"),
    "bordeaux": ("#964C54", "#703742", "#462A36", "#BD7470"),
    "marine": ("#526D8B", "#354963", "#263046", "#829CAF"),
    "ocre": ("#C2944C", "#906335", "#5B402B", "#E4BE75"),
    "violet": ("#85668E", "#604B70", "#3D324E", "#AF8EB1"),
    "lin": ("#D5C7AA", "#A99A82", "#746A60", "#F3E8CD"),
    "cuir": ("#916149", "#674233", "#422F2C", "#BD8660"),
    "charbon": ("#53555B", "#383A43", "#242630", "#7C8189"),
}`,
  'CLOTH',
);

/** Le nom de l'auteur de chaque rampe des données. */
const SKIN_OF: Record<string, string> = {
  xlight: 'tres_claire',
  light: 'claire',
  medium: 'medium',
  olive: 'olive',
  dark: 'brune',
  xdark: 'tres_brune',
};
const HAIR_OF: Record<string, string> = {
  black: 'noir',
  brown: 'chatain',
  blond: 'blond',
  red: 'roux',
  grey: 'gris',
  white: 'blanc',
};
const CLOTH_OF: Record<string, string> = {
  forest: 'foret',
  burgundy: 'bordeaux',
  navy: 'marine',
  ochre: 'ocre',
  violet: 'violet',
  linen: 'lin',
  leather: 'cuir',
  charcoal: 'charbon',
};
/**
 * Écarts déclarés : rampes des données qui ne sont pas des palettes de l'auteur, chacune nommée
 * dans la dernière section de l'ADR 0016. Aucune aujourd'hui.
 */
const DEVIATIONS = new Set<string>();

/** Une palette de l'auteur rangée comme les données : lumière, base, ombre, ombre profonde. */
const byRank = (tones: readonly string[]) => [tones[3], tones[0], tones[1], tones[2]];

describe('palettes de l’auteur (ADR 0016)', () => {
  it('lit les palettes du carnet de l’auteur : six peaux de quatre tons, huit cheveux de trois', () => {
    expect(Object.keys(SKIN)).toHaveLength(6);
    expect(Object.values(SKIN).every((tones) => tones.length === 4)).toBe(true);
    expect(Object.keys(HAIR)).toHaveLength(8);
    expect(Object.values(HAIR).every((tones) => tones.length === 3)).toBe(true);
    expect(Object.keys(CLOTH)).toHaveLength(8);
  });

  it('prend chaque palette de peau, chaque rampe de cheveux et de gris, chaque tissu chez l’auteur', () => {
    for (const palette of appearance.skinPalettes) {
      const name = `skinPalettes.${palette.id}`;
      if (DEVIATIONS.has(name)) continue;
      expect(SKIN_OF[palette.id], name).toBeDefined();
      expect(palette.tones, name).toEqual(byRank(SKIN[SKIN_OF[palette.id] ?? ''] ?? []));
    }
    for (const [group, ramps] of [
      ['hair', appearance.hair],
      ['greyRamps', appearance.greyRamps],
    ] as const) {
      for (const [id, tones] of Object.entries(ramps)) {
        const name = `${group}.${id}`;
        if (DEVIATIONS.has(name)) continue;
        expect(HAIR_OF[id], name).toBeDefined();
        expect(tones, name).toEqual(HAIR[HAIR_OF[id] ?? '']);
      }
    }
    for (const fabric of appearance.fabrics) {
      const name = `fabrics.${fabric.id}`;
      if (DEVIATIONS.has(name)) continue;
      expect(CLOTH_OF[fabric.id], name).toBeDefined();
      expect(fabric.tones, name).toEqual(byRank(CLOTH[CLOTH_OF[fabric.id] ?? ''] ?? []));
    }
  });

  it('grisonne par le gris de l’auteur, puis par son blanc', () => {
    expect(appearance.greying.map((step) => step.ramp)).toEqual(['grey', 'grey', 'white']);
    expect(appearance.greying.at(-1)?.ranks).toEqual([0, 1, 2, 3]);
  });
});

/** Écart OKLab de deux couleurs #rrggbb, ×100 (Björn Ottosson, 2020). */
export function deltaOk(a: string, b: string): number {
  const lab = (hex: string) => {
    const linear = [1, 3, 5].map((at) => {
      const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    const [r = 0, g = 0, bl = 0] = linear;
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * bl);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * bl);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * bl);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  };
  const [x, y] = [lab(a), lab(b)];
  return 100 * Math.hypot(...x.map((value, index) => value - (y[index] ?? 0)));
}

/**
 * Écart au-dessous duquel une pièce du torse, de même ton de base que la peau, la fait paraître
 * nue de loin (ADR 0016, § 3) : à trancher par l'auteur, planches à l'appui.
 */
export const CONTRAST = 15;
const TORSO = new Set(['chest', 'belly', 'hips']);

describe('contraste des tissus et des peaux (ADR 0016, § 3)', () => {
  it('ne pose sur le torse aucun tissu, rechange compris, trop proche de la peau qui le porte', () => {
    const close: string[] = [];
    for (const outfit of appearance.outfits) {
      for (const body of BODY_KINDS) {
        for (const piece of outfit[body]) {
          if (!piece.regions.some((region) => TORSO.has(region))) continue;
          appearance.skinPalettes.forEach((palette, index) => {
            const fabric = fabricTones(appearance, piece.fabric, index);
            const gap = deltaOk(fabric?.[1] ?? '#000000', palette.tones[1]);
            if (gap < CONTRAST) {
              close.push(
                `${outfit.id} (${body}) : ${piece.fabric} sur ${palette.id}, ${gap.toFixed(1)}`,
              );
            }
          });
        }
      }
    }
    expect(close).toEqual([]);
  });

  it('a besoin des tissus de rechange : sans eux, des pièces du torse se confondraient avec la peau', () => {
    let close = 0;
    for (const fabric of appearance.fabrics) {
      for (const palette of appearance.skinPalettes) {
        if (deltaOk(fabric.tones[1], palette.tones[1]) < CONTRAST) close++;
      }
    }
    expect(close).toBeGreaterThan(0);
    // Un tissu de rechange se détache toujours de la peau pour laquelle il est déclaré.
    for (const fabric of appearance.fabrics) {
      for (const [skin, spare] of Object.entries(fabric.onSkin ?? {})) {
        const palette = appearance.skinPalettes.find((entry) => entry.id === skin);
        const tones = appearance.fabrics.find((entry) => entry.id === spare)?.tones;
        expect(
          deltaOk(tones?.[1] ?? '#000000', palette?.tones[1] ?? '#000000'),
        ).toBeGreaterThanOrEqual(CONTRAST);
      }
    }
  });
});
