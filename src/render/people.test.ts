import { BufferImageSource, Container, Sprite, type Application } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { loadGameData, type Appearance } from '../core/data';
import { NO_CARRIER, type GroupsFrame } from '../core/protocol';
import { FIXED } from '../core/position';
import { RandomStream, streamSeed } from '../core/rng';
import { visualCode } from '../core/visual';
import { CHUNK_PX, parseColor } from './bake';
import { displayScale, TILE_PX, visibleChunks, type Camera } from './camera';
import type { Box } from './crowd';
import { PeopleLayer } from './people';

// Le calque des groupes, sur une application factice : la scène, et la densité de l'écran
// du rendu. On y lit ce que PixiJS rendrait, sprite par sprite, dans l'ordre de son tri.

const data = loadGameData();
const viewport = { width: 1280, height: 720 };
/** Un monde Petit : 512 × 256 cases. */
const world = { width: 512 * TILE_PX, height: 256 * TILE_PX };
const grid = { columns: world.width / CHUNK_PX, rows: world.height / CHUNK_PX };

function setup(resolution: number, appearance: Appearance = data.appearance) {
  const stage = new Container();
  const app = { renderer: { resolution }, stage } as unknown as Application;
  const people = new PeopleLayer(app, { genetics: data.genetics, appearance });
  const layer = stage.children.at(0);
  if (!(layer instanceof Container)) throw new Error('calque introuvable');
  return { people, layer };
}

