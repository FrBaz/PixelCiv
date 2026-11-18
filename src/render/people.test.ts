import { Container, Sprite, type Application } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { PositionMirror } from '../app/frames';
import { loadGameData, type Appearance } from '../core/data';
import { NO_CARRIER, type GroupsFrame, type LegArrays } from '../core/protocol';
import { FIXED } from '../core/position';
import { RandomStream, streamSeed } from '../core/rng';
import { visualCode } from '../core/visual';
import { CHUNK_PX } from './bake';
import { displayScale, physicalZoom, TILE_PX, visibleChunks, type Camera } from './camera';
import { viewDensity, type Box } from './crowd';
import { PeopleLayer, stepDuration, STEP_MS, type PeopleScene } from './people';

// Le calque des individus, sur une application factice : la scène, et la densité de l'écran
// du rendu. On y lit ce que PixiJS rendrait, sprite par sprite, dans l'ordre de ses enfants.

const data = loadGameData();
const human = data.species.entries.at(0);
if (human === undefined) throw new Error('pas d’humains');
const { stature: reference, carry } = human.display;
const viewport = { width: 1280, height: 720 };
/** Un monde Petit : 512 × 256 cases. */
const world = { width: 512 * TILE_PX, height: 256 * TILE_PX };
const grid = { columns: world.width / CHUNK_PX, rows: world.height / CHUNK_PX };

function setup(resolution: number, appearance: Appearance = data.appearance) {
  const stage = new Container();
  const app = { renderer: { resolution }, stage } as unknown as Application;
  const people = new PeopleLayer(app, { genetics: data.genetics, appearance, reference });
  const layer = stage.children.at(0);
  if (!(layer instanceof Container)) throw new Error('calque introuvable');
  return { people, layer };
}

/** Aucune étape. */
const noLegs = (): LegArrays => ({
  slots: new Uint32Array(0),
  days: new Uint32Array(0),
  start: new Int32Array(0),
  step: new Int32Array(0),
  count: new Uint16Array(0),
});

/**
 * Groupes de `size` adultes : [identifiant, colonne, ligne, culture], chacun au centre de la
 * case de son groupe, de stature moyenne. Les identifiants des membres suivent leur rang, à
 * partir de 1.
 */
function frame(size: number, ...groups: [number, number, number, number][]): GroupsFrame {
  const total = groups.length * size;
  const positions = new Int32Array(2 * total);
  groups.forEach(([, x, y], group) => {
    for (let member = group * size; member < (group + 1) * size; member++) {
      positions[2 * member] = x * FIXED + FIXED / 2;
      positions[2 * member + 1] = y * FIXED + FIXED / 2;
    }
  });
  return {
    groups: Uint32Array.from(groups.flatMap(([id, x, y, culture]) => [id, x, y, size, culture])),
    slots: Uint32Array.from({ length: total }, (_, index) => index),
    ids: Uint32Array.from({ length: total }, (_, index) => index + 1),
    sprites: new Uint16Array(total).fill(visualCode(1, 2, 3, 2, 0)),
    statures: new Uint8Array(total).fill(Math.round(reference * 128)),
    positions,
    carriers: new Uint32Array(total).fill(NO_CARRIER),
    legs: noLegs(),
  };
}

/** Ce que montre l'image `groups` à l'instant 0, à l'horloge de marche `walkMs`. */
function scene(groups: GroupsFrame, walkMs = 0, width = 512): PeopleScene {
  const source = new PositionMirror({ carry, passable: () => true });
  source.reset({ at: 0, tick: 0, frame: groups }, width);
  return { source, t: 0, walkMs, stepMs: STEP_MS.slowest, passable: () => true };
}

/** Caméra visant la case (x, y), décalée de (dx, dy) pixels de carte. */
const aimedAt = (x: number, y: number, zoom: number, dx = 0, dy = 0): Camera => ({
  x: x * TILE_PX + TILE_PX / 2 + dx,
  y: y * TILE_PX + TILE_PX / 2 + dy,
  zoom,
});

/** Rectangle d'un sprite à l'écran, en pixels physiques. */
function boxOf(sprite: Sprite, resolution: number): Box {
  return {
    left: Math.round(sprite.position.x * resolution),
    top: Math.round(sprite.position.y * resolution),
    width: Math.round(sprite.texture.width * sprite.scale.x * resolution),
    height: Math.round(sprite.texture.height * sprite.scale.y * resolution),
  };
}

