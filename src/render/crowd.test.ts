import { describe, expect, it } from 'vitest';
import { PositionMirror } from '../app/frames';
import { loadGameData } from '../core/data';
import { GROUP_STRIDE, NO_CARRIER, type GroupsFrame } from '../core/protocol';
import { cellOf, FIXED } from '../core/position';
import { AGE_CLASSES, AGE_CODE, visualCode } from '../core/visual';
import { frameOf, hasFrame, recolor, ROLE, type Palette } from './atlas';
import { CHUNK_PX } from './bake';
import { physicalZoom, TILE_PX, visibleChunks, type Camera } from './camera';
import {
  BANNER_CSS_HEIGHT,
  bannerAt,
  bannerBox,
  bannerShapes,
  BANNERS,
  chooseBanner,
  CLOSE_CSS_PX,
  CrowdLayout,
  depth,
  FINGER_SLOP,
  groupArea,
  layoutCrowd,
  mapPixel,
  memberLooks,
  motifTable,
  personBox,
  pickEntity,
  POINTER_SLOP,
  spriteName,
  statureRows,
  textureKey,
  textureParts,
  variantName,
  viewDensity,
  type Box,
  type CrowdOptions,
  type MapView,
} from './crowd';

const data = loadGameData();
const human = data.species.entries.at(0);
if (human === undefined) throw new Error('pas d’humains');
const { stature: reference, carry } = human.display;
const motifs = motifTable(hasFrame, frameOf);
/** Un monde Petit : 512 × 256 cases. */
const world = { width: 512 * TILE_PX, height: 256 * TILE_PX };
const desktop = { width: 1280, height: 720 };
/** Pixel 5 : 393 × 851 pixels CSS, à la densité 2,75. */
const pixel5 = { width: 1081, height: 2340 };

/** Un membre : x et y en cases, stature en 1/128 de case, code d'apparence, porteur (rang). */
interface Member {
  readonly x: number;
  readonly y: number;
  readonly stature?: number;
  readonly code?: number;
  readonly carrier?: number;
}

/** Une image de groupes [identifiant, culture, membres] ; les membres sont numérotés de 1. */
function crowdFrame(...groups: [number, number, Member[]][]): GroupsFrame {
  const members = groups.flatMap(([, , list]) => list);
  const total = members.length;
  return {
    groups: Uint32Array.from(
      groups.flatMap(([id, culture, list]) => [
        id,
        Math.floor(list[0]?.x ?? 0),
        Math.floor(list[0]?.y ?? 0),
        list.length,
        culture,
      ]),
    ),
    slots: Uint32Array.from({ length: total }, (_, index) => index),
    ids: Uint32Array.from({ length: total }, (_, index) => index + 1),
    sprites: Uint16Array.from(members, (member) => member.code ?? visualCode(1, 2, 3, 2, 0)),
    statures: Uint8Array.from(members, (member) => member.stature ?? Math.round(reference * 128)),
    positions: Int32Array.from(
      members.flatMap((member) => [Math.round(member.x * FIXED), Math.round(member.y * FIXED)]),
    ),
    carriers: Uint32Array.from(members, (member) => member.carrier ?? NO_CARRIER),
    legs: {
      slots: new Uint32Array(0),
      days: new Uint32Array(0),
      start: new Int32Array(0),
      step: new Int32Array(0),
      count: new Uint16Array(0),
    },
  };
}

/** Caméra visant le point (x, y), en cases. */
const aimedAt = (x: number, y: number, zoom: number): Camera => ({
  x: x * TILE_PX,
  y: y * TILE_PX,
  zoom,
});

const options = (passable: (cell: number) => boolean = () => true): CrowdOptions => ({
  motifs,
  reference,
  cloth: (culture) => culture % 4,
  passable,
  walkMs: 0,
  stepMs: 420,
});

/** La disposition de `frame` vue par `view`, rangée par profondeur. */
function laid(frame: GroupsFrame, view: MapView, passable?: (cell: number) => boolean) {
  const source = new PositionMirror({ carry, passable: passable ?? (() => true) });
  source.reset({ at: 0, tick: 0, frame }, world.width / TILE_PX);
  const layout = new CrowdLayout();
  layoutCrowd(layout, source, memberLooks(frame, motifs, reference), view, 0, options(passable));
  layout.sort();
  return layout;
}

