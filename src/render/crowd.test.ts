import { describe, expect, it } from 'vitest';
import { loadGameData } from '../core/data';
import { GROUP_STRIDE, type GroupsFrame } from '../core/protocol';
import { visualCode } from '../core/visual';
import { emptyWalks } from '../core/walk';
import { SPAWN_COUNT } from '../sim/commands';
import { cultureCloth, frameOf, recolor, ROLE, type Palette } from './atlas';
import { CHUNK_PX, parseColor } from './bake';
import { displayScale, TILE_PX, visibleChunks, type Camera } from './camera';
import {
  BANNER_CSS_HEIGHT,
  bannerBox,
  bannerShapes,
  BANNERS,
  chooseBanner,
  clusterOffset,
  clusterReach,
  depth,
  groupPositions,
  groupScreen,
  mapPixel,
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
  const banners = bannerShapes(frameOf);
  const largest = banners.reduce((tallest, banner) =>
    banner.height > tallest.height ? banner : tallest,
  );
  const viewport = { width: 1280, height: 720 };
  /**
   * Pixels physiques d'un pixel de carte tel que la carte le montre, à l'échelle `scale` :
   * ses blocs de CHUNK_PX pixels de carte font CHUNK_PX × `scale` pixels physiques
   * (visibleChunks) ; sous l'échelle 1, elle se lit par ses mipmaps, un pixel physique par
   * pixel affiché.
   */
  function shownMapPixel(scale: number): number {
    const grid = { columns: 8, rows: 4 };
    const [chunk] = visibleChunks({ x: 0, y: 0, zoom: scale }, viewport, grid, CHUNK_PX);
    return Math.max(1, chunk.width / CHUNK_PX);
  }

  it('est toujours à la densité de la carte, et lisible par la taille de son motif', () => {
    for (const resolution of [1, 1.25, 1.5, 1.75, 2, 2.25, 2.625, 2.75, 3]) {
      for (const scale of [0.25, 0.5, 1, 2]) {
        const label = `densité ${String(resolution)}, échelle ${String(scale)}`;
        // Un pixel de bannière par pixel de carte : une seule densité dans la vue.
        const pixel = mapPixel(scale);
        expect(pixel, label).toBe(shownMapPixel(scale));
        const banner = chooseBanner(banners, pixel, resolution);
        const box = bannerBox(viewport.width / 2, viewport.height / 2, banner, pixel);
        expect(box.height / banner.height, label).toBe(shownMapPixel(scale));
        // De 12 à 24 pixels CSS de haut : la plus petite des bannières qui y suffise.
        const height = box.height / resolution;
        expect(height, label).toBeGreaterThanOrEqual(12);
        expect(height, label).toBeLessThanOrEqual(24);
        for (const smaller of banners.filter((other) => other.height < banner.height)) {
          expect((smaller.height * pixel) / resolution, label).toBeLessThan(BANNER_CSS_HEIGHT);
        }
      }
    }
    // Au-delà d'une densité de 3, la plus grande, faute de mieux.
    expect(chooseBanner(banners, 1, 4)).toBe(largest);
    expect(largest.height / 4).toBeLessThan(BANNER_CSS_HEIGHT);
  });

  it('se redessine en quatre tailles, aux rôles du contour et de l’habit, la hampe sur la case', () => {
    expect(banners.map((banner) => banner.name)).toEqual([...BANNERS]);
    expect(banners.map((banner) => banner.height)).toEqual([8, 16, 24, 36]);
    // Chaque rôle a pour couleur son propre numéro.
    const numbered: Palette = Array.from({ length: 14 }, (_, role) =>
      role === ROLE.transparent ? undefined : ([role, 0, 0] as const),
    );
    for (const { name, width, height } of banners) {
      const pixels = recolor(name, numbered);
      const role = (column: number, row: number) => {
        const index = (row * width + column) * 4;
        return pixels[index + 3] === 0 ? ROLE.transparent : (pixels[index] ?? ROLE.transparent);
      };
      const roles = new Set<number>();
      for (let row = 0; row < height; row++) {
        for (let column = 0; column < width; column++) roles.add(role(column, row));
      }
      // Le contour de la hampe et l'habit de la culture, ombre, base et lumière.
      expect(
        [...roles].sort((a, b) => a - b),
        name,
      ).toEqual([ROLE.transparent, ROLE.outline, ROLE.clothShadow, ROLE.cloth, ROLE.clothLight]);
      // La hampe tient la colonne de gauche, de haut en bas : son pied, le coin bas gauche
      // du motif, se plante sur le centre de la case (bannerBox).
      for (let row = 0; row < height; row++) {
        expect(role(0, row), `${name}, ligne ${String(row)}`).toBe(ROLE.outline);
      }
    }
  });
});