/** Les sprites visibles, dans l'ordre où PixiJS les rend : le dernier devant. */
function rendered(layer: Container): Sprite[] {
  // Le calque ne se trie pas : ses enfants se rendent dans leur ordre.
  expect(layer.sortableChildren).toBe(false);
  return layer.children.filter(
    (child): child is Sprite => child instanceof Sprite && child.visible,
  );
}

const contains = (box: Box, x: number, y: number) =>
  x >= box.left && x < box.left + box.width && y >= box.top && y < box.top + box.height;

describe('bannière d’un groupe sur la carte (REN-08, A-1)', () => {
  it('se dessine à la densité de la carte, sur ses pixels, à toute densité et tout zoom', () => {
    const group = scene(frame(20, [7, 100, 50, 1]));
    for (const resolution of [1, 1.25, 1.5, 1.75, 2, 2.25, 2.625, 2.75, 3]) {
      const { people, layer } = setup(resolution);
      for (const zoom of [0.25, 0.4096, 0.5, 0.8, 1, 2]) {
        const label = `densité ${String(resolution)}, zoom ${String(zoom)}`;
        // Une caméra entre deux pixels : les bords des blocs de la carte s'arrondissent.
        const camera = aimedAt(100, 50, zoom, 0.3, -0.7);
        people.draw(group, camera, viewport, world);
        expect(people.close, label).toBe(false);
        // Une bannière par copie visible du monde, plus étroit que l'écran au zoom 0,25.
        const banners = rendered(layer);
        expect(banners.length, label).toBeGreaterThanOrEqual(1);
        const [chunk] = visibleChunks(camera, viewport, grid, CHUNK_PX);
        // Pixels physiques par pixel de bannière : ceux d'un pixel de carte, l'échelle à
        // partir de 1 (les blocs font CHUNK_PX × l'échelle), un en deçà (mipmaps).
        const scale = displayScale(zoom);
        const mapPixel = Math.max(1, scale);
        if (scale >= 1) expect(chunk.width, label).toBe(CHUNK_PX * mapPixel);
        for (const banner of banners) {
          expect(banner.label, label).toBe('-7');
          expect(banner.scale.x * resolution, label).toBeCloseTo(mapPixel, 9);
          expect(banner.scale.y * resolution, label).toBeCloseTo(mapPixel, 9);
          // Sur la grille des pixels de la carte : le barycentre de ses membres, au centre de
          // leur case, tombe sur le bord d'un pixel de carte.
          const box = boxOf(banner, resolution);
          expect(banner.position.x * resolution, label).toBeCloseTo(box.left, 9);
          expect(banner.position.y * resolution, label).toBeCloseTo(box.top, 9);
          expect((((box.left - chunk.left) % mapPixel) + mapPixel) % mapPixel, label).toBe(0);
          expect((((box.top - chunk.top) % mapPixel) + mapPixel) % mapPixel, label).toBe(0);
          // Lisible par la taille de son motif : de 12 à 24 pixels CSS de haut.
          const height = box.height / resolution;
          expect(height, label).toBeGreaterThanOrEqual(12);
          expect(height, label).toBeLessThanOrEqual(24);
        }
      }
    }
  });
});