/** Les dessins d'une disposition, du fond vers l'avant : leur rectangle et leur membre. */
function drawnOf(layout: CrowdLayout) {
  return Array.from({ length: layout.count }, (_, index) => {
    const at = layout.drawn(index);
    return { box: layout.box(at), member: layout.member[at] ?? -1, key: layout.key[at] ?? 0 };
  });
}

describe('variantes de hauteur des individus (ADR 0014, § 6)', () => {
  it('a dans l’atlas chaque motif d’âge, de sexe et de pas, en variantes d’une rangée de plus ou de moins', () => {
    expect(motifs.referenceRows).toBe(9);
    const ranges = Object.fromEntries(AGE_CLASSES.map((age, index) => [age, motifs.ranges[index]]));
    expect(ranges).toEqual({ baby: [6, 6], child: [6, 8], adult: [8, 10], elder: [8, 10] });
    for (let age = 0; age < AGE_CLASSES.length; age++) {
      const [low, high] = motifs.ranges[age] ?? [0, 0];
      for (const sex of [0, 1]) {
        for (const step of [0, 1]) {
          for (let rows = low; rows <= high; rows++) {
            const motif = motifs.person(age, sex, step, rows);
            expect(motifs.heights[motif], `${String(age)}, ${String(rows)}`).toBe(rows);
            // Une variante, d'une rangée doublée ou ôtée : la même largeur que la source.
            const base = frameOf(spriteName(age, sex, step));
            expect(motifs.widths[motif]).toBe(base.width);
          }
        }
      }
    }
    // Les deux images d'une marche, à chaque hauteur.
    expect(hasFrame(variantName('sprites/adult-female-1', 10))).toBe(true);
    expect(hasFrame(variantName('sprites/baby-0', 7))).toBe(false);
  });

  it('choisit la variante sur la stature, et la garde à tout zoom et toute densité', () => {
    const adult = motifs.ranges[AGE_CODE.adult] ?? [9, 9];
    const child = motifs.ranges[AGE_CODE.child] ?? [7, 7];
    // L'adulte moyen de 0,75 case : 9 rangées ; un plus grand ou un plus petit, une de plus
    // ou de moins, dans les variantes de sa classe.
    expect(statureRows(96, reference, 9, adult)).toBe(9);
    expect(statureRows(108, reference, 9, adult)).toBe(10);
    expect(statureRows(84, reference, 9, adult)).toBe(8);
    expect(statureRows(140, reference, 9, adult)).toBe(10);
    // Un enfant de 10 ans, aux 78 % de sa stature adulte, puis de 6 et de 14 ans.
    expect(statureRows(Math.round(96 * 0.78), reference, 9, child)).toBe(7);
    expect(statureRows(Math.round(96 * 0.65), reference, 9, child)).toBe(6);
    expect(statureRows(Math.round(96 * 0.92), reference, 9, child)).toBe(8);
    // Dans la vue : chacun garde ses rangées, la hauteur dessinée divisée par k.
    const frame = crowdFrame([
      1,
      1,
      [
        { x: 100.5, y: 50.5, stature: 84 },
        { x: 101.5, y: 50.5, stature: 96 },
        { x: 102.5, y: 50.5, stature: 108 },
        { x: 103.5, y: 50.5, stature: 75, code: visualCode(0, AGE_CODE.child, 3, 2, 0) },
      ],
    ]);
    for (const resolution of [1, 2.75]) {
      for (const zoom of [3, 4, 8, 16, 24]) {
        const scale = physicalZoom(zoom, resolution);
        const view = {
          camera: aimedAt(102, 50.5, scale),
          viewport: desktop,
          world,
          resolution,
        };
        const layout = laid(frame, view);
        const { k } = viewDensity(scale, resolution, reference, [9]);
        const rows = drawnOf(layout)
          .sort((a, b) => a.member - b.member)
          .map(({ box }) => box.height / k);
        expect(rows, `densité ${String(resolution)}, zoom ${String(zoom)}`).toEqual([8, 9, 10, 7]);
      }
    }
  });
});