describe('ordre des dessins (W-7)', () => {
  it('range les dessins par une profondeur unique : le plus bas devant, puis le dernier dessiné', () => {
    const box = (bottom: number, height: number): Box => ({
      left: 0,
      top: bottom - height,
      width: 7,
      height,
    });
    // Le pied le plus bas passe devant, quels que soient les rangs et les hauteurs.
    expect(depth(box(10, 8), 0)).toBeGreaterThan(depth(box(9, 36), 2 ** 20 - 1));
    expect(depth(box(-29, 8), 0)).toBeGreaterThan(depth(box(-30, 16), 5000));
    // Au même pied, le dernier dessiné, et jamais deux fois la même profondeur.
    expect(depth(box(10, 8), 3)).toBeGreaterThan(depth(box(10, 24), 2));
    const seen = new Set<number>();
    for (let bottom = -40; bottom < 40; bottom++) {
      for (let rank = 0; rank < 50; rank++) seen.add(depth(box(bottom, 8), rank));
    }
    expect(seen.size).toBe(80 * 50);
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
  const banners = bannerShapes(frameOf);
  const sprites = spriteNames().map((name) => frameOf(name));
  const shapes: PickShapes = {
    banners,
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
      walks: emptyWalks(),
    };
  }
  /** Le groupe sous un point, chaque groupe au repos au centre de sa case (groupPositions). */
  function pick(
    groups: GroupsFrame,
    view: MapView,
    x: number,
    y: number,
    pickShapes: PickShapes,
    slop?: number,
  ): number | undefined {
    const count = groups.groups.length / GROUP_STRIDE;
    const positions = new Float64Array(count * 2);
    groupPositions(groups, new Map(), 0, 512, positions, new Uint8Array(count));
    return pickGroup(groups, positions, view, x, y, pickShapes, slop);
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
        const pixel = mapPixel(displayScale(zoom));
        const banner = chooseBanner(banners, pixel, resolution);
        const box = bannerBox(viewport.width / 2, viewport.height / 2, banner, pixel);
        const points = visible(banner.name, box, pixel);
        expect(points.length).toBeGreaterThan(20);
        for (const [x, y] of points) {
          expect(pick(single, view, x, y, shapes), `zoom ${String(zoom)}`).toBe(7);
        }
        // À côté, à la tolérance près : frôlée, puis manquée.
        const slop = TOUCH_SLOP * resolution;
        expect(pick(single, view, box.left - slop, box.top, shapes, slop)).toBe(7);
        expect(pick(single, view, box.left - slop - 1, box.top, shapes, slop)).toBeUndefined();
        expect(pick(single, view, box.left - 1, box.top, shapes)).toBeUndefined();
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
          expect(pick(single, view, x, y, shapes), `membre ${String(member)}`).toBe(3);
        }
      }
    }
  });

  it('retrouve un groupe à travers la couture, dans chaque copie visible du monde', () => {
    const seam = frame([9, 0, 60, 10]);
    const zoom = 0.25;
    const resolution = 1;
    const pixel = mapPixel(zoom);
    const banner = chooseBanner(banners, pixel, resolution);
    // La caméra vise la dernière colonne : le groupe de la colonne 0 est juste à droite.
    const view: MapView = { camera: aimedAt(511, 60, zoom), viewport, world, resolution };
    const at = groupScreen(
      0.5,
      60.5,
      view,
      { left: 0, right: banner.width, up: 0, down: 0 },
      pixel,
    );
    expect(at.x).toBeGreaterThan(viewport.width / 2);
    // Le monde, quatre fois plus étroit que l'écran à ce zoom, s'y voit plusieurs fois.
    expect(at.span).toBeLessThan(viewport.width);
    let copies = 0;
    for (let copy = -at.copies; copy <= at.copies; copy++) {
      const box = bannerBox(at.x + copy * at.span, at.y, banner, pixel);
      if (box.left < 0 || box.left + box.width > viewport.width) continue;
      copies++;
      const [x, y] = visible(banner.name, box, pixel)[0] ?? [0, 0];
      expect(pick(seam, view, x, y, shapes)).toBe(9);
    }
    expect(copies).toBeGreaterThanOrEqual(2);
  });

  it('préfère le dessin touché au dessin frôlé, puis celui qui passe devant', () => {
    // Deux groupes l'un sous l'autre : la bannière du second, plus bas, recouvre le pied
    // de celle du premier.
    const pair = frame([1, 100, 50, 5], [2, 100, 51, 5]);
    const view: MapView = { camera: aimedAt(100, 50, 2), viewport, world, resolution: 1 };
    const banner = chooseBanner(banners, mapPixel(2), 1);
    const upper = bannerBox(viewport.width / 2, viewport.height / 2, banner, 2);
    const lower = bannerBox(viewport.width / 2, viewport.height / 2 + TILE_PX * 2, banner, 2);
    const inBoth = lower.top + 1;
    expect(inBoth).toBeLessThan(upper.top + upper.height);
    expect(pick(pair, view, upper.left + 1, inBoth, shapes, 4)).toBe(2);
    // Au sommet du premier, hors du second : le premier, même si le second est tout près.
    expect(pick(pair, view, upper.left + 1, upper.top + 1, shapes, 40)).toBe(1);
    // Rien sous le point, ni assez près : aucun groupe.
    expect(pick(pair, view, 0, 0, shapes, 4)).toBeUndefined();
    expect(pick(frame(), view, upper.left + 1, upper.top + 1, shapes, 4)).toBeUndefined();
  });

  it('à pied égal, prend le dernier dessiné, que PixiJS montre devant (depth)', () => {
    // Deux groupes d'une même ligne, en cases voisines : leurs bannières se recouvrent, et
    // leurs pieds sont à la même hauteur. Le second de l'image est dessiné après.
    for (const resolution of [1, 2, 3]) {
      for (const zoom of [0.25, 0.5, 1, 2]) {
        const view: MapView = { camera: aimedAt(100, 50, zoom), viewport, world, resolution };
        const pixel = mapPixel(displayScale(zoom));
        const banner = chooseBanner(banners, pixel, resolution);
        const left = bannerBox(viewport.width / 2, viewport.height / 2, banner, pixel);
        const step = TILE_PX * displayScale(zoom);
        const right = bannerBox(viewport.width / 2 + step, viewport.height / 2, banner, pixel);
        expect(right.left).toBeLessThan(left.left + left.width);
        expect(depth(right, 1)).toBeGreaterThan(depth(left, 0));
        const [x, y] = [right.left + 0.5, right.top + 0.5];
        const label = `densité ${String(resolution)}, zoom ${String(zoom)}`;
        expect(pick(frame([1, 100, 50, 5], [2, 101, 50, 5]), view, x, y, shapes), label).toBe(2);
        expect(pick(frame([2, 101, 50, 5], [1, 100, 50, 5]), view, x, y, shapes), label).toBe(1);
      }
    }
    // De près, deux membres de groupes voisins aux pieds sur la même ligne.
    const view: MapView = { camera: aimedAt(100, 50, 4), viewport, world, resolution: 1 };
    const shape = memberShape(visualCode(1, 2, 3, 2, 0), frameOf);
    const first = memberBox(viewport.width / 2, viewport.height / 2, 0, shape, 4);
    const second = memberBox(viewport.width / 2 + TILE_PX * 4, viewport.height / 2, 0, shape, 4);
    expect(second.left).toBeLessThan(first.left + first.width);
    const [x, y] = [second.left + 0.5, second.top + 0.5];
    expect(pick(frame([1, 100, 50, 1], [2, 101, 50, 1]), view, x, y, shapes)).toBe(2);
    expect(pick(frame([2, 101, 50, 1], [1, 100, 50, 1]), view, x, y, shapes)).toBe(1);
  });
});

