import { describe, expect, it } from 'vitest';
import { PositionMirror } from '../app/frames';
import { loadGameData } from '../core/data';
import { ACT_RUN, GROUP_STRIDE, NO_CARRIER, type GroupsFrame } from '../core/protocol';
import { cellOf, FIXED } from '../core/position';
import { splitmix32 } from '../core/rng';
import { AGE_CODE, visualCode } from '../core/visual';
import { frameOf, recolor, ROLE, type Palette } from './atlas';
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
  LEVEL_SPAN,
  LEVEL_STEP,
  mapPixel,
  memberLooks,
  motifTable,
  personBox,
  pickEntity,
  POINTER_SLOP,
  POSE_FRAMES,
  textureKey,
  textureParts,
  viewDensity,
  type Box,
  type CrowdOptions,
  type MapView,
} from './crowd';
import {
  ANIMATION,
  bodyOf,
  firstMotif,
  humanAtlas,
  humanTable,
  LEVEL_ROWS,
  MOTIF_ANCHOR,
  MOTIF_HEIGHT,
  MOTIF_LIFT,
  MOTIF_WIDTH,
  variantOf,
} from './humans';

const data = loadGameData();
const human = data.species.entries.at(0);
if (human === undefined) throw new Error('pas d’humains');
const { stature: reference, carry } = human.display;
const motifs = motifTable(frameOf);
const humans = humanTable(data.appearance, data.activities);
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
  /** Octet d'activité (protocole 9) : le repos, sans lui. */
  readonly act?: number;
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
    activities: Uint8Array.from(members, (member) => member.act ?? 0),
    legs: {
      slots: new Uint32Array(0),
      days: new Uint32Array(0),
      start: new Int32Array(0),
      step: new Int32Array(0),
      count: new Uint16Array(0),
      acts: new Uint8Array(0),
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
  layoutCrowd(layout, source, memberLooks(frame, humans, reference), view, 0, options(passable));
  layout.sort();
  return layout;
}

/** Les dessins d'une disposition, du fond vers l'avant : leur rectangle, membre, motif et unité. */
function drawnOf(layout: CrowdLayout) {
  return Array.from({ length: layout.count }, (_, index) => {
    const at = layout.drawn(index);
    return {
      box: layout.box(at),
      member: layout.member[at] ?? -1,
      key: layout.key[at] ?? 0,
      motif: layout.texture[at] ?? 0,
      unit: layout.unit[at] ?? 1,
    };
  });
}

/** Déphasage d'un identifiant, comme le tire memberLooks. */
const phaseOf = (id: number) => splitmix32(id)() / 2 ** 32;