describe('densité de la vue et seuil des individus (ADR 0014, § 6)', () => {
  it('donne à l’adulte moyen la hauteur du tableau, aux densités 1 et 2,75', () => {
    // Hauteur d'un adulte de taille moyenne, en pixels CSS, aux zooms 3, 4, 8, 16 et 24.
    const table: Record<number, number[]> = {
      1: [9, 9, 27, 45, 72],
      2.75: [9.8, 13.1, 22.9, 49.1, 72],
    };
    for (const [resolution, heights] of Object.entries(table)) {
      const density = Number(resolution);
      const shown = [3, 4, 8, 16, 24].map((zoom) => {
        const { k } = viewDensity(physicalZoom(zoom, density), density, reference, [9]);
        return Math.round(((9 * k) / density) * 10) / 10;
      });
      expect(shown, `densité ${resolution}`).toEqual(heights);
    }
    // k est le même pour tous les individus d'une vue : celui de l'adulte de référence.
    expect(viewDensity(8, 1, reference, [9]).k).toBe(3);
    expect(viewDensity(66, 2.75, reference, [9]).k).toBe(22);
    // Les humains des planches (2b.5) : le niveau le plus fin dont k reste à 25 % de la cible.
    expect(viewDensity(66, 2.75, reference, [32, 9]).level).toBe(0);
    expect(viewDensity(8, 2.75, reference, [32, 9]).level).toBe(1);
  });

  it('montre les individus dès que l’adulte de référence vise 8 pixels CSS', () => {
    expect(CLOSE_CSS_PX).toBe(8);
    // Densité 1 : à partir du zoom 3, comme avant 2b.3.
    expect(viewDensity(2, 1, reference, [9]).close).toBe(false);
    expect(viewDensity(3, 1, reference, [9]).close).toBe(true);
    // Pixel 5 : à partir du zoom 2,9 ; le zoom 3 d'ouverture du téléphone les montre.
    expect(viewDensity(physicalZoom(2.5, 2.75), 2.75, reference, [9]).close).toBe(false);
    expect(viewDensity(physicalZoom(2.9, 2.75), 2.75, reference, [9]).close).toBe(true);
    expect(viewDensity(physicalZoom(3, 2.75), 2.75, reference, [9]).close).toBe(true);
    // Densité 2 : à l'échelle 6, soit le zoom 3.
    expect(viewDensity(5, 2, reference, [9]).close).toBe(false);
    expect(viewDensity(6, 2, reference, [9]).close).toBe(true);
  });

  it('ne demande que les positions des groupes que l’écran peut montrer', () => {
    const frame = crowdFrame(
      [
        1,
        1,
        [
          { x: 100.5, y: 50.5 },
          { x: 101, y: 51 },
        ],
      ],
      [
        2,
        2,
        [
          { x: 300.5, y: 50.5 },
          { x: 301, y: 50 },
          { x: 302, y: 50 },
        ],
      ],
    );
    const layout = laid(frame, {
      camera: aimedAt(100.5, 50.5, 8),
      viewport: desktop,
      world,
      resolution: 1,
    });
    expect(layout.visibleGroups).toBe(1);
    expect(layout.placed).toBe(2);
    expect(layout.count).toBe(2);
  });
});