describe('ordre des dessins et appui (W-7, ADR 0014)', () => {
  it('montre devant, sur tout le recouvrement de deux bannières d’une ligne, le groupe que désigne l’appui', () => {
    // A = groupe 1 en (230, 110), B = groupe 2 en (231, 110) : même ligne, cases voisines,
    // sur un monde plus large que l'écran, que chacun ne voit qu'une fois.
    const wide = { width: 1024 * TILE_PX, height: 512 * TILE_PX };
    const pair = scene(frame(20, [1, 230, 110, 2], [2, 231, 110, 3]), 0, 1024);
    for (const resolution of [1, 2]) {
      for (const zoom of [0.5, 1, 2]) {
        const label = `densité ${String(resolution)}, zoom ${String(zoom)}`;
        const { people, layer } = setup(resolution);
        const home = aimedAt(230, 110, zoom);
        people.draw(pair, home, viewport, wide);
        const first = rendered(layer).map((sprite) => boxOf(sprite, resolution));
        expect(first, label).toHaveLength(2);
        const [a, b] = [...first].sort((p, q) => p.left - q.left);
        // La caméra s'écarte : A sort de l'écran par la gauche, B reste dessiné, 100 pixels
        // plus bas. Puis elle revient : à pied égal, seul le rang départage A et B.
        const scale = displayScale(zoom);
        const away = {
          ...home,
          x: home.x + (a.left + a.width + 2) / scale,
          y: home.y - 100 / scale,
        };
        people.draw(pair, away, viewport, wide);
        expect(rendered(layer), label).toHaveLength(1);
        people.draw(pair, home, viewport, wide);
        const boxes = rendered(layer).map((sprite) => boxOf(sprite, resolution));
        expect(
          [...boxes].sort((p, q) => p.left - q.left),
          label,
        ).toEqual([a, b]);
        // Sur chaque pixel du recouvrement, le dernier sprite rendu est celui du groupe que
        // désigne un appui.
        const top = Math.max(a.top, b.top);
        const bottom = Math.min(a.top + a.height, b.top + b.height);
        let checked = 0;
        for (let y = top; y < bottom; y++) {
          for (let x = b.left; x < a.left + a.width; x++) {
            const shown = boxes.findLast((box) => contains(box, x + 0.5, y + 0.5));
            const expected = shown?.left === a.left ? 1 : 2;
            expect(people.pick(x + 0.5, y + 0.5, 0), label).toEqual({
              kind: 'group',
              id: expected,
            });
            checked++;
          }
        }
        expect(checked, label).toBeGreaterThan(0);
      }
    }
  });

  it('montre devant, en tout point, l’individu ou la bannière que désigne l’appui, de loin comme de près', () => {
    // Huit groupes serrés, de six membres, sur des cases voisines ; de près, leurs membres,
    // dispersés à moins d'une demi-case du centre de leur case, se recouvrent.
    const groups: [number, number, number, number][] = [
      [1, 300, 120, 1],
      [2, 302, 120, 2],
      [3, 303, 121, 3],
      [4, 301, 122, 4],
      [5, 304, 120, 5],
      [6, 300, 123, 6],
      [7, 302, 122, 7],
      [8, 305, 121, 8],
    ];
    const random = new RandomStream(streamSeed('people', 'zorder'));
    const crowded = frame(6, ...groups);
    const spread = () => Math.round((random.nextFloat() * 0.8 - 0.4) * FIXED);
    for (let member = 0; member < crowded.ids.length; member++) {
      crowded.positions[2 * member] = (crowded.positions[2 * member] ?? 0) + spread();
      crowded.positions[2 * member + 1] = (crowded.positions[2 * member + 1] ?? 0) + spread();
    }
    const crowd = scene(crowded);
    const mismatches: string[] = [];
    let checked = 0;
    let persons = 0;
    for (const resolution of [1, 2]) {
      const { people, layer } = setup(resolution);
      for (const zoom of [0.25, 0.5, 1, 2, 3, 4, 8]) {
        for (let trial = 0; trial < 3; trial++) {
          const camera = aimedAt(302, 121, zoom, random.nextRange(-8, 8), random.nextRange(-8, 8));
          people.draw(crowd, camera, viewport, world);
          // L'étiquette d'un sprite dit ce qu'il montre : un individu, ou un groupe en négatif.
          const drawn = rendered(layer).map((sprite) => ({
            box: boxOf(sprite, resolution),
            entity: Number(sprite.label),
          }));
          // Les pixels où se recouvrent deux dessins, un sur deux en chaque sens.
          const overlaps = new Map<string, [number, number]>();
          for (const [i, p] of drawn.entries()) {
            for (const q of drawn.slice(i + 1)) {
              const left = Math.max(p.box.left, q.box.left);
              const right = Math.min(p.box.left + p.box.width, q.box.left + q.box.width);
              const top = Math.max(p.box.top, q.box.top);
              const bottom = Math.min(p.box.top + p.box.height, q.box.top + q.box.height);
              for (let y = top + (top & 1); y < bottom; y += 2) {
                for (let x = left + (left & 1); x < right; x += 2) {
                  overlaps.set(`${String(x)},${String(y)}`, [x + 0.5, y + 0.5]);
                }
              }
            }
          }
          for (const [x, y] of overlaps.values()) {
            const shown = drawn.findLast(({ box }) => contains(box, x, y));
            const picked = people.pick(x, y, 0);
            const entity =
              picked === undefined ? undefined : picked.kind === 'person' ? picked.id : -picked.id;
            if (picked?.kind === 'person') persons++;
            checked++;
            if (entity !== shown?.entity && mismatches.length < 5) {
              mismatches.push(
                `densité ${String(resolution)}, zoom ${String(zoom)}, (${String(x)}, ${String(y)}) : ` +
                  `devant ${String(shown?.entity)}, appui ${String(entity)}`,
              );
            }
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
    // Les recouvrements ont bien été visités, de loin comme de près.
    expect(checked).toBeGreaterThan(1000);
    expect(persons).toBeGreaterThan(100);
  });
});

describe('individus à leur position (ADR 0014)', () => {
  it('dessine chacun à sa position, à la densité de la vue, à des positions entières de l’écran', () => {
    const { people, layer } = setup(2);
    const groups = frame(4, [1, 101, 50, 1]);
    // Le quatrième membre, un quart de case à l'est des trois autres.
    groups.positions[6] += FIXED / 4;
    const camera = aimedAt(101, 50, 24, 0.3);
    people.draw(scene(groups), camera, viewport, world);
    const sprites = rendered(layer);
    const boxes = sprites.map((sprite) => boxOf(sprite, 2));
    expect(boxes).toHaveLength(4);
    const { k } = viewDensity(displayScale(24), 2, reference, [9]);
    for (const [index, box] of boxes.entries()) {
      expect(Number.isInteger(box.left) && Number.isInteger(box.top)).toBe(true);
      // k pixels physiques par pixel de motif : un adulte moyen de 9 rangées.
      expect((sprites[index]?.scale.x ?? 0) * 2).toBe(k);
      expect(box.height).toBe(9 * k);
    }
    const lefts = boxes.map((box) => box.left).sort((a, b) => a - b);
    const shift = (lefts.at(-1) ?? 0) - (lefts.at(0) ?? 0);
    expect(Math.abs(shift - 0.25 * TILE_PX * displayScale(24))).toBeLessThanOrEqual(1);
  });

  it('dessine côte à côte, au plus court, les membres d’un groupe à cheval sur la couture', () => {
    const { people, layer } = setup(1);
    const groups = frame(2, [1, 511, 60, 1]);
    // L'un à l'ouest de la couture, en 511,8 ; l'autre à l'est, en 0,2.
    groups.positions[0] = Math.round(511.8 * FIXED);
    groups.positions[2] = Math.round(0.2 * FIXED);
    for (const x of [511, 0]) {
      people.draw(scene(groups), aimedAt(x, 60, 8), viewport, world);
      const lefts = rendered(layer)
        .map((sprite) => boxOf(sprite, 1).left)
        .sort((a, b) => a - b);
      expect(lefts).toHaveLength(2);
      // 0,4 case d'écart à l'écran, et non le tour du monde.
      const gap = (lefts[1] ?? 0) - (lefts[0] ?? 0);
      expect(Math.abs(gap - 0.4 * TILE_PX * 8)).toBeLessThanOrEqual(1);
    }
    // Au zoom le plus faible, le monde plus étroit que l'écran : une bannière par copie.
    people.draw(scene(groups), { x: 0, y: 60 * TILE_PX, zoom: 0.25 }, viewport, world);
    const copies = rendered(layer).length;
    expect(copies).toBeGreaterThanOrEqual(Math.floor(viewport.width / (world.width * 0.25)));
    expect(copies).toBeLessThanOrEqual(Math.ceil(viewport.width / (world.width * 0.25)) + 1);
  });

  it('passe des bannières aux individus au seuil de 8 pixels CSS, en zoomant puis en dézoomant', () => {
    for (const resolution of [1, 2.75]) {
      const { people, layer } = setup(resolution);
      const groups = scene(frame(20, [1, 200, 100, 1], [2, 203, 101, 2]));
      // L'adulte de référence vise 8 pixels CSS à l'échelle 3 à la densité 1 (le zoom 3), et à
      // l'échelle 8 à la densité 2,75 (le zoom 2,9) ; de loin, une bannière par groupe, de
      // près un sprite par individu.
      const threshold = resolution === 1 ? 3 : 8;
      for (const zoom of [1, 2, 2.5, 2.9, 3, 4, 8, 4, 3, 2.9, 2.5, 2, 1]) {
        const label = `densité ${String(resolution)}, zoom ${String(zoom)}`;
        const scale = physicalZoom(zoom, resolution);
        people.draw(groups, aimedAt(201, 100, scale), viewport, world);
        expect(people.close, label).toBe(scale >= threshold);
        expect(rendered(layer).length, label).toBe(scale >= threshold ? 40 : 2);
      }
      expect(physicalZoom(2.9, 2.75)).toBe(8);
      expect(physicalZoom(2.5, 2.75)).toBe(7);
    }
  });

  it('alterne les images de la marche à la cadence du rendu, figée en pause et hors d’une étape', () => {
    const { people, layer } = setup(1);
    const groups = frame(3, [1, 101, 50, 1]);
    // Le premier membre marche vers l'est, sur une étape de dix jours.
    const walker: GroupsFrame = {
      ...groups,
      legs: {
        slots: Uint32Array.of(0),
        days: Uint32Array.of(0),
        start: Int32Array.of(groups.positions[0], groups.positions[1]),
        step: Int32Array.of(FIXED / 8, 0),
        count: Uint16Array.of(10),
      },
    };
    const textures = (walkMs: number, t: number) => {
      people.draw({ ...scene(walker, walkMs), t }, aimedAt(101, 50, 8), viewport, world);
      return new Map(rendered(layer).map((sprite) => [sprite.label, sprite.texture]));
    };
    const step = STEP_MS.slowest;
    const walking = new Set<unknown>();
    const resting = new Set<unknown>();
    for (let walkMs = 0; walkMs < 4 * step; walkMs += step / 2) {
      walking.add(textures(walkMs, 1.5).get('1'));
      resting.add(textures(walkMs, 1.5).get('2'));
    }
    // Deux images pour le marcheur ; au repos, la première.
    expect(walking.size).toBe(2);
    expect(resting.size).toBe(1);
    // L'étape finie, le marcheur se tient sur la première image.
    expect(textures(0, 20).get('1')).toBe(textures(step, 20).get('1'));
    expect(textures(0, 20).get('1')).toBe(textures(0, 20).get('2'));
    // Une horloge de marche arrêtée, comme en pause, fige l'image, quel que soit l'instant.
    expect(textures(step / 3, 1.5).get('1')).toBe(textures(step / 3, 1.6).get('1'));
    // Une alternance toutes les 420 ms à ×½ et ×1, toutes les 200 ms au plus vite.
    expect([0.5, 1, 4, 16].map(stepDuration)).toEqual([420, 420, 200, 200]);
  });

  it('ne refait pas une image qui ne change rien : même instant, même caméra, même horloge de marche', () => {
    const { people } = setup(1);
    const shown = scene(frame(5, [1, 100, 50, 1]));
    const source = shown.source as PositionMirror;
    let asked = 0;
    const positions = source.positions.bind(source);
    source.positions = (...args) => {
      asked++;
      positions(...args);
    };
    const camera = aimedAt(100, 50, 8);
    people.draw(shown, camera, viewport, world);
    expect(asked).toBe(1);
    // En pause, caméra immobile : rien à refaire.
    people.draw(shown, camera, viewport, world);
    people.draw({ ...shown }, { ...camera }, viewport, world);
    expect(asked).toBe(1);
    // Un autre instant, une autre caméra, une case repeinte : l'image se refait.
    people.draw({ ...shown, t: 0.5 }, camera, viewport, world);
    people.draw({ ...shown, t: 0.5 }, { ...camera, x: camera.x + 1 }, viewport, world);
    people.invalidate();
    people.draw({ ...shown, t: 0.5 }, { ...camera, x: camera.x + 1 }, viewport, world);
    expect(asked).toBe(4);
  });

  it('partage les textures de deux cultures de même habit, et en garde une par motif, variante et apparence', () => {
    const clothing = ['#a03030', '#30a030', '#a03030'];
    const { people, layer } = setup(1, { ...data.appearance, clothing });
    // Les cultures 1 et 3 portent le même habit, la culture 2 un autre.
    const groups = frame(5, [1, 100, 50, 1], [2, 104, 50, 3], [3, 108, 50, 2]);
    // Trois variantes d'adulte dans le premier groupe, la moyenne ailleurs.
    groups.statures.set([80, 96, 112, 96, 96]);
    people.draw(scene(groups), aimedAt(104, 50, 8), viewport, world);
    expect(people.stats.drawn).toBe(15);
    expect(people.stats.textures).toBe(4);
    expect(people.stats.cached).toBe(4);
    // Rangées dans une seule page de l'atlas dynamique : un seul lot de dessin.
    expect(people.stats.pages).toBe(1);
    const sources = new Set(rendered(layer).map((sprite) => sprite.texture.source));
    expect(sources.size).toBe(1);
    // La page part au GPU quand elle reçoit des motifs, et seulement alors.
    const [page] = [...sources];
    let updates = 0;
    page.on('update', () => {
      updates++;
    });
    // Une image nouvelle, où le troisième groupe compte un adulte plus petit : un motif de plus.
    const next = { ...groups, statures: Uint8Array.from(groups.statures) };
    next.statures[10] = 84;
    people.draw(scene(next), aimedAt(104, 50, 8), viewport, world);
    expect(people.stats.cached).toBe(5);
    expect(updates).toBe(1);
    people.draw(scene(next), aimedAt(104, 49, 8), viewport, world);
    expect(updates).toBe(1);
  });
});