describe('niveaux de motifs, densité de la vue et seuil des individus (ADR 0014, ADR 0016, § 7)', () => {
  it('donne à l’adulte de référence le niveau, la densité et la hauteur du tableau, aux densités 1 et 2,75', () => {
    expect(LEVEL_ROWS).toEqual([43, 29, 22, 14, 11]);
    // Zoom → [niveau, k, hauteur en pixels CSS] de l'adulte de référence.
    const table: Record<string, Record<number, [number, number, number]>> = {
      '1': {
        3: [4, 1, 11],
        4: [3, 1, 14],
        5: [3, 1, 14],
        6: [2, 1, 22],
        8: [1, 1, 29],
        10: [1, 1, 29],
        11: [1, 1, 29],
        12: [0, 1, 43],
        16: [0, 1, 43],
        21: [0, 1, 43],
        22: [0, 2, 86],
        24: [0, 2, 86],
      },
      '2.75': {
        3: [1, 1, 10.5],
        4: [1, 1, 10.5],
        5: [0, 1, 15.6],
        8: [0, 2, 31.3],
        16: [0, 3, 46.9],
        24: [0, 5, 78.2],
      },
    };
    for (const [resolution, zooms] of Object.entries(table)) {
      const density = Number(resolution);
      for (const [zoom, [level, k, css]] of Object.entries(zooms)) {
        const view = viewDensity(
          physicalZoom(Number(zoom), density),
          density,
          reference,
          LEVEL_ROWS,
        );
        const label = `densité ${resolution}, zoom ${zoom}`;
        expect([view.level, view.k], label).toEqual([level, k]);
        expect(Math.round(((LEVEL_ROWS[level] ?? 0) * k * 10) / density) / 10, label).toBe(css);
      }
    }
    // Le plus fin dont les rangées ne dépassent pas 1,25 fois la cible.
    expect(LEVEL_SPAN).toBe(1.25);
  });

  it('ne fait jamais reculer le détail quand on zoome, et tient la taille à 25 % de la cible entre les sauts de k', () => {
    for (const density of [1, 2, 2.75]) {
      let level = LEVEL_ROWS.length - 1;
      for (let scale = density * 2; scale <= density * 30; scale += 0.05) {
        const view = viewDensity(scale, density, reference, LEVEL_ROWS);
        if (!view.close) continue;
        expect(
          view.level,
          `densité ${String(density)}, échelle ${scale.toFixed(2)}`,
        ).toBeLessThanOrEqual(level);
        level = view.level;
        const rows = LEVEL_ROWS[view.level] ?? 0;
        const error = (view.k * rows - view.target) / view.target;
        // Au plus grossier, faute de plus petit ; à la planche, entre un et deux pixels
        // physiques par pixel de motif, faute de plus fin : jusqu'à un tiers.
        const bound =
          view.level === LEVEL_ROWS.length - 1 || (view.level === 0 && view.k <= 2) ? 0.4 : 0.25;
        expect(
          Math.abs(error),
          `densité ${String(density)}, échelle ${scale.toFixed(2)}`,
        ).toBeLessThanOrEqual(bound);
      }
    }
  });

  it('tient la taille à 25 % de la cible avec des niveaux espacés de LEVEL_STEP, que le schéma impose, et non au-delà', () => {
    // La pire erreur de taille de l'adulte de référence, de la cible du plus grossier à celle où
    // la planche passe à deux pixels physiques par pixel de motif (l'exception documentée).
    const worst = (levels: readonly [number, ...number[]]) => {
      let error = 0;
      for (let target = levels.at(-1) ?? 1; target <= levels[0] * LEVEL_SPAN; target += 0.125) {
        const view = viewDensity(target / (reference * TILE_PX), 1, reference, levels);
        error = Math.max(error, Math.abs(((levels[view.level] ?? 0) * view.k) / target - 1));
      }
      return error;
    };
    // Des niveaux de 43 rangées, chacun LEVEL_STEP fois plus réduit que le précédent, arrondis :
    // la règle tient. Espacés de 2, comme 1, 2 et 4, que le schéma refuse, elle ne tient plus.
    const spaced: [number, ...number[]] = [43];
    for (let factor = LEVEL_STEP; spaced.length < 6; factor *= LEVEL_STEP) {
      spaced.push(Math.round(43 / factor));
    }
    expect(worst(spaced)).toBeLessThanOrEqual(0.25);
    expect(worst(LEVEL_ROWS)).toBeLessThanOrEqual(0.25);
    expect(worst([43, 22, 11])).toBeGreaterThan(0.25);
  });

  it('montre les individus dès que l’adulte de référence vise 8 pixels CSS', () => {
    expect(CLOSE_CSS_PX).toBe(8);
    // Densité 1 : à partir du zoom 3, comme avant 2b.3.
    expect(viewDensity(2, 1, reference, LEVEL_ROWS).close).toBe(false);
    expect(viewDensity(3, 1, reference, LEVEL_ROWS).close).toBe(true);
    // Pixel 5 : à partir du zoom 2,9 ; le zoom 3 d'ouverture du téléphone les montre.
    expect(viewDensity(physicalZoom(2.5, 2.75), 2.75, reference, LEVEL_ROWS).close).toBe(false);
    expect(viewDensity(physicalZoom(2.9, 2.75), 2.75, reference, LEVEL_ROWS).close).toBe(true);
    // Densité 2 : à l'échelle 6, soit le zoom 3.
    expect(viewDensity(5, 2, reference, LEVEL_ROWS).close).toBe(false);
    expect(viewDensity(6, 2, reference, LEVEL_ROWS).close).toBe(true);
  });

  it('garde à chacun la variante la plus proche de sa stature au niveau de la vue, à toute densité', () => {
    // Trois adultes d'une rangée de moins, moyenne et de plus, et un enfant de 10 ans.
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
        const layout = laid(frame, {
          camera: aimedAt(102, 50.5, scale),
          viewport: desktop,
          world,
          resolution,
        });
        const { k, level } = viewDensity(scale, resolution, reference, LEVEL_ROWS);
        const drawn = drawnOf(layout).sort((a, b) => a.member - b.member);
        const label = `densité ${String(resolution)}, zoom ${String(zoom)}`;
        // Chaque dessin fait k pixels physiques par pixel de son motif, et pas un de plus.
        for (const entry of drawn) {
          expect(entry.box.height, label).toBe((MOTIF_HEIGHT[entry.motif] ?? 0) * k);
        }
        // Chacun montre une image du repos de sa variante : d'une rangée de moins, la moyenne,
        // d'une de plus, et l'enfant la sienne.
        drawn.forEach((entry, member) => {
          const stature = [84, 96, 108, 75][member] ?? 96;
          const ratio = stature / 128 / reference;
          const body = bodyOf(
            member === 3 ? 0 : 1,
            member === 3 ? AGE_CODE.child : AGE_CODE.adult,
            ratio,
          );
          const variant = variantOf(body, level, ratio);
          if (member < 3 && level > 0) expect(variant, label).toBe(member);
          const first = firstMotif(body, level, variant, ANIMATION.idle ?? 0);
          expect(entry.motif - first, label).toBeGreaterThanOrEqual(0);
          expect(entry.motif - first, label).toBeLessThan(5);
        });
        const rows = drawn.map((entry) => MOTIF_HEIGHT[entry.motif] ?? 0);
        expect(rows[3] ?? 0, label).toBeLessThan(rows[1] ?? 0);
      }
    }
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
    // L'apparence ne se tire que pour les groupes que l'écran montre, une fois par image.
    const source = new PositionMirror({ carry, passable: () => true });
    source.reset({ at: 0, tick: 0, frame }, world.width / TILE_PX);
    const looks = memberLooks(frame, humans, reference);
    const view = (x: number): MapView => ({
      camera: aimedAt(x, 50.5, 8),
      viewport: desktop,
      world,
      resolution: 1,
    });
    layoutCrowd(new CrowdLayout(), source, looks, view(100.5), 0, options());
    expect(Array.from(looks.ready)).toEqual([1, 0]);
    expect(Array.from(looks.ratio.slice(0, 2)).every((ratio) => ratio > 0)).toBe(true);
    expect(Array.from(looks.ratio.slice(2))).toEqual([0, 0, 0]);
    const first = looks.look.slice(0, 2);
    layoutCrowd(new CrowdLayout(), source, looks, view(301), 0, options());
    expect(Array.from(looks.ready)).toEqual([1, 1]);
    expect(looks.look.slice(0, 2)).toEqual(first);
    // Même code d'apparence, autre culture : même corps, autre tenue, donc autre palette.
    expect(looks.body[2]).toBe(looks.body[0]);
    expect(looks.look[2]).not.toBe(looks.look[0]);
  });
});

