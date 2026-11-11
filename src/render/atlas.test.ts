import { describe, expect, it } from 'vitest';
import { loadGameData } from '../core/data';
import { ROLE } from '../core/visual';
import { cultureCloth, frameOf, personPalette, recolor, recolorRoles, skinColor } from './atlas';
import { parseColor, type Rgb } from './bake';

const { appearance, genetics } = loadGameData();

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
  it('remplace chaque rôle par sa couleur, et laisse le transparent', () => {
    const palette = personPalette(appearance, {
      skin: [200, 150, 120],
      hair: [40, 30, 20],
      cloth: [100, 80, 60],
    });
    const pixels = recolorRoles(
      [ROLE.transparent, ROLE.skin, ROLE.hair, ROLE.clothShadow],
      palette,
    );
    expect(Array.from(pixels.subarray(0, 4))).toEqual([0, 0, 0, 0]);
    expect(Array.from(pixels.subarray(4, 8))).toEqual([200, 150, 120, 255]);
    expect(Array.from(pixels.subarray(8, 12))).toEqual([40, 30, 20, 255]);
    // L'ombre de l'habit est plus sombre que sa base.
    expect(pixels.at(12)).toBeLessThan(100);
  });

  it('sert un même motif à tous les teints', () => {
    const name = 'sprites/adult-female-0';
    const frame = frameOf(name);
    const light = recolor(
      name,
      personPalette(appearance, {
        skin: skinColor(appearance, 0),
        hair: [0, 0, 0],
        cloth: [0, 0, 0],
      }),
    );
    const dark = recolor(
      name,
      personPalette(appearance, {
        skin: skinColor(appearance, 1),
        hair: [0, 0, 0],
        cloth: [0, 0, 0],
      }),
    );
    expect(light).toHaveLength(frame.width * frame.height * 4);
    expect(Array.from(light)).not.toEqual(Array.from(dark));
    // La même silhouette : les mêmes pixels opaques.
    for (let index = 3; index < light.length; index += 4) expect(light[index]).toBe(dark[index]);
  });

  it('parcourt la rampe des teints, du plus clair au plus foncé', () => {
    expect(skinColor(appearance, 0)).toEqual(parseColor(appearance.skin[0] ?? '#000000'));
    expect(skinColor(appearance, 1)).toEqual(parseColor(appearance.skin.at(-1) ?? '#000000'));
    const middle = skinColor(appearance, 0.5);
    expect(middle[0]).toBeLessThan(skinColor(appearance, 0)[0]);
  });

  it('détache le fond des portraits du contour et des cheveux les plus sombres (A-11)', () => {
    const backdrop = parseColor(appearance.backdrop);
    const outline = parseColor(appearance.outline);
    // Le contour de la silhouette se voit sur le fond.
    expect(contrast(backdrop, outline)).toBeGreaterThanOrEqual(2);
    // L'ombre des cheveux les plus sombres aussi : la tête garde sa silhouette.
    const black: Rgb = [0, 0, 0];
    const shadows = (genetics.loci.find((locus) => locus.id === 'hair')?.alleles ?? []).map(
      (allele) =>
        personPalette(appearance, {
          skin: black,
          hair: parseColor(allele.color ?? '#000000'),
          cloth: black,
        })[ROLE.hairShadow] ?? black,
    );
    expect(shadows.length).toBeGreaterThan(0);
    const darkest = shadows.reduce((a, b) => (luminance(b) < luminance(a) ? b : a));
    expect(contrast(backdrop, darkest)).toBeGreaterThanOrEqual(2);
  });

  it('habille les cultures à tour de rôle', () => {
    const { clothing } = appearance;
    expect(cultureCloth(clothing, 1)).toBe(clothing[0]);
    expect(cultureCloth(clothing, 0)).toBe(clothing[0]);
    expect(cultureCloth(clothing, 2)).toBe(clothing[1]);
    expect(cultureCloth(clothing, clothing.length + 1)).toBe(clothing[0]);
    expect(cultureCloth<string>([], 3)).toBeUndefined();
  });
});