describe('appui sur un individu ou son groupe (ADR 0014, § 6)', () => {
  it('touche un individu sur Pixel 5 au zoom 3, à 12 pixels CSS au doigt, puis son groupe, puis la case', () => {
    const resolution = 2.75;
    const scale = physicalZoom(3, resolution);
    // Quatre membres d'un groupe, à trois cases les uns des autres.
    const frame = crowdFrame([
      5,
      1,
      [
        { x: 100.5, y: 50.5 },
        { x: 103.5, y: 50.5 },
        { x: 100.5, y: 53.5 },
        { x: 103.5, y: 53.5 },
      ],
    ]);
    const layout = laid(frame, {
      camera: aimedAt(102, 52, scale),
      viewport: pixel5,
      world,
      resolution,
    });
    expect(layout.close).toBe(true);
    const drawn = drawnOf(layout).sort((a, b) => a.member - b.member);
    const first = drawn.at(0)?.box;
    if (first === undefined) throw new Error('personne');
    // Un adulte dessiné fait 6,5 × 9,8 pixels CSS, et sa cible au doigt 31 × 34.
    expect(first.width / resolution).toBeCloseTo(6.5, 1);
    expect(first.height / resolution).toBeCloseTo(9.8, 1);
    const slop = FINGER_SLOP * resolution;
    expect((first.width + 2 * slop) / resolution).toBeCloseTo(30.5, 0);
    expect((first.height + 2 * slop) / resolution).toBeCloseTo(33.8, 0);
    const middle = (box: Box) => [box.left + box.width / 2, box.top + box.height / 2] as const;
    const [cx, cy] = middle(first);
    expect(pickEntity(layout, cx, cy, slop)).toEqual({ kind: 'person', id: 1 });
    // Frôlé à 12 pixels CSS, il ouvre encore sa fiche ; au-delà, entre les membres, celle du
    // groupe, dans la boîte de ses membres élargie de la même marge.
    const right = first.left + first.width;
    expect(pickEntity(layout, right + slop, cy, slop)).toEqual({ kind: 'person', id: 1 });
    expect(pickEntity(layout, right + slop + 1, cy, slop)).toEqual({ kind: 'group', id: 5 });
    const area = groupArea(layout, 0, slop);
    const [ax, ay] = middle(area);
    expect(pickEntity(layout, ax, ay, slop)).toEqual({ kind: 'group', id: 5 });
    // Hors de la boîte et de sa marge, la case.
    expect(pickEntity(layout, area.left - 1, ay, slop)).toBeUndefined();
    expect(pickEntity(layout, area.left + 1, ay, slop)).toEqual({ kind: 'group', id: 5 });
    // Au pointeur fin, 4 pixels CSS.
    const fine = POINTER_SLOP * resolution;
    expect(pickEntity(layout, right + fine, cy, fine)).toEqual({ kind: 'person', id: 1 });
    expect(pickEntity(layout, right + fine + 1, cy, fine)).toEqual({ kind: 'group', id: 5 });
  });

  it('préfère, à égalité, l’individu de devant, et, entre deux groupes, celui dont un membre est le plus proche', () => {
    const frame = crowdFrame(
      [
        1,
        1,
        [
          { x: 100.5, y: 50.5 },
          { x: 100.6, y: 50.52 },
          { x: 101.6, y: 50.52 },
        ],
      ],
      [
        2,
        2,
        [
          { x: 104, y: 50.5 },
          { x: 98, y: 50.5 },
        ],
      ],
    );
    const layout = laid(frame, {
      camera: aimedAt(100.5, 50.5, 16),
      viewport: desktop,
      world,
      resolution: 1,
    });
    const drawn = drawnOf(layout);
    // Les deux premiers membres se recouvrent : le plus bas passe devant, et l'emporte.
    const [a, b] = [drawn.find((d) => d.member === 0), drawn.find((d) => d.member === 1)];
    if (a === undefined || b === undefined) throw new Error('membres manquants');
    const x = Math.max(a.box.left, b.box.left) + 1;
    const y = Math.max(a.box.top, b.box.top) + 1;
    expect(pickEntity(layout, x, y, 0)).toEqual({ kind: 'person', id: 2 });
    // Les boîtes des deux groupes se recouvrent : entre deux membres du premier, loin de
    // tout autre, l'appui désigne le groupe dont un membre est le plus proche, le premier.
    const c = drawn.find((d) => d.member === 2)?.box;
    if (c === undefined) throw new Error('membre manquant');
    const between = (b.box.left + b.box.width + c.left) / 2;
    expect(groupArea(layout, 0, POINTER_SLOP).left).toBeLessThan(between);
    expect(pickEntity(layout, between, c.top + 2, POINTER_SLOP)).toEqual({ kind: 'group', id: 1 });
    // Plus près d'un membre du second, le second.
    const d = drawn.find((entry) => entry.member === 3)?.box;
    if (d === undefined) throw new Error('membre manquant');
    const nearer = d.left - POINTER_SLOP - 10;
    expect(pickEntity(layout, nearer, d.top + 2, POINTER_SLOP)).toEqual({ kind: 'group', id: 2 });
  });
});

describe('ordre des dessins (W-7, ADR 0014)', () => {
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

  it('dessine du fond vers l’avant, d’après les pieds, et le porté juste devant sa mère', () => {
    const baby = visualCode(0, AGE_CODE.baby, 3, 2, 0);
    const frame = crowdFrame([
      1,
      1,
      [
        // Une mère et son nourrisson, puis deux voisins, l'un plus bas, l'autre aux mêmes
        // pieds qu'elle.
        { x: 100.5, y: 50.5 },
        { x: 100.5, y: 50.5, code: baby, stature: 30, carrier: 0 },
        { x: 100.6, y: 50.55 },
        { x: 100.4, y: 50.5 },
      ],
    ]);
    const layout = laid(frame, {
      camera: aimedAt(100.5, 50.5, 24),
      viewport: desktop,
      world,
      resolution: 1,
    });
    const drawn = drawnOf(layout);
    expect(drawn).toHaveLength(4);
    // Du fond vers l'avant : les pieds montent, et le rang départage les pieds égaux.
    for (let index = 1; index < drawn.length; index++) {
      const [previous, next] = [drawn.at(index - 1), drawn.at(index)];
      if (previous === undefined || next === undefined) continue;
      expect(next.key).toBeGreaterThan(previous.key);
      expect(next.box.top + next.box.height).toBeGreaterThanOrEqual(
        previous.box.top + previous.box.height,
      );
    }
    const order = drawn.map((entry) => entry.member);
    // Le nourrisson passe juste devant sa mère, à 0,2 case d'elle, du côté de son identifiant.
    expect(order.indexOf(1)).toBe(order.indexOf(0) + 1);
    expect(order.at(-1)).toBe(2);
    const mother = drawn.find((entry) => entry.member === 0)?.box;
    const child = drawn.find((entry) => entry.member === 1)?.box;
    if (mother === undefined || child === undefined) throw new Error('mère ou enfant manquant');
    expect(child.top + child.height).toBe(mother.top + mother.height);
    const apart = Math.abs(child.left + child.width / 2 - (mother.left + mother.width / 2));
    expect(Math.abs(apart - carry * TILE_PX * 24)).toBeLessThanOrEqual(4 * 3);
  });
});

