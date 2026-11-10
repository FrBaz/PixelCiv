import { describe, expect, it } from 'vitest';
import { loadGameData } from '../core/data';
import { ROLE } from '../core/visual';
import { frameOf, personPalette, recolor, recolorRoles, skinColor } from './atlas';
import { parseColor } from './bake';

const { appearance } = loadGameData();

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
});
