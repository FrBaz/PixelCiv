import { describe, expect, it } from 'vitest';
import { loadGameData } from '../core/data';
import { SPAWN_COUNT } from '../sim/commands';
import { cultureCloth, frameOf } from './atlas';
import { parseColor } from './bake';
import {
  clusterOffset,
  clusterReach,
  ICON_CSS_PIXEL,
  iconPixel,
  onScreen,
  spriteName,
  spriteNames,
  textureKey,
} from './crowd';

describe('grappe des membres d’un groupe (tâche 2.9)', () => {
  it('place chacun à une position entière, stable, sans superposer les premiers', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 50; index++) {
      const { dx, dy } = clusterOffset(index);
      expect(Number.isInteger(dx) && Number.isInteger(dy)).toBe(true);
      expect(clusterOffset(index)).toEqual({ dx, dy });
      // Une grappe serrée : cinquante personnes tiennent à quelques cases du centre.
      expect(Math.abs(dx)).toBeLessThanOrEqual(24);
      expect(Math.abs(dy)).toBeLessThanOrEqual(15);
      if (index < 20) seen.add(`${String(dx)},${String(dy)}`);
    }
    expect(seen.size).toBe(20);
  });

  it('a un motif dans l’atlas pour chaque âge, chaque sexe et chaque pas', () => {
    for (let age = 0; age < 4; age++) {
      for (let sex = 0; sex < 2; sex++) {
        for (let step = 0; step < 2; step++) {
          expect(() => frameOf(spriteName(age, sex, step))).not.toThrow();
          expect(spriteNames()).toContain(spriteName(age, sex, step));
        }
      }
    }
    expect(spriteName(2, 0, 1)).toBe('sprites/adult-female-1');
    expect(spriteName(3, 1, 0)).toBe('sprites/adult-male-0');
    expect(spriteName(0, 1, 0)).toBe('sprites/baby-0');
  });

  it('borne l’étendue de la grappe, quelle que soit la taille du groupe (A-9)', () => {
    // Chaque motif, posé les pieds sur sa place comme le fait PeopleLayer, tient dans
    // l'étendue annoncée, pour tout groupe jusqu'à bien au-delà de l'apparition maximale.
    const frames = spriteNames().map((name) => frameOf(name));
    const width = Math.max(...frames.map((frame) => frame.width));
    const height = Math.max(...frames.map((frame) => frame.height));
    for (let size = 1; size <= 4 * SPAWN_COUNT.max; size++) {
      const reach = clusterReach(size, width, height);
      for (let member = 0; member < size; member++) {
        const { dx, dy } = clusterOffset(member);
        for (const frame of frames) {
          const left = dx - Math.floor(frame.width / 2);
          const top = dy - frame.height + 2;
          expect(left).toBeGreaterThanOrEqual(-reach.left);
          expect(left + frame.width).toBeLessThanOrEqual(reach.right);
          expect(top).toBeGreaterThanOrEqual(-reach.up);
          expect(top + frame.height).toBeLessThanOrEqual(reach.down);
        }
      }
    }
    // L'ancienne marge fixe, 16 pixels de carte, était plus petite que la grappe d'un
    // groupe de 30 ou 50 membres.
    expect(clusterReach(SPAWN_COUNT.max, width, height).left).toBeGreaterThan(16);
  });

  it('dessine un grand groupe dont la case sort de l’écran tant que sa grappe y entre (A-9)', () => {
    const viewport = { width: 800, height: 600 };
    const scale = 3;
    const reach = clusterReach(SPAWN_COUNT.max, 6, 9);
    // Une case à 17 pixels de carte à gauche de l'écran : ses membres de droite s'y voient.
    expect(onScreen(-17 * scale, 300, reach, scale, viewport)).toBe(true);
    expect(onScreen(viewport.width + 17 * scale, 300, reach, scale, viewport)).toBe(true);
    expect(onScreen(400, -10 * scale, reach, scale, viewport)).toBe(true);
    // Trop loin, plus rien ne se voit.
    expect(onScreen(-(reach.right * scale + 2), 300, reach, scale, viewport)).toBe(false);
    expect(onScreen(400, viewport.height + reach.up * scale + 2, reach, scale, viewport)).toBe(
      false,
    );
  });
});