describe('bannière d’un groupe vu de loin (REN-08, A-1, ADR 0014)', () => {
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
      for (const scale of [0.25, 0.5, 1, 2, 4, 7]) {
        // De loin seulement : à la densité 1, les individus se voient dès l'échelle 3.
        if (viewDensity(scale, resolution, reference, [9]).close) continue;
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
      // du motif, se plante sur le point de la bannière (bannerBox).
      for (let row = 0; row < height; row++) {
        expect(role(0, row), `${name}, ligne ${String(row)}`).toBe(ROLE.outline);
      }
    }
  });

  it('se plante au barycentre des membres, au plus court par la couture, ou au membre le plus proche s’il tombe sur l’eau', () => {
    const width = 512;
    const xs = Float64Array.of(511.8 * FIXED, 0.4 * FIXED, 511.9 * FIXED, 0.1 * FIXED);
    const ys = Float64Array.of(60 * FIXED, 60.5 * FIXED, 61 * FIXED, 60 * FIXED);
    // Le dernier est porté : il ne compte pas.
    const carriers = Int32Array.of(-1, -1, -1, 0);
    const out = new Float64Array(2);
    bannerAt(xs, ys, carriers, 0, 4, width, () => true, out);
    expect(out[0] / FIXED).toBeCloseTo(0.0333, 3);
    expect(out[1] / FIXED).toBeCloseTo(60.5, 9);
    // Sur l'eau, au membre le plus proche du barycentre.
    const dry = (cell: number) => cell !== cellOf(0.0333 * FIXED, 60.5 * FIXED, width);
    bannerAt(xs, ys, carriers, 0, 4, width, dry, out);
    expect([out[0] / FIXED, out[1] / FIXED]).toEqual([0.4, 60.5]);
    // Dans la vue lointaine : une bannière par groupe, plantée là.
    const frame = crowdFrame([
      9,
      1,
      [
        { x: 200.25, y: 80.5 },
        { x: 200.75, y: 80.5 },
      ],
    ]);
    const layout = laid(frame, { camera: aimedAt(200.5, 80.5, 1), viewport, world, resolution: 1 });
    expect(layout.close).toBe(false);
    expect(layout.count).toBe(1);
    const box = layout.box(0);
    expect(box.left).toBe(viewport.width / 2);
    expect(box.top + box.height).toBe(viewport.height / 2);
    expect(layout.member[0]).toBe(-1);
    expect(frame.groups[layout.group[0] * GROUP_STRIDE]).toBe(9);
  });
});

describe('textures recolorées (A-13)', () => {
  it('nomme une texture par son motif, son apparence et son habit, sans perte', () => {
    for (const [motif, code, cloth] of [
      [0, 0, 0],
      [17, 8191, 3],
      [255, 1234, 40],
    ] as const) {
      expect(textureParts(textureKey(motif, code, cloth))).toEqual({ motif, code, cloth });
    }
    expect(textureKey(1, 2, 3)).not.toBe(textureKey(2, 1, 3));
    expect(Number.isSafeInteger(textureKey(255, 8191, 1000))).toBe(true);
  });

  it('pose chaque individu sur ses pieds, centré sur sa position arrondie au pixel physique', () => {
    expect(personBox(100.4, 50.6, 6, 9, 3)).toEqual({ left: 91, top: 24, width: 18, height: 27 });
    expect(personBox(100.6, 50.4, 4, 6, 1)).toEqual({ left: 99, top: 44, width: 4, height: 6 });
  });
});
