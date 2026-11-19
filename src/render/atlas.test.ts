import { describe, expect, it } from 'vitest';
import { loadGameData } from '../core/data';
import { ROLE } from '../core/visual';
import { frameOf, personPalette, recolor, recolorRoles } from './atlas';
import { parseColor, type Rgb } from './bake';
import { cultureOutfit, hairTones, outfitColor } from './looks';

const { appearance } = loadGameData();
const [light = [], dark = []] = [
  appearance.skinPalettes.at(0)?.tones,
  appearance.skinPalettes.at(-1)?.tones,
];
const linen = appearance.fabrics.find((fabric) => fabric.id === 'linen')?.tones ?? [];

/** Luminance relative d'une couleur, au sens des WCAG 2. */
function luminance(color: Rgb): number {
  const [red, green, blue] = color.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** Rapport de contraste de deux couleurs, au sens des WCAG 2 : de 1 à 21. */
function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

describe('recoloration (REN-09)', () => {
  it('remplace chaque rôle par sa couleur de même rang, et laisse le transparent', () => {
    const hair = hairTones(appearance, 'black', 0) ?? [];
    const palette = personPalette(appearance, { skin: light, hair, cloth: linen });
    const pixels = recolorRoles(
      [ROLE.transparent, ROLE.skin, ROLE.hair, ROLE.clothShadow, ROLE.skinLight],
      palette,
    );
    expect(Array.from(pixels.subarray(0, 4))).toEqual([0, 0, 0, 0]);
    // Lumière, base et ombre : les tons de rang 0, 1 et 2 des rampes, sans calcul.
    expect(Array.from(pixels.subarray(4, 7))).toEqual(parseColor(light[1] ?? ''));
    expect(Array.from(pixels.subarray(8, 11))).toEqual(parseColor(hair[1] ?? ''));
    expect(Array.from(pixels.subarray(12, 15))).toEqual(parseColor(linen[2] ?? ''));
    expect(Array.from(pixels.subarray(16, 19))).toEqual(parseColor(light[0] ?? ''));
  });

  it('sert un même motif à toutes les couleurs : la bannière d’un groupe', () => {
    const name = 'icons/group';
    const frame = frameOf(name);
    const one = recolor(name, personPalette(appearance, { skin: light, hair: [], cloth: linen }));
    const other = recolor(name, personPalette(appearance, { skin: dark, hair: [], cloth: dark }));
    expect(one).toHaveLength(frame.width * frame.height * 4);
    expect(Array.from(one)).not.toEqual(Array.from(other));
    // La même silhouette : les mêmes pixels opaques.
    for (let index = 3; index < one.length; index += 4) expect(one[index]).toBe(other[index]);
  });

  it('détache le fond des portraits du contour et des cheveux les plus sombres (A-11)', () => {
    const backdrop = parseColor(appearance.backdrop);
    const outline = parseColor(appearance.outline);
    // Le contour de la silhouette se voit sur le fond.
    expect(contrast(backdrop, outline)).toBeGreaterThanOrEqual(2);
    // L'ombre des cheveux les plus sombres aussi, gris compris : la tête garde sa silhouette.
    const shadows = Object.keys(appearance.hair).flatMap((allele) =>
      [0, 1, 2, 3].map((grey) => parseColor(hairTones(appearance, allele, grey)?.[2] ?? '#000000')),
    );
    expect(shadows.length).toBeGreaterThan(0);
    const darkest = shadows.reduce((a, b) => (luminance(b) < luminance(a) ? b : a));
    expect(contrast(backdrop, darkest)).toBeGreaterThanOrEqual(2);
  });

  it('habille les cultures à tour de rôle, et en tire la couleur de leur bannière', () => {
    const { cultureOutfits, outfits } = appearance;
    const index = (id: string | undefined) => outfits.findIndex((outfit) => outfit.id === id);
    expect(cultureOutfit(appearance, 1)).toBe(index(cultureOutfits[0]));
    expect(cultureOutfit(appearance, 0)).toBe(index(cultureOutfits[0]));
    expect(cultureOutfit(appearance, 2)).toBe(index(cultureOutfits[1]));
    expect(cultureOutfit(appearance, cultureOutfits.length + 1)).toBe(index(cultureOutfits[0]));
    // La bannière prend le premier tissu de la tenue, tel quel ; le portrait, sur sa peau.
    const first = outfits[0]?.female[0]?.fabric;
    expect(outfitColor(appearance, 0, 'female')).toEqual(
      appearance.fabrics.find((fabric) => fabric.id === first)?.tones,
    );
  });
});