describe('bannière d’un groupe vu de loin (REN-08, A-1)', () => {
  const DENSITIES = [0.5, 1, 1.25, 1.5, 1.75, 2, 2.625, 2.75, 3];
  const SCALES = [0.25, 0.5, 0.8, 1, 2];

  it('se dessine en pixels physiques entiers, à la densité de la carte quand elle le permet', () => {
    for (const resolution of DENSITIES) {
      const marker = Math.max(1, Math.round(ICON_CSS_PIXEL * resolution));
      for (const scale of SCALES) {
        const pixel = iconPixel(scale, resolution);
        expect(Number.isInteger(pixel)).toBe(true);
        expect(pixel).toBeGreaterThanOrEqual(1);
        if (scale >= marker) {
          // Un pixel de bannière par pixel de carte : une seule densité dans la vue.
          expect(pixel, `échelle ${String(scale)}, densité ${String(resolution)}`).toBe(scale);
        } else {
          expect(pixel).toBe(marker);
        }
      }
    }
    // Sur un écran de densité 1, au zoom 2 de la carte, la bannière est à sa densité ; au
    // zoom 1, la carte est trop fine : la bannière devient un marqueur.
    expect(iconPixel(2, 1)).toBe(2);
    expect(iconPixel(1, 1)).toBe(2);
  });

  it('garde, en marqueur, sa taille en pixels CSS sur un écran dense', () => {
    const banner = frameOf('icons/group');
    for (const resolution of DENSITIES.filter((density) => density >= 1)) {
      const marker = Math.max(1, Math.round(ICON_CSS_PIXEL * resolution));
      for (const scale of SCALES.filter((value) => value < marker)) {
        // À un demi-pixel physique près, ICON_CSS_PIXEL pixels CSS par pixel d'icône : la
        // bannière fait de 12 à 20 pixels CSS de haut, et non 5 sur un téléphone.
        const pixel = iconPixel(scale, resolution);
        expect(Math.abs(pixel - ICON_CSS_PIXEL * resolution)).toBeLessThanOrEqual(0.5);
        const height = (banner.height * pixel) / resolution;
        expect(height, `densité ${String(resolution)}`).toBeGreaterThanOrEqual(12);
        expect(height, `densité ${String(resolution)}`).toBeLessThanOrEqual(20);
      }
    }
  });
});

describe('cache des textures recolorées (A-13)', () => {
  it('partage les textures de deux cultures de même habit', () => {
    const { appearance } = loadGameData();
    const clothing = appearance.clothing.map((color) => parseColor(color));
    const cloth = (culture: number) => cultureCloth(clothing, culture) ?? [0, 0, 0];
    const name = 'sprites/adult-male-0';
    const other = 1 + clothing.length;
    expect(cloth(other)).toEqual(cloth(1));
    expect(textureKey(name, 1234, cloth(other))).toBe(textureKey(name, 1234, cloth(1)));
    expect(textureKey('icons/group', 0, cloth(other))).toBe(textureKey('icons/group', 0, cloth(1)));
    // Un autre habit, un autre motif ou une autre apparence : une autre texture.
    expect(textureKey(name, 1234, cloth(2))).not.toBe(textureKey(name, 1234, cloth(1)));
    expect(textureKey('sprites/adult-male-1', 1234, cloth(1))).not.toBe(
      textureKey(name, 1234, cloth(1)),
    );
    expect(textureKey(name, 1235, cloth(1))).not.toBe(textureKey(name, 1234, cloth(1)));
    // Autant de clés de bannière que d'habits, quel que soit le nombre de cultures.
    const banners = new Set<string>();
    for (let culture = 1; culture <= 40; culture++) {
      banners.add(textureKey('icons/group', 0, cloth(culture)));
    }
    expect(banners.size).toBe(new Set(appearance.clothing).size);
  });
});