/**
 * Groupes de `size` adultes : [identifiant, colonne, ligne, culture], chacun au centre de la
 * case de son groupe.
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
    statures: new Uint8Array(total).fill(96),
    positions,
    carriers: new Uint32Array(total).fill(NO_CARRIER),
    legs: {
      slots: new Uint32Array(0),
      days: new Uint32Array(0),
      start: new Int32Array(0),
      step: new Int32Array(0),
      count: new Uint16Array(0),
    },
  };
}

/** Montre une image dont les membres se tiennent au centre de la case de leur groupe. */
function showResting(people: PeopleLayer, groups: GroupsFrame): void {
  people.show(groups, 512);
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

/** Les sprites visibles, dans l'ordre où PixiJS les rend après son tri : le dernier devant. */
function rendered(layer: Container): Sprite[] {
  // Ce que fait le rendu avant de collecter les enfants (collectRenderables).
  layer.sortChildren();
  return layer.children.filter(
    (child): child is Sprite => child instanceof Sprite && child.visible,
  );
}

const contains = (box: Box, x: number, y: number) =>
  x >= box.left && x < box.left + box.width && y >= box.top && y < box.top + box.height;

describe('bannière d’un groupe sur la carte (REN-08, A-1)', () => {
  it('se dessine à la densité de la carte, sur ses pixels, à toute densité et tout zoom', () => {
    const group = frame(20, [7, 100, 50, 1]);
    for (const resolution of [1, 1.25, 1.5, 1.75, 2, 2.25, 2.625, 2.75, 3]) {
      const { people, layer } = setup(resolution);
      showResting(people, group);
      for (const zoom of [0.25, 0.4096, 0.5, 0.8, 1, 2]) {
        const label = `densité ${String(resolution)}, zoom ${String(zoom)}`;
        // Une caméra entre deux pixels : les bords des blocs de la carte s'arrondissent.
        const camera = aimedAt(100, 50, zoom, 0.3, -0.7);
        people.draw(camera, viewport, world, 0);
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
          expect(banner.scale.x * resolution, label).toBeCloseTo(mapPixel, 9);
          expect(banner.scale.y * resolution, label).toBeCloseTo(mapPixel, 9);
          // Sur la grille des pixels de la carte : à une position entière, alignée sur le
          // bord d'un bloc à un nombre entier de pixels de carte près.
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

describe('ordre des dessins et groupe sous un appui (W-7)', () => {
  it('montre devant, sur tout le recouvrement de deux bannières d’une ligne, le groupe que rend pick()', () => {
    // A = groupe 1 en (230, 110), B = groupe 2 en (231, 110) : même ligne, cases voisines,
    // sur un monde plus large que l'écran, que chacun ne voit qu'une fois.
    const wide = { width: 1024 * TILE_PX, height: 512 * TILE_PX };
    const pair = frame(20, [1, 230, 110, 2], [2, 231, 110, 3]);
    for (const resolution of [1, 2]) {
      for (const zoom of [0.5, 1, 2]) {
        const label = `densité ${String(resolution)}, zoom ${String(zoom)}`;
        const { people, layer } = setup(resolution);
        showResting(people, pair);
        const home = aimedAt(230, 110, zoom);
        people.draw(home, viewport, wide, 0);
        const first = rendered(layer).map((sprite) => boxOf(sprite, resolution));
        expect(first, label).toHaveLength(2);
        const [a, b] = [...first].sort((p, q) => p.left - q.left);
        // La caméra s'écarte : A sort de l'écran par la gauche, B reste dessiné, 100 pixels
        // plus bas, et son sprite passe derrière l'autre dans le tri. Puis elle revient : à
        // pied égal, seul le rang de chaque sprite départage A et B.
        const scale = displayScale(zoom);
        const away = {
          ...home,
          x: home.x + (a.left + a.width + 2) / scale,
          y: home.y - 100 / scale,
        };
        people.draw(away, viewport, wide, 0);
        expect(rendered(layer), label).toHaveLength(1);
        people.draw(home, viewport, wide, 0);
        const boxes = rendered(layer).map((sprite) => boxOf(sprite, resolution));
        expect(
          [...boxes].sort((p, q) => p.left - q.left),
          label,
        ).toEqual([a, b]);
        // Sur chaque pixel du recouvrement, le dernier sprite rendu est celui du groupe que
        // retrouve un appui.
        const top = Math.max(a.top, b.top);
        const bottom = Math.min(a.top + a.height, b.top + b.height);
        let checked = 0;
        for (let y = top; y < bottom; y++) {
          for (let x = b.left; x < a.left + a.width; x++) {
            const shown = boxes.findLast((box) => contains(box, x + 0.5, y + 0.5));
            const expected = shown?.left === a.left ? 1 : 2;
            expect(people.pick(home, viewport, wide, x + 0.5, y + 0.5), label).toBe(expected);
            checked++;
          }
        }
        expect(checked, label).toBeGreaterThan(0);
      }
    }
  });

  it('montre devant, en tout point, le groupe que rend pick(), quel qu’ait été le tri précédent', () => {
    // Huit groupes serrés, chacun de son habit, pour reconnaître le groupe d'un sprite.
    const clothing = [
      '#a03030',
      '#30a030',
      '#3030a0',
      '#a0a030',
      '#a030a0',
      '#30a0a0',
      '#d08040',
      '#6040d0',
    ];
    const cloths = clothing.map((color) => parseColor(color));
    const appearance = { ...data.appearance, clothing };
    /** Le groupe d'un sprite, d'après l'habit de sa texture : groupe i, culture et habit i. */
    const groupOf = (sprite: Sprite): number => {
      const { source } = sprite.texture;
      if (!(source instanceof BufferImageSource) || !(source.resource instanceof Uint8ClampedArray))
        throw new Error('texture inattendue');
      const pixels = source.resource;
      for (let index = 0; index < pixels.length; index += 4) {
        const cloth = cloths.findIndex(
          ([r, g, b]) => pixels[index] === r && pixels[index + 1] === g && pixels[index + 2] === b,
        );
        if (cloth >= 0) return cloth + 1;
      }
      throw new Error('habit introuvable');
    };
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
    const mismatches: string[] = [];
    let checked = 0;
    for (const resolution of [1, 2]) {
      const { people, layer } = setup(resolution, appearance);
      showResting(people, frame(6, ...groups));
      for (const zoom of [0.25, 0.5, 1, 2, 3, 4]) {
        for (let trial = 0; trial < 4; trial++) {
          // PixiJS trie ses enfants en place, par un tri stable : deux sprites de même
          // profondeur gardent l'ordre que leur a laissé l'histoire de la vue. On le tire
          // au hasard, avant de dessiner une vue au hasard.
          const keyed = layer.children.map((child) => ({ child, key: random.nextFloat() }));
          keyed.sort((p, q) => p.key - q.key);
          layer.removeChildren();
          if (keyed.length > 0) layer.addChild(...keyed.map(({ child }) => child));
          layer.sortChildren();
          const camera = aimedAt(302, 121, zoom, random.nextRange(-8, 8), random.nextRange(-8, 8));
          people.draw(camera, viewport, world, 0);
          const drawn = rendered(layer).map((sprite) => ({
            box: boxOf(sprite, resolution),
            group: groupOf(sprite),
          }));
          // Les pixels où se recouvrent deux groupes, un sur deux en chaque sens.
          const overlaps = new Map<string, [number, number]>();
          for (const [i, p] of drawn.entries()) {
            for (const q of drawn.slice(i + 1)) {
              if (p.group === q.group) continue;
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
            const picked = people.pick(camera, viewport, world, x, y);
            checked++;
            if (picked !== shown?.group && mismatches.length < 5) {
              mismatches.push(
                `densité ${String(resolution)}, zoom ${String(zoom)}, (${String(x)}, ${String(y)}) : ` +
                  `devant ${String(shown?.group)}, appui ${String(picked)}`,
              );
            }
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
    // Les recouvrements ont bien été visités, de loin comme de près.
    expect(checked).toBeGreaterThan(1000);
  });
});

describe('membres à leur position (ADR 0014)', () => {
  it('dessine chacun à sa position de l’image, à des positions entières de l’écran', () => {
    const { people, layer } = setup(2);
    const groups = frame(4, [1, 101, 50, 1]);
    // Le quatrième membre, un quart de case à l'est des trois autres.
    groups.positions[6] += FIXED / 4;
    const camera = aimedAt(101, 50, 12, 0.3);
    people.show(groups, 512);
    people.draw(camera, viewport, world, 0);
    const boxes = layer.children
      .filter((child): child is Sprite => child instanceof Sprite && child.visible)
      .map((sprite) => boxOf(sprite, 2));
    expect(boxes).toHaveLength(4);
    for (const box of boxes)
      expect(Number.isInteger(box.left) && Number.isInteger(box.top)).toBe(true);
    const lefts = boxes.map((box) => box.left).sort((a, b) => a - b);
    const shift = (lefts.at(-1) ?? 0) - (lefts.at(0) ?? 0);
    const scale = displayScale(12);
    expect(Math.abs(shift - 0.25 * TILE_PX * scale)).toBeLessThanOrEqual(1);
  });
});