describe('appui sur un individu ou son groupe (ADR 0014, § 6)', () => {
  it('touche un individu sur Pixel 5 au zoom 3, à 12 pixels CSS au doigt, puis son groupe, puis la case', () => {
    const resolution = 2.75;
    const scale = physicalZoom(3, resolution);
    // Quatre membres d'un groupe, à trois et quatre cases les uns des autres.
    const frame = crowdFrame([
      5,
      1,
      [
        { x: 100.5, y: 50.5 },
        { x: 103.5, y: 50.5 },
        { x: 100.5, y: 54.5 },
        { x: 103.5, y: 54.5 },
      ],
    ]);
    const layout = laid(frame, {
      camera: aimedAt(102, 52.5, scale),
      viewport: pixel5,
      world,
      resolution,
    });
    expect(layout.close).toBe(true);
    const drawn = drawnOf(layout).sort((a, b) => a.member - b.member);
    const first = drawn.at(0)?.box;
    if (first === undefined) throw new Error('personne');
    // Un adulte dessiné, au niveau de 29 rangées, un pixel physique par pixel de motif : de
    // 10 pixels CSS de haut environ, et sa cible au doigt, 24 pixels CSS de plus en chaque sens.
    const motif = drawn.at(0)?.motif ?? 0;
    expect(first.width).toBe(MOTIF_WIDTH[motif]);
    expect(first.height).toBe(MOTIF_HEIGHT[motif]);
    expect(first.height / resolution).toBeGreaterThan(10);
    expect(first.height / resolution).toBeLessThan(11.5);
    const slop = FINGER_SLOP * resolution;
    expect((first.height + 2 * slop) / resolution).toBeGreaterThan(34);
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

  it('prend le tissu que portent ses membres, tiré de leurs codes d’apparence une fois par image des groupes', () => {
    const light = visualCode(1, 2, 1, 2, 0);
    const dark = visualCode(1, 2, 14, 2, 0);
    const frame = crowdFrame(
      [4, 3, [{ x: 100.5, y: 40.5, code: light }]],
      [
        9,
        5,
        [
          { x: 300.25, y: 80.5, code: dark },
          { x: 300.75, y: 80.5, code: dark },
        ],
      ],
    );
    const calls: string[] = [];
    const cloth: CrowdOptions['cloth'] = (culture, codes, first, size) => {
      calls.push(
        `${String(culture)} : ${Array.from({ length: size }, (_, i) => codes[first + i]).join(',')}`,
      );
      return culture;
    };
    const source = new PositionMirror({ carry, passable: () => true });
    source.reset({ at: 0, tick: 0, frame }, world.width / TILE_PX);
    const looks = memberLooks(frame, humans, reference);
    const view = { camera: aimedAt(300.5, 80.5, 1), viewport, world, resolution: 1 };
    const layout = new CrowdLayout();
    for (let pass = 0; pass < 2; pass++) {
      layoutCrowd(layout, source, looks, view, 0, { ...options(), cloth });
    }
    // Le second groupe, seul à l'écran : son tissu vient des codes de ses deux membres, une fois.
    expect(calls).toEqual([`5 : ${String(dark)},${String(dark)}`]);
    expect(textureParts(layout.texture[0]).cloth).toBe(5);
  });
});

describe('textures des bannières et pieds des individus (A-13, ADR 0016)', () => {
  it('nomme la texture d’une bannière par son motif et son tissu, sans perte', () => {
    for (const [motif, cloth] of [
      [0, 0],
      [3, 7],
      [255, 40],
    ] as const) {
      expect(textureParts(textureKey(motif, cloth))).toEqual({ motif, cloth });
    }
    expect(textureKey(1, 2)).not.toBe(textureKey(2, 1));
  });

  it('pose chaque individu sur ses pieds, à une position entière, retourné autour d’eux', () => {
    // Un motif de 6 pixels de large, pieds à 2 pixels de son bord gauche, à k = 3.
    expect(personBox(100.4, 50.6, 6, 9, 2, 3, false)).toEqual({
      left: 94,
      top: 24,
      width: 18,
      height: 27,
    });
    // Retourné vers l'est, ses pieds sont à 2 pixels de son bord droit : toujours sous x.
    expect(personBox(100.4, 50.6, 6, 9, 2, 3, true)).toEqual({
      left: 88,
      top: 24,
      width: 18,
      height: 27,
    });
    expect(personBox(100.6, 50.4, 4, 6, 1, 1, false)).toEqual({
      left: 100,
      top: 44,
      width: 4,
      height: 6,
    });
    // En l'air de 2 pixels de motif (le saut) : le même motif, 2 × 3 pixels plus haut.
    expect(personBox(100.4, 50.6, 6, 9, 2, 3, false, 2)).toEqual({
      left: 94,
      top: 18,
      width: 18,
      height: 27,
    });
  });

  it('dessine à des positions entières, d’une seule densité, le marcheur vers l’est retourné', () => {
    const frame = crowdFrame([
      1,
      1,
      [
        { x: 100.37, y: 50.41 },
        { x: 101.83, y: 50.66 },
        { x: 99.21, y: 51.13 },
      ],
    ]);
    for (const resolution of [1, 2.75]) {
      const scale = physicalZoom(8, resolution);
      const layout = laid(frame, {
        camera: aimedAt(100.5, 50.5, scale),
        viewport: desktop,
        world,
        resolution,
      });
      const { k } = viewDensity(scale, resolution, reference, LEVEL_ROWS);
      for (const entry of drawnOf(layout)) {
        expect(Number.isInteger(entry.box.left) && Number.isInteger(entry.box.top)).toBe(true);
        expect(Math.abs(entry.unit)).toBe(k);
        // Les pieds, à la position arrondie : à `ancre` pixels de motif du bord tourné vers l'ouest.
        const foot = MOTIF_ANCHOR[entry.motif] ?? 0;
        const feet =
          entry.unit < 0 ? entry.box.left + entry.box.width - foot * k : entry.box.left + foot * k;
        expect(Number.isInteger(feet)).toBe(true);
      }
    }
  });

  it('fait marcher le nourrisson porté avec sa mère qui marche, du même pas, et reposer avec elle', () => {
    const baby = visualCode(0, AGE_CODE.baby, 3, 2, 0);
    const frame = crowdFrame([
      1,
      1,
      [
        { x: 100.5, y: 50.5 },
        { x: 100.5, y: 50.5, code: baby, stature: 30, carrier: 0 },
      ],
    ]);
    // La mère est en marche sur une étape : le miroir le dirait de même.
    class Walking extends PositionMirror {
      override positions(
        group: number,
        t: number,
        xs: Float64Array,
        ys: Float64Array,
        moving: Uint8Array,
        facing?: Int8Array,
      ): void {
        super.positions(group, t, xs, ys, moving, facing);
        moving[0] = this.walking ? 1 : 0;
      }
      walking = true;
    }
    const source = new Walking({ carry, passable: () => true });
    source.reset({ at: 0, tick: 0, frame }, world.width / TILE_PX);
    const view = { camera: aimedAt(100.5, 50.5, 16), viewport: desktop, world, resolution: 1 };
    const walkRow = ANIMATION.walk ?? -1;
    const restRow = humans.idle;
    const frameOfMotif = (body: number, animation: number, motif: number) => {
      for (let variant = 0; variant < 3; variant++) {
        const first = humans.firstMotif(body, 0, variant, animation);
        if (first >= 0 && motif >= first && motif < first + 8) return motif - first;
      }
      return -1;
    };
    for (const walkMs of [0, 420, 1260, 2940]) {
      const looks = memberLooks(frame, humans, reference);
      const layout = new CrowdLayout();
      layoutCrowd(layout, source, looks, view, 0, { ...options(), walkMs });
      layout.sort();
      const drawn = drawnOf(layout);
      const mother = drawn.find((entry) => entry.member === 0);
      const child = drawn.find((entry) => entry.member === 1);
      const motherFrame = frameOfMotif(looks.body[0], walkRow, mother?.motif ?? -1);
      const childFrame = frameOfMotif(looks.body[1], walkRow, child?.motif ?? -1);
      expect(motherFrame, `${String(walkMs)} ms`).toBeGreaterThanOrEqual(0);
      expect(childFrame, `${String(walkMs)} ms`).toBe(motherFrame);
    }
    source.walking = false;
    const looks = memberLooks(frame, humans, reference);
    const layout = new CrowdLayout();
    layoutCrowd(layout, source, looks, view, 0, options());
    layout.sort();
    const child = drawnOf(layout).find((entry) => entry.member === 1);
    expect(frameOfMotif(looks.body[1], restRow, child?.motif ?? -1)).toBeGreaterThanOrEqual(0);
  });

  it('pose chacun d’après son activité : la marche, la course, le geste à l’arrêt, et le porté dans la pose de sa mère', () => {
    // Rangs de data/activities.json : la cueillette 1, le jeu 5.
    const rank = (id: string) => data.activities.activities.findIndex((a) => a.id === id);
    const gather = rank('gather');
    const play = rank('play');
    const baby = visualCode(0, AGE_CODE.baby, 3, 2, 0);
    const child = visualCode(1, AGE_CODE.child, 3, 2, 0);
    const frame = crowdFrame([
      1,
      1,
      [
        { x: 100.5, y: 50.5, code: visualCode(0, AGE_CODE.adult, 3, 2, 0), act: gather },
        { x: 100.5, y: 50.5, code: baby, stature: 30, carrier: 0, act: 0x0f },
        { x: 101.5, y: 50.5, code: child, stature: 70, act: play | ACT_RUN },
      ],
    ]);
    // L'enfant court sur une étape ; la mère et son nourrisson se tiennent à leur lieu.
    class Running extends PositionMirror {
      override positions(
        group: number,
        t: number,
        xs: Float64Array,
        ys: Float64Array,
        moving: Uint8Array,
        facing?: Int8Array,
        acts?: Uint8Array,
      ): void {
        super.positions(group, t, xs, ys, moving, facing, acts);
        moving[2] = this.running ? 1 : 0;
      }
      running = true;
    }
    const source = new Running({ carry, passable: () => true });
    source.reset({ at: 0, tick: 0, frame }, world.width / TILE_PX);
    const view = { camera: aimedAt(100.5, 50.5, 16), viewport: desktop, world, resolution: 1 };
    const level = viewDensity(physicalZoom(16, 1), 1, reference, LEVEL_ROWS).level;
    /** L'animation et l'image rangée du motif `motif` d'un corps, ou −1. */
    const poseOfMotif = (body: number, motif: number) => {
      for (let animation = 0; animation < humanAtlas.animations.length; animation++) {
        for (let variant = 0; variant < 3; variant++) {
          const first = humans.firstMotif(body, level, variant, animation);
          const frames = humanAtlas.animations[animation]?.frames ?? 0;
          if (first >= 0 && motif >= first && motif < first + frames) {
            return animation * POSE_FRAMES + motif - first;
          }
        }
      }
      return -1;
    };
    const seen = { mother: new Set<string>(), child: new Set<string>() };
    for (const running of [true, false]) {
      source.running = running;
      for (let walkMs = 0; walkMs < 4000; walkMs += 97) {
        const looks = memberLooks(frame, humans, reference);
        const layout = new CrowdLayout();
        layoutCrowd(layout, source, looks, view, 0, { ...options(), walkMs });
        layout.sort();
        const drawn = drawnOf(layout);
        const pose = (member: number) =>
          poseOfMotif(looks.body[member] ?? 0, drawn.find((e) => e.member === member)?.motif ?? -1);
        // La mère cueille : son geste, à l'horloge et à sa phase ; son nourrisson, la même pose.
        const mother = humans.poseOf(gather, false, walkMs, 420, phaseOf(1));
        expect(pose(0), `${String(walkMs)} ms`).toBe(mother);
        expect(pose(1), `${String(walkMs)} ms`).toBe(mother);
        seen.mother.add(humanAtlas.animations[Math.floor(mother / POSE_FRAMES)]?.id ?? '');
        // L'enfant court sur son étape, et joue à l'arrêt.
        const expected = humans.poseOf(play | ACT_RUN, running, walkMs, 420, phaseOf(3));
        expect(pose(2), `${String(walkMs)} ms`).toBe(expected);
        const id = humanAtlas.animations[Math.floor(expected / POSE_FRAMES)]?.id ?? '';
        seen.child.add(`${running ? 'en chemin' : 'sur place'} ${id}`);
      }
    }
    // À genoux puis debout ; la course en chemin, les sauts et le repos sur place.
    expect([...seen.mother].sort()).toEqual(['death', 'idle']);
    expect([...seen.child].sort()).toEqual([
      'en chemin run',
      'sur place fall',
      'sur place idle',
      'sur place jump',
    ]);
  });

  it('pose le sauteur en l’air au-dessus de ses pieds, que gardent la profondeur et le tri', () => {
    // Une femme qui joue, à l'arrêt, à l'instant où son geste montre le saut : à la taille de la
    // planche (zoom 16, k = 1), l'auteur la dessine 4 pixels au-dessus du sol.
    const play = data.activities.activities.findIndex((a) => a.id === 'play');
    const woman = visualCode(0, AGE_CODE.adult, 3, 2, 0);
    const frame = crowdFrame([1, 1, [{ x: 100.5, y: 50.5, code: woman, act: play }]]);
    const view = { camera: aimedAt(100.5, 50.5, 16), viewport: desktop, world, resolution: 1 };
    const source = new PositionMirror({ carry, passable: () => true });
    source.reset({ at: 0, tick: 0, frame }, world.width / TILE_PX);
    let lifted = 0;
    for (let walkMs = 0; walkMs < 3200; walkMs += 50) {
      const layout = new CrowdLayout();
      layoutCrowd(layout, source, memberLooks(frame, humans, reference), view, 0, {
        ...options(),
        walkMs,
      });
      expect(layout.count).toBe(1);
      const box = layout.box(0);
      const motif = layout.texture[0];
      const lift = MOTIF_LIFT[motif] ?? 0;
      const feet = Math.round(desktop.height / 2);
      // Les pieds à la position, arrondie au pixel ; le bas du motif `lift` pixels plus haut.
      expect(layout.feet[0]).toBe(feet);
      expect(box.top + box.height + lift).toBe(feet);
      expect(Math.floor(layout.key[0] / 2 ** 20)).toBe(feet);
      if (lift > 0) lifted++;
    }
    expect(lifted).toBeGreaterThan(0);
  });

  it('ne calcule la pose que des individus qui peuvent se voir', () => {
    // Un groupe étalé sur 60 cases : l'écran en montre une partie. Les positions se demandent
    // pour tout le groupe (il touche l'écran), les poses pour ceux qu'on peut voir seulement.
    const members: Member[] = Array.from({ length: 60 }, (_, index) => ({
      x: 70.5 + index,
      y: 50.5,
      act: index % 7,
    }));
    for (const zoom of [8, 16]) {
      const frame = crowdFrame([1, 1, members]);
      const view = { camera: aimedAt(100.5, 50.5, zoom), viewport: desktop, world, resolution: 1 };
      const layout = laid(frame, view);
      const k = viewDensity(physicalZoom(zoom, 1), 1, reference, LEVEL_ROWS).k;
      const level = viewDensity(physicalZoom(zoom, 1), 1, reference, LEVEL_ROWS).level;
      const half = (humans.widest[level] ?? 1) * k + 1;
      const scale = physicalZoom(zoom, 1);
      // Ceux dont les pieds tombent à l'écran, à la largeur du plus large motif près.
      const near = members.filter((member) => {
        const x = (member.x - 100.5) * TILE_PX * scale + desktop.width / 2;
        return x + half > -1 && x - half < desktop.width + 1;
      }).length;
      expect(layout.placed).toBe(60);
      expect(layout.posed, `zoom ${String(zoom)}`).toBe(near);
      expect(layout.posed).toBeLessThan(60);
      expect(layout.count).toBeLessThanOrEqual(layout.posed);
      expect(layout.count).toBeGreaterThan(0);
    }
  });

  it('tourne le nourrisson porté comme sa mère, même sans étape connue, d’après le déphasage de la mère', () => {
    // Des mères dont le déphasage tombe de part et d'autre de 1/2, et leurs nourrissons, de
    // déphasage contraire : chaque nourrisson regarde comme sa mère.
    const ids = Array.from({ length: 40 }, (_, index) => index + 1);
    const east = ids.filter((id) => phaseOf(id) >= 0.5);
    const west = ids.filter((id) => phaseOf(id) < 0.5);
    const baby = visualCode(0, AGE_CODE.baby, 3, 2, 0);
    const members: Member[] = [];
    // Les identifiants suivent les rangs, à partir de 1 : mère de rang 2n, nourrisson 2n + 1.
    for (let pair = 0; pair < 6; pair++) {
      members.push({ x: 100 + pair, y: 50.5 });
      members.push({ x: 100 + pair, y: 50.5, code: baby, stature: 30, carrier: 2 * pair });
    }
    const frame = crowdFrame([1, 1, members]);
    const layout = laid(frame, {
      camera: aimedAt(102.5, 50.5, 16),
      viewport: desktop,
      world,
      resolution: 1,
    });
    const drawn = drawnOf(layout);
    let mixed = 0;
    for (let pair = 0; pair < 6; pair++) {
      const mother = drawn.find((entry) => entry.member === 2 * pair);
      const child = drawn.find((entry) => entry.member === 2 * pair + 1);
      expect(Math.sign(child?.unit ?? 0), `paire ${String(pair)}`).toBe(
        Math.sign(mother?.unit ?? 0),
      );
      const motherEast = phaseOf(2 * pair + 1) >= 0.5;
      expect((mother?.unit ?? 0) < 0).toBe(motherEast);
      if (motherEast !== phaseOf(2 * pair + 2) >= 0.5) mixed++;
    }
    // Des paires où mère et nourrisson ont des déphasages de part et d'autre de 1/2.
    expect(mixed).toBeGreaterThan(0);
    expect(east.length > 0 && west.length > 0).toBe(true);
  });
});
