import { describe, expect, it } from 'vitest';
import { loadGameData } from '../core/data';
import { GROUP_STRIDE, type GroupsFrame } from '../core/protocol';
import { visualCode } from '../core/visual';
import { SPAWN_COUNT } from '../sim/commands';
import { cultureCloth, frameOf, recolor, type Palette } from './atlas';
import { parseColor } from './bake';
import { displayScale, TILE_PX, type Camera } from './camera';
import {
  bannerBox,
  clusterOffset,
  clusterReach,
  groupScreen,
  ICON_CSS_PIXEL,
  iconPixel,
  memberBox,
  memberShape,
  onScreen,
  pickGroup,
  spriteName,
  spriteNames,
  SPRITE_SCALE,
  textureKey,
  TOUCH_SLOP,
  type Box,
  type MapView,
  type PickShapes,
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

describe('groupe sous un appui (W-7)', () => {
  const banner = frameOf('icons/group');
  const sprites = spriteNames().map((name) => frameOf(name));
  const shapes: PickShapes = {
    banner,
    largest: {
      width: Math.max(...sprites.map((frame) => frame.width)),
      height: Math.max(...sprites.map((frame) => frame.height)),
    },
    member: (code) => memberShape(code, frameOf),
  };
  const world = { width: 512 * TILE_PX, height: 256 * TILE_PX };
  const viewport = { width: 1280, height: 720 };
  /** Tous les rôles en couleur, sauf le transparent : les pixels opaques d'un motif. */
  const opaque: Palette = Array.from({ length: 14 }, (_, role) =>
    role === 0 ? undefined : ([1, 1, 1] as const),
  );
  /** Centres des pixels opaques du motif `name`, dessiné dans `box`, en pixels physiques. */
  function visible(name: string, box: Box, pixel: number): [number, number][] {
    const { width, height } = frameOf(name);
    const pixels = recolor(name, opaque);
    const points: [number, number][] = [];
    for (let row = 0; row < height; row++) {
      for (let column = 0; column < width; column++) {
        if ((pixels[(row * width + column) * 4 + 3] ?? 0) === 0) continue;
        points.push([box.left + (column + 0.5) * pixel, box.top + (row + 0.5) * pixel]);
      }
    }
    return points;
  }
  /** L'image de groupes de `size` membres adultes : [identifiant, colonne, ligne, taille]. */
  function frame(...groups: [number, number, number, number][]): GroupsFrame {
    const total = groups.reduce((sum, group) => sum + group[3], 0);
    return {
      groups: Uint32Array.from(groups.flatMap(([id, x, y, size]) => [id, x, y, size, 1])),
      sprites: new Uint16Array(total).fill(visualCode(1, 2, 3, 2, 0)),
    };
  }
  /** Caméra visant le centre de la case (x, y). */
  const aimedAt = (x: number, y: number, zoom: number): Camera => ({
    x: x * TILE_PX + TILE_PX / 2,
    y: y * TILE_PX + TILE_PX / 2,
    zoom,
  });

  it('touche la bannière partout où elle se voit, à toute échelle et toute densité', () => {
    const single = frame([7, 100, 50, 20]);
    expect(single.groups).toHaveLength(GROUP_STRIDE);
    for (const resolution of [1, 2, 3]) {
      for (const zoom of [0.25, 0.5, 0.75, 1, 2]) {
        const view: MapView = { camera: aimedAt(100, 50, zoom), viewport, world, resolution };
        const icon = iconPixel(displayScale(zoom), resolution);
        const box = bannerBox(viewport.width / 2, viewport.height / 2, banner, icon);
        const points = visible('icons/group', box, icon);
        expect(points.length).toBeGreaterThan(20);
        for (const [x, y] of points) {
          expect(pickGroup(single, view, x, y, shapes), `zoom ${String(zoom)}`).toBe(7);
        }
        // À côté, à la tolérance près : frôlée, puis manquée.
        const slop = TOUCH_SLOP * resolution;
        expect(pickGroup(single, view, box.left - slop, box.top, shapes, slop)).toBe(7);
        expect(pickGroup(single, view, box.left - slop - 1, box.top, shapes, slop)).toBeUndefined();
        expect(pickGroup(single, view, box.left - 1, box.top, shapes)).toBeUndefined();
      }
    }
  });

  it('touche chacun des membres, de près, jusqu’au plus éloigné de la grappe', () => {
    const size = SPAWN_COUNT.max;
    const single = frame([3, 100, 50, size]);
    for (const zoom of [SPRITE_SCALE, 6, 12]) {
      const view: MapView = { camera: aimedAt(100, 50, zoom), viewport, world, resolution: 1 };
      const scale = displayScale(zoom);
      for (let member = 0; member < size; member++) {
        const code = single.sprites[member] ?? 0;
        const name = spriteName(2, 1, 0);
        const shape = memberShape(code, frameOf);
        expect(shape).toEqual(frameOf(name));
        const box = memberBox(viewport.width / 2, viewport.height / 2, member, shape, scale);
        for (const [x, y] of visible(name, box, scale)) {
          expect(pickGroup(single, view, x, y, shapes), `membre ${String(member)}`).toBe(3);
        }
      }
    }
  });

  it('retrouve un groupe à travers la couture, dans chaque copie visible du monde', () => {
    const seam = frame([9, 0, 60, 10]);
    const zoom = 0.25;
    const resolution = 1;
    const icon = iconPixel(zoom, resolution);
    // La caméra vise la dernière colonne : le groupe de la colonne 0 est juste à droite.
    const view: MapView = { camera: aimedAt(511, 60, zoom), viewport, world, resolution };
    const at = groupScreen(0, 60, view, { left: 0, right: banner.width, up: 0, down: 0 }, icon);
    expect(at.x).toBeGreaterThan(viewport.width / 2);
    // Le monde, quatre fois plus étroit que l'écran à ce zoom, s'y voit plusieurs fois.
    expect(at.span).toBeLessThan(viewport.width);
    let copies = 0;
    for (let copy = -at.copies; copy <= at.copies; copy++) {
      const box = bannerBox(at.x + copy * at.span, at.y, banner, icon);
      if (box.left < 0 || box.left + box.width > viewport.width) continue;
      copies++;
      const [x, y] = visible('icons/group', box, icon)[0] ?? [0, 0];
      expect(pickGroup(seam, view, x, y, shapes)).toBe(9);
    }
    expect(copies).toBeGreaterThanOrEqual(2);
  });

  it('préfère le dessin touché au dessin frôlé, puis celui qui passe devant', () => {
    // Deux groupes l'un sous l'autre : la bannière du second, plus bas, recouvre le pied
    // de celle du premier.
    const pair = frame([1, 100, 50, 5], [2, 100, 51, 5]);
    const view: MapView = { camera: aimedAt(100, 50, 2), viewport, world, resolution: 1 };
    const icon = iconPixel(2, 1);
    const upper = bannerBox(viewport.width / 2, viewport.height / 2, banner, icon);
    const lower = bannerBox(viewport.width / 2, viewport.height / 2 + 2 * TILE_PX, banner, icon);
    const inBoth = lower.top + 1;
    expect(inBoth).toBeLessThan(upper.top + upper.height);
    expect(pickGroup(pair, view, upper.left + 1, inBoth, shapes, 4)).toBe(2);
    // Au sommet du premier, hors du second : le premier, même si le second est tout près.
    expect(pickGroup(pair, view, upper.left + 1, upper.top + 1, shapes, 40)).toBe(1);
    // Rien sous le point, ni assez près : aucun groupe.
    expect(pickGroup(pair, view, 0, 0, shapes, 4)).toBeUndefined();
    expect(pickGroup(frame(), view, upper.left + 1, upper.top + 1, shapes, 4)).toBeUndefined();
  });
});