describe('positions des groupes à l’instant affiché (ADR 0013)', () => {
  const world = { width: 512 * TILE_PX, height: 256 * TILE_PX };
  const viewport = { width: 1280, height: 720 };

  it('place un groupe au repos au centre de sa case, et un groupe en marche sur son chemin', () => {
    // Deux groupes : le 4 se repose en (20, 30), le 9 marche de (511, 12) à (1, 12) par la
    // couture, en (0, 12) au bout de son chemin.
    const frame: GroupsFrame = {
      groups: Uint32Array.of(4, 20, 30, 3, 1, 9, 1, 12, 5, 2),
      sprites: new Uint16Array(8),
      walks: {
        groups: Uint32Array.of(9),
        ends: Uint32Array.of(3),
        cells: Uint32Array.of(12 * 512 + 511, 12 * 512, 12 * 512 + 1),
        costs: Float64Array.of(0, 1, 2),
        budgets: Float64Array.of(30),
      },
    };
    const walkOf = new Map([[9, 0]]);
    const positions = new Float64Array(4);
    const moving = new Uint8Array(2);
    groupPositions(frame, walkOf, 0.25, 512, positions, moving);
    expect(Array.from(positions)).toEqual([20.5, 30.5, 511.75, 12.5]);
    expect(Array.from(moving)).toEqual([0, 1]);
    groupPositions(frame, walkOf, 0.75, 512, positions, moving);
    expect(positions[2]).toBeCloseTo(0.25, 12);
    groupPositions(frame, walkOf, 2, 512, positions, moving);
    expect(Array.from(positions)).toEqual([20.5, 30.5, 1.5, 12.5]);
    expect(Array.from(moving)).toEqual([0, 0]);
  });

  it('dessine à des positions entières de l’écran, passe la couture au plus court, et se touche où il se dessine', () => {
    const banners = bannerShapes(frameOf);
    const sprites = spriteNames().map((name) => frameOf(name));
    const shapes: PickShapes = {
      banners,
      largest: {
        width: Math.max(...sprites.map((shape) => shape.width)),
        height: Math.max(...sprites.map((shape) => shape.height)),
      },
      member: (code) => memberShape(code, frameOf),
    };
    const single: GroupsFrame = {
      groups: Uint32Array.of(5, 0, 40, 6, 1),
      sprites: new Uint16Array(6).fill(visualCode(1, 2, 3, 2, 0)),
      walks: emptyWalks(),
    };
    for (const zoom of [1, 2, 8, 24]) {
      const scale = displayScale(zoom);
      const pixel = mapPixel(scale);
      const reach = { left: 8, right: 8, up: 8, down: 8 };
      // La caméra vise la couture, un peu au-dessus du groupe.
      const view: MapView = {
        camera: { x: 0.37, y: 40 * TILE_PX, zoom },
        viewport,
        world,
        resolution: 1,
      };
      let previous: number | undefined;
      for (let x = 512 - 0.4; x <= 512 + 0.3 + 1e-9; x += 0.05) {
        const column = x >= 512 ? x - 512 : x;
        expect(column).toBeGreaterThanOrEqual(0);
        expect(column).toBeLessThan(512);
        const at = groupScreen(column, 40.5, view, reach, pixel);
        // Au plus court : la copie du monde la plus proche de la caméra, sans saut.
        if (previous !== undefined) {
          expect(Math.abs(at.x - previous)).toBeLessThanOrEqual(0.05 * TILE_PX * scale + 1e-6);
        }
        previous = at.x;
        const box =
          scale >= SPRITE_SCALE
            ? memberBox(at.x, at.y, 3, shapes.largest, pixel)
            : bannerBox(at.x, at.y, chooseBanner(banners, pixel, 1), pixel);
        expect(Number.isInteger(box.left) && Number.isInteger(box.top)).toBe(true);
        // Le groupe se touche là où il se dessine, à sa position fractionnaire.
        const positions = Float64Array.of(column, 40.5);
        const inside = { x: box.left + 1, y: box.top + box.height - 2 };
        const picked = pickGroup(single, positions, view, inside.x, inside.y, shapes, 2);
        expect(picked, `zoom ${String(zoom)}, x ${x.toFixed(2)}`).toBe(5);
      }
    }
  });
});
