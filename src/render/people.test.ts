import {
  BufferImageSource,
  Container,
  DOMAdapter,
  type Application,
  type ICanvas,
  type Particle,
  type ParticleContainer,
  type Shader,
  type Sprite,
  type Texture,
} from 'pixi.js';
import { describe, expect, it, vi } from 'vitest';
import { PositionMirror } from '../app/frames';
import { loadGameData, type Appearance } from '../core/data';
import { FAUNA_GAIT, NO_CARRIER, type GroupsFrame, type HumanLegArrays } from '../core/protocol';
import { FIXED } from '../core/position';
import { RandomStream, streamSeed } from '../core/rng';
import { visualCode } from '../core/visual';
import { CHUNK_PX } from './bake';
import { displayScale, physicalZoom, TILE_PX, visibleChunks, type Camera } from './camera';
import { viewDensity, type Box } from './crowd';
import { PALETTE_ROLES } from '../core/data/humans';
import { seasonFactor } from '../core/seasons';
import {
  FIRST_PALETTE_ROWS,
  PALETTES_PER_ROW,
  SHADOW_ROLE_RANGE,
  type PaletteTexture,
} from './humanShader';
import { DECOR_ATLAS } from './decor';
import { FAUNA_ATLAS, FaunaLayer, type FaunaMotion } from './fauna';
import { humanAtlas, LEVEL_ROWS } from './humans';
import {
  ObjectList,
  PALETTE_KEYS,
  type ObjectAtlas,
  type ObjectSource,
  type ObjectView,
  type PaletteSlots,
} from './objects';
import { coverUniforms } from './mapShader';
import { bannerCloth, PeopleLayer, stepDuration, STEP_MS, type PeopleScene } from './people';

// Le calque des individus, sur une application factice : la scène, et la densité de l'écran
// du rendu. On y lit ce que PixiJS rendrait, sprite par sprite, dans l'ordre de ses enfants.

const data = loadGameData();
const testSeasons = data.seasons;
const human = data.species.entries.at(0);
if (human === undefined) throw new Error('pas d’humains');
const { stature: reference, carry } = human.display;
const viewport = { width: 1280, height: 720 };
/** Un monde Petit : 512 × 256 cases. */
const world = { width: 512 * TILE_PX, height: 256 * TILE_PX };
const grid = { columns: world.width / CHUNK_PX, rows: world.height / CHUNK_PX };

/**
 * Le calque sur une fausse application : sans GPU, ou, avec `gl`, un rendu qui se dit WebGL,
 * pour que le calque pose son shader (rien n'y dessine).
 */
function setup(resolution: number, appearance: Appearance = data.appearance, gl = false) {
  const stage = new Container();
  const renderer: { resolution: number; gl?: object } = { resolution };
  if (gl) renderer.gl = {};
  const app = { renderer, stage } as unknown as Application;
  const people = new PeopleLayer(app, { genetics: data.genetics, appearance, reference });
  const layer = stage.children.at(0);
  if (!(layer instanceof Container)) throw new Error('calque introuvable');
  return { people, layer, renderer };
}

/** Ce que le calque garde pour lui : les particules des humains et leurs palettes. */
const insides = (people: PeopleLayer) =>
  people as unknown as { humans: ParticleContainer; palettes: PaletteTexture };

/** Aucune étape. */
const noLegs = (): HumanLegArrays => ({
  slots: new Uint32Array(0),
  days: new Uint32Array(0),
  start: new Int32Array(0),
  step: new Int32Array(0),
  count: new Uint16Array(0),
  acts: new Uint8Array(0),
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
    activities: new Uint8Array(total),
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

/** Rectangle d'un sprite de bannière à l'écran, en pixels physiques. */
function boxOf(sprite: Sprite, resolution: number): Box {
  return {
    left: Math.round(sprite.position.x * resolution),
    top: Math.round(sprite.position.y * resolution),
    width: Math.round(sprite.texture.width * Math.abs(sprite.scale.x) * resolution),
    height: Math.round(sprite.texture.height * Math.abs(sprite.scale.y) * resolution),
  };
}

/**
 * Rectangle d'une particule d'humain à l'écran, en pixels physiques : retournée (échelle
 * négative), elle s'étend à gauche de sa position, de la largeur de son motif.
 */
function particleBox(particle: Particle, resolution: number): Box {
  const { width, height } = particle.texture.frame;
  const left = particle.scaleX < 0 ? particle.x + width * particle.scaleX : particle.x;
  return {
    left: Math.round(left * resolution),
    top: Math.round(particle.y * resolution),
    width: Math.round(width * Math.abs(particle.scaleX) * resolution),
    height: Math.round(height * Math.abs(particle.scaleY) * resolution),
  };
}

/**
 * Ce que PixiJS rendrait, dans son ordre, le dernier devant : les bannières, sprites du calque
 * des bannières, puis les humains, particules du conteneur qui les suit. Chaque dessin dit ce
 * qu'il montre : l'identifiant de l'individu, ou celui du groupe en négatif.
 */
function rendered(people: PeopleLayer, layer: Container, resolution: number) {
  // Le calque ne se trie pas : ses enfants se rendent dans leur ordre.
  expect(layer.sortableChildren).toBe(false);
  const { sprites, particles, ids } = people.shown;
  return [
    ...sprites
      .filter((sprite) => sprite.visible)
      .map((sprite) => ({
        box: boxOf(sprite, resolution),
        entity: Number(sprite.label),
        texture: sprite.texture as unknown,
        unit: sprite.scale.x * resolution,
      })),
    ...particles.map((particle, index) => ({
      box: particleBox(particle, resolution),
      entity: ids[index] ?? 0,
      texture: particle.texture as unknown,
      unit: particle.scaleX * resolution,
    })),
  ];
}

const contains = (box: Box, x: number, y: number) =>
  x >= box.left && x < box.left + box.width && y >= box.top && y < box.top + box.height;

describe('bannière d’un groupe sur la carte (REN-08, A-1)', () => {
  it('se dessine à la densité de la carte, sur ses pixels, à toute densité et tout zoom', () => {
    const group = scene(frame(20, [7, 100, 50, 1]));
    for (const resolution of [1, 1.25, 1.5, 1.75, 2, 2.25, 2.625, 2.75, 3]) {
      const { people } = setup(resolution);
      for (const zoom of [0.25, 0.4096, 0.5, 0.8, 1, 2]) {
        const label = `densité ${String(resolution)}, zoom ${String(zoom)}`;
        // Une caméra entre deux pixels : les bords des blocs de la carte s'arrondissent.
        const camera = aimedAt(100, 50, zoom, 0.3, -0.7);
        people.draw(group, camera, viewport, world);
        expect(people.close, label).toBe(false);
        // Une bannière par copie visible du monde, plus étroit que l'écran au zoom 0,25.
        const banners = people.shown.sprites;
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

  it('teint la bannière du tissu que porte le plus grand nombre de ses membres, d’après leurs codes d’apparence', () => {
    const appearance: Appearance = data.appearance;
    const cloth = bannerCloth(appearance);
    const tunic = appearance.cultureOutfits.indexOf('tunic') + 1;
    const index = (id: string | undefined) =>
      appearance.fabrics.findIndex((fabric) => fabric.id === id);
    const skin = (id: string) =>
      appearance.skinPalettes.find((palette) => palette.id === id)?.upTo ?? 0;
    const linen = appearance.fabrics.find((fabric) => fabric.id === 'linen');
    // Des codes d'apparence complets (sexe, âge, cheveux, gris) : seul le teint compte. Le groupe
    // tient les codes 1 à 3 d'une image qui en a d'autres autour.
    const codes = [
      visualCode(1, 2, skin('dark'), 3, 0),
      visualCode(0, 2, skin('light'), 1, 0),
      visualCode(1, 1, skin('light'), 0, 2),
      visualCode(0, 0, skin('medium'), 2, 0),
      visualCode(1, 2, skin('dark'), 3, 0),
    ];
    expect(cloth(tunic, codes, 1, 3)).toBe(index(linen?.onSkin?.light));
    expect(cloth(tunic, codes, 3, 2)).toBe(index('linen'));
    expect(index(linen?.onSkin?.light)).not.toBe(index('linen'));
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
        const first = rendered(people, layer, resolution).map((entry) => entry.box);
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
        expect(rendered(people, layer, resolution), label).toHaveLength(1);
        people.draw(pair, home, viewport, wide);
        const boxes = rendered(people, layer, resolution).map((entry) => entry.box);
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
    let flipped = 0;
    for (const resolution of [1, 2.75]) {
      const { people, layer } = setup(resolution);
      for (const zoom of [0.25, 0.5, 1, 2, 3, 4, 8]) {
        for (let trial = 0; trial < 3; trial++) {
          const camera = aimedAt(302, 121, zoom, random.nextRange(-8, 8), random.nextRange(-8, 8));
          people.draw(crowd, camera, viewport, world);
          // Ce que montre chaque dessin : un individu, ou un groupe en négatif ; des humains
          // retournés vers l'est parmi eux.
          const drawn = rendered(people, layer, resolution);
          flipped += drawn.filter((entry) => entry.unit < 0).length;
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
    // Les recouvrements ont bien été visités, de loin comme de près, humains retournés compris.
    expect(checked).toBeGreaterThan(1000);
    expect(persons).toBeGreaterThan(100);
    expect(flipped).toBeGreaterThan(50);
  });
});

describe('individus à leur position (ADR 0014, ADR 0016)', () => {
  it('dessine chacun à sa position, à la densité de la vue, à des positions entières de l’écran', () => {
    for (const resolution of [1, 2]) {
      const { people, layer } = setup(resolution);
      const groups = frame(4, [1, 101, 50, 1]);
      // Le quatrième membre, un quart de case à l'est des trois autres.
      groups.positions[6] += FIXED / 4;
      const camera = aimedAt(101, 50, 24, 0.3);
      people.draw(scene(groups), camera, viewport, world);
      const drawn = rendered(people, layer, resolution);
      expect(drawn).toHaveLength(4);
      const { k } = viewDensity(displayScale(24), resolution, reference, LEVEL_ROWS);
      for (const { box, unit, texture } of drawn) {
        expect(Number.isInteger(box.left) && Number.isInteger(box.top)).toBe(true);
        // k pixels physiques par pixel de motif, la même densité pour tous.
        expect(Math.abs(unit)).toBe(k);
        const frameHeight = (texture as { frame: { height: number } }).frame.height;
        expect(box.height).toBe(frameHeight * k);
      }
      expect(people.stats.level).toBe(0);
      expect(people.stats.k).toBe(k);
    }
  });

  it('dessine côte à côte, au plus court, les membres d’un groupe à cheval sur la couture', () => {
    const { people, layer } = setup(1);
    const groups = frame(2, [1, 511, 60, 1]);
    // L'un à l'ouest de la couture, en 511,8 ; l'autre à l'est, en 0,2.
    groups.positions[0] = Math.round(511.8 * FIXED);
    groups.positions[2] = Math.round(0.2 * FIXED);
    for (const x of [511, 0]) {
      people.draw(scene(groups), aimedAt(x, 60, 8), viewport, world);
      const boxes = rendered(people, layer, 1).map((entry) => entry.box);
      expect(boxes).toHaveLength(2);
      // 0,4 case d'écart à l'écran, et non le tour du monde, au motif près.
      const centers = boxes.map((box) => box.left + box.width / 2).sort((a, b) => a - b);
      const gap = (centers[1] ?? 0) - (centers[0] ?? 0);
      expect(Math.abs(gap - 0.4 * TILE_PX * 8)).toBeLessThanOrEqual(
        Math.max(...boxes.map((box) => box.width)),
      );
    }
    // Au zoom le plus faible, le monde plus étroit que l'écran : une bannière par copie.
    people.draw(scene(groups), { x: 0, y: 60 * TILE_PX, zoom: 0.25 }, viewport, world);
    const copies = rendered(people, layer, 1).length;
    expect(copies).toBeGreaterThanOrEqual(Math.floor(viewport.width / (world.width * 0.25)));
    expect(copies).toBeLessThanOrEqual(Math.ceil(viewport.width / (world.width * 0.25)) + 1);
  });

  it('passe des bannières aux individus au seuil de 8 pixels CSS, en zoomant puis en dézoomant', () => {
    for (const resolution of [1, 2.75]) {
      const { people, layer } = setup(resolution);
      const groups = scene(frame(20, [1, 200, 100, 1], [2, 203, 101, 2]));
      const threshold = resolution === 1 ? 3 : 8;
      for (const zoom of [1, 2, 2.5, 2.9, 3, 4, 8, 4, 3, 2.9, 2.5, 2, 1]) {
        const label = `densité ${String(resolution)}, zoom ${String(zoom)}`;
        const scale = physicalZoom(zoom, resolution);
        people.draw(groups, aimedAt(201, 100, scale), viewport, world);
        expect(people.close, label).toBe(scale >= threshold);
        expect(rendered(people, layer, resolution).length, label).toBe(scale >= threshold ? 40 : 2);
        expect(people.shown.particles.length, label).toBe(scale >= threshold ? 40 : 0);
      }
    }
  });

  it('anime la marche et le repos à la cadence du rendu, figés en pause, et retourne le marcheur vers l’est', () => {
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
        acts: Uint8Array.of(0),
      },
    };
    const look = (walkMs: number, t: number) => {
      people.draw({ ...scene(walker, walkMs), t }, aimedAt(101, 50, 8), viewport, world);
      return new Map(rendered(people, layer, 1).map((entry) => [entry.entity, entry]));
    };
    const step = STEP_MS.slowest;
    const walking = new Set<unknown>();
    const resting = new Set<unknown>();
    for (let walkMs = 0; walkMs < 2 * step; walkMs += step / 4) {
      walking.add(look(walkMs, 1.5).get(1)?.texture);
      resting.add(look(walkMs, 1.5).get(2)?.texture);
    }
    // Les huit images de la marche en deux pas ; au repos, les images de la respiration.
    expect(walking.size).toBe(8);
    expect(resting.size).toBeGreaterThan(1);
    expect([...walking].some((texture) => resting.has(texture))).toBe(false);
    // Vers l'est : retourné ; arrêté, il garde son sens.
    expect(look(0, 1.5).get(1)?.unit).toBeLessThan(0);
    expect(look(0, 20).get(1)?.unit).toBeLessThan(0);
    // L'étape finie, le marcheur reprend le repos.
    const still = new Set<unknown>();
    for (let walkMs = 0; walkMs < 2000; walkMs += 130) still.add(look(walkMs, 20).get(1)?.texture);
    expect([...still].some((texture) => walking.has(texture))).toBe(false);
    // Une horloge de marche arrêtée, comme en pause, fige l'image, quel que soit l'instant.
    expect(look(step / 3, 1.5).get(1)?.texture).toBe(look(step / 3, 1.6).get(1)?.texture);
    // Une image de marche toutes les 105 ms à ×½ et ×1, toutes les 50 ms au plus vite.
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

  it('expose la version de ce qu’il dessine, que lit la signature de l’image (ADR 0010)', () => {
    const { people } = setup(1);
    const shown = scene(frame(5, [1, 100, 50, 1]));
    const camera = aimedAt(100, 50, 8);
    const start = people.drawVersion;
    people.draw(shown, camera, viewport, world);
    const drawn = people.drawVersion;
    expect(drawn).toBeGreaterThan(start);
    // Une image inchangée ne change pas la version ; une image refaite, un monde vidé, si.
    people.draw(shown, camera, viewport, world);
    expect(people.drawVersion).toBe(drawn);
    // L'horloge de la marche avance : l'animation refait l'image, et la version suit.
    people.draw({ ...shown, walkMs: 105 }, camera, viewport, world);
    expect(people.drawVersion).toBe(drawn + 1);
    people.draw({ ...shown, t: 0.5 }, camera, viewport, world);
    expect(people.drawVersion).toBe(drawn + 2);
    people.invalidate();
    people.draw({ ...shown, t: 0.5 }, camera, viewport, world);
    expect(people.drawVersion).toBe(drawn + 3);
    people.clear();
    expect(people.drawVersion).toBe(drawn + 4);
  });

  it('refait l’image quand la cadence des pas ou la densité de l’écran change, et seulement alors', () => {
    const { people, renderer } = setup(1);
    const shown = scene(frame(5, [1, 100, 50, 1]));
    const camera = aimedAt(100, 50, 8);
    people.draw(shown, camera, viewport, world);
    const drawn = people.drawVersion;
    // La vitesse change la cadence des pas : la même horloge montre une autre image.
    expect(STEP_MS.fastest).not.toBe(shown.stepMs);
    people.draw({ ...shown, stepMs: STEP_MS.fastest }, camera, viewport, world);
    expect(people.drawVersion).toBe(drawn + 1);
    people.draw({ ...shown, stepMs: STEP_MS.fastest }, camera, viewport, world);
    expect(people.drawVersion).toBe(drawn + 1);
    // Le navigateur change de densité (écran, zoom du navigateur) : tout se redispose.
    renderer.resolution = 2;
    people.draw({ ...shown, stepMs: STEP_MS.fastest }, camera, viewport, world);
    expect(people.drawVersion).toBe(drawn + 2);
  });

  it('pose au premier dessin d’un rendu WebGL le shader des palettes, envoie les palettes et le fait suivre la texture quand elle double', () => {
    const update = vi.spyOn(BufferImageSource.prototype, 'update');
    // PixiJS sonde la précision du GPU sur un canevas à la création d'un programme : sans DOM, un
    // canevas sans contexte WebGL suffit, et rien ne se compile.
    const adapter = DOMAdapter.get();
    DOMAdapter.set({
      ...adapter,
      createCanvas: () => ({ getContext: () => null }) as unknown as ICanvas,
    });
    try {
      // Sans GPU, aucun shader : les essais disposent sans lui.
      const plain = setup(1);
      plain.people.draw(scene(frame(5, [1, 100, 50, 1])), aimedAt(100, 50, 8), viewport, world);
      expect(insides(plain.people).humans.shader).toBeUndefined();
      // Huit cultures, six teints, quatre cheveux et deux crans de gris : 384 apparences, de
      // quoi doubler deux fois la texture et porter les places au-delà de 255.
      const { people } = setup(1, data.appearance, true);
      const { humans } = insides(people);
      expect(humans.shader).toBeUndefined();
      const codes: number[] = [];
      for (const skin of [0, 3, 6, 8, 11, 14]) {
        for (let hair = 0; hair < 4; hair++) {
          for (const grey of [0, 1]) codes.push(visualCode(1, 2, skin, hair, grey));
        }
      }
      const groups = frame(
        codes.length,
        ...Array.from({ length: 8 }, (_, culture): [number, number, number, number] => [
          culture + 1,
          100,
          50,
          culture + 1,
        ]),
      );
      groups.sprites.set(Array.from({ length: 8 }, () => codes).flat());
      people.draw(scene(groups), aimedAt(100, 50, 8), viewport, world);
      const { palettes } = insides(people);
      // PixiJS le type présent ; il ne l'est qu'une fois posé.
      const shader = (humans as { shader?: Shader }).shader;
      expect(shader?.glProgram.fragment).toContain('uPalettes');
      expect(palettes.count).toBe(8 * codes.length);
      expect(palettes.rows).toBeGreaterThanOrEqual((8 * codes.length) / PALETTES_PER_ROW);
      expect(palettes.rows).toBeGreaterThan(FIRST_PALETTE_ROWS);
      // Le shader lit la texture d'aujourd'hui, à son nombre de rangées, et elle est partie au
      // GPU ; les sources remplacées se sont libérées.
      const resources = shader?.resources as {
        uPalettes: BufferImageSource;
        humans: { uniforms: { uPaletteRows: number } };
      };
      // Des identités, comparées en booléens : un échec n'imprime pas deux textures entières.
      expect(
        resources.uPalettes === palettes.source,
        'le shader lit la texture d’aujourd’hui',
      ).toBe(true);
      expect(resources.humans.uniforms.uPaletteRows).toBe(palettes.rows);
      expect(update.mock.contexts.includes(palettes.source), 'palettes envoyées').toBe(true);
      // Une image de plus, rien de nouveau : rien ne repart.
      update.mockClear();
      people.draw({ ...scene(groups), t: 0.25 }, aimedAt(100, 50, 8), viewport, world);
      expect(update.mock.contexts.includes(palettes.source), 'rien à renvoyer').toBe(false);
      // Un monde vidé : une texture neuve, que le shader suit aussitôt.
      people.clear();
      expect(resources.uPalettes === insides(people).palettes.source, 'texture neuve suivie').toBe(
        true,
      );
      expect(resources.humans.uniforms.uPaletteRows).toBe(FIRST_PALETTE_ROWS);
    } finally {
      update.mockRestore();
      DOMAdapter.set(adapter);
    }
  });

  it('compte en pause les apparences distinctes de l’image, même quand l’image d’avant ne les a pas comptées', () => {
    const { people } = setup(1);
    const camera = aimedAt(100, 50, 8);
    // Une image comptée : une seule apparence pour les cinq adultes.
    people.draw(scene(frame(5, [1, 100, 50, 1])), camera, viewport, world);
    expect(people.stats.textures).toBe(1);
    // La suivante ne compte pas : trois teints, trois apparences.
    const varied = frame(5, [1, 100, 50, 1]);
    varied.sprites.set([
      visualCode(1, 2, 0, 2, 0),
      visualCode(1, 2, 7, 2, 0),
      visualCode(1, 2, 15, 2, 0),
      visualCode(1, 2, 0, 2, 0),
      visualCode(1, 2, 0, 2, 0),
    ]);
    const paused = scene(varied);
    people.draw(paused, camera, viewport, world);
    expect(people.stats.drawn).toBe(5);
    // En pause, l'image inchangée ne se redessine pas, mais se compte une fois.
    people.draw(paused, camera, viewport, world);
    expect(people.stats.textures).toBe(3);
    people.draw(paused, camera, viewport, world);
    expect(people.stats.textures).toBe(3);
  });

  it('oublie les particules d’une foule passée, et toutes au changement de monde', () => {
    const { people, layer } = setup(1);
    const crowd = frame(
      20,
      ...Array.from({ length: 10 }, (_, group): [number, number, number, number] => [
        group + 1,
        100 + 2 * group,
        50,
        1,
      ]),
    );
    // Un groupe de rendu : ce qui y change ne fait pas refaire les instructions de la carte.
    expect(layer.isRenderGroup).toBe(true);
    people.draw(scene(crowd), aimedAt(110, 50, 8), viewport, world);
    expect(people.stats.drawn).toBe(200);
    expect(people.shown.particles).toHaveLength(200);
    // Loin de la foule : plus aucune particule à dessiner.
    people.draw(scene(crowd), aimedAt(400, 200, 8), viewport, world);
    expect(people.stats.drawn).toBe(0);
    expect(people.shown.particles).toHaveLength(0);
    // La réserve se défait de la foule passée en quelques secondes d'images.
    for (let image = 0; image < 400; image++) {
      people.draw(scene(crowd), aimedAt(400 + (image % 2), 200, 8), viewport, world);
    }
    expect(people.pooled.particles).toBeLessThanOrEqual(64);
    // Elle sert encore : la foule revient.
    people.draw(scene(crowd), aimedAt(110, 50, 8), viewport, world);
    expect(rendered(people, layer, 1)).toHaveLength(200);
    people.clear();
    expect(people.shown.particles).toHaveLength(0);
    expect(people.pooled).toEqual({ particles: 0, sprites: 0 });
  });

  it('peint tous les humains d’une même texture, et range chaque apparence une fois, sans rien recolorer d’une image à l’autre', () => {
    const { people } = setup(1);
    // Trois groupes, de trois cultures : trois tenues, et deux teints dans le premier.
    const groups = frame(5, [1, 100, 50, 1], [2, 104, 50, 2], [3, 108, 50, 3]);
    groups.sprites[0] = visualCode(1, 2, 14, 2, 0);
    people.draw(scene(groups), aimedAt(104, 50, 8), viewport, world);
    expect(people.stats.drawn).toBe(15);
    expect(people.stats.textures).toBe(4);
    expect(people.stats.cached).toBe(4);
    // Une seule source pour tous les humains : un seul appel de dessin.
    const sources = new Set(people.shown.particles.map((particle) => particle.texture.source));
    expect(sources.size).toBe(1);
    const palettes = people.paletteTexture;
    expect(palettes.written).toBe(4);
    // La marche, le pas mensuel, une autre caméra : aucune palette de plus.
    for (let image = 1; image <= 20; image++) {
      people.draw(
        { ...scene(groups, image * 105), t: image / 10 },
        aimedAt(104, 50 + image / 40, 8),
        viewport,
        world,
      );
    }
    expect(palettes.written).toBe(4);
    // La couleur de chaque particule désigne la place de son apparence.
    const slots = new Set(people.shown.particles.map((particle) => particle.color & 0xffff));
    expect(slots).toEqual(new Set([0, 1, 2, 3]));
  });

  it('ne recolore rien à chaque image, même quand la vue montre des centaines d’apparences', () => {
    const { people } = setup(1);
    // Quarante groupes de vingt, aux teints, cheveux et gris variés, sur huit cultures.
    const groups = Array.from({ length: 40 }, (_, group): [number, number, number, number] => [
      group + 1,
      90 + (group % 10) * 3,
      45 + Math.floor(group / 10) * 3,
      1 + (group % 8),
    ]);
    const crowd = frame(20, ...groups);
    for (let member = 0; member < crowd.ids.length; member++) {
      crowd.sprites[member] = visualCode(
        member % 2,
        2,
        member % 16,
        (member >> 1) % 4,
        (member >> 3) % 4,
      );
    }
    people.draw(scene(crowd), aimedAt(104, 49, 4), viewport, world);
    const palettes = people.paletteTexture;
    const looks = palettes.written;
    expect(looks).toBeGreaterThan(100);
    expect(people.stats.drawn).toBe(800);
    for (let image = 1; image <= 30; image++) {
      people.draw(
        { ...scene(crowd, image * 50), t: image / 30 },
        aimedAt(104, 49, 4),
        viewport,
        world,
      );
    }
    expect(palettes.written).toBe(looks);
    expect(people.stats.cached).toBe(looks);
  });
});

// Le calque commun (ADR 0017, § 7) : une source d'objets factice, sur un atlas de rôles à elle,
// de la largeur de celui des humains. Son motif : six pixels de large, des rangées peintes au
// rôle 17 au-dessus des pieds, deux rangées d'ombre portée dessous.
const OBJECT_PAINT = 17;
const OBJECT_SHADOW = SHADOW_ROLE_RANGE[0];
const FAKE_ATLAS: ObjectAtlas = (() => {
  const width = humanAtlas.width;
  const roles = new Uint8Array(width * 12);
  for (let v = 0; v < 10; v++) {
    for (let u = 0; u < 6; u++) roles[v * width + u] = v < 8 ? OBJECT_PAINT : OBJECT_SHADOW;
  }
  // Un trou au milieu du motif : là, on voit au travers.
  roles[width + 2] = 0;
  return { width, height: 12, roles, motifs: [0, 0, 6, 10, 3, 8], shadowRoles: [OBJECT_SHADOW] };
})();
/** Le même atlas, sans ombre déclarée : ses deux rangées du bas sont peintes sur l'objet. */
const UNSHADED_ATLAS: ObjectAtlas = { ...FAKE_ATLAS, shadowRoles: undefined };

/** Une source d'objets factice : des objets aux pieds donnés, en cases, une seule palette. */
class FakeObjects implements ObjectSource {
  atlas = FAKE_ATLAS;
  version = 0;
  updates = 0;
  views: ObjectView[] = [];
  generations: number[] = [];
  private readonly list = new ObjectList();
  readonly feet: readonly (readonly [number, number])[];
  constructor(feet: readonly (readonly [number, number])[]) {
    this.feet = feet;
  }
  update(view: ObjectView, palettes: PaletteSlots): ObjectList {
    this.updates++;
    this.views.push(view);
    this.generations.push(palettes.generation);
    const { list } = this;
    list.clear();
    const cell = TILE_PX * view.scale;
    const slot = palettes.slot(PALETTE_KEYS.decor[0], () =>
      Array.from({ length: PALETTE_ROLES }, (_, role) =>
        role === OBJECT_PAINT ? [10, 120, 30, 255] : undefined,
      ),
    );
    for (const [x, y] of this.feet) {
      const footX = Math.round(x * cell);
      const footY = Math.round(y * cell);
      const { k } = view;
      list.push(footX - 3 * k, footY - 8 * k, footY, 6 * k, 10 * k, 0, slot, k);
    }
    list.sort();
    return list;
  }
}

/** Le calque, l'atlas factice (ou les atlas `atlases`) rangé sous celui des humains. */
function setupWithObjects(resolution: number, gl = false, ...atlases: ObjectAtlas[]) {
  const stage = new Container();
  const renderer: { resolution: number; gl?: object } = { resolution };
  if (gl) renderer.gl = {};
  const app = { renderer, stage } as unknown as Application;
  const people = new PeopleLayer(app, {
    genetics: data.genetics,
    appearance: data.appearance,
    reference,
    objects: atlases.length === 0 ? [FAKE_ATLAS] : atlases,
  });
  const layer = stage.children.at(0);
  if (!(layer instanceof Container)) throw new Error('calque introuvable');
  return { people, layer, renderer };
}

describe('calque commun : décor et humains (ADR 0017, § 7)', () => {
  it('trie les objets avec les humains par leurs pieds, d’un seul conteneur et d’une seule texture', () => {
    const { people, layer } = setupWithObjects(1);
    // Un humain au centre de la case (100, 50) ; un objet aux pieds au-dessus des siens, un
    // autre au-dessous, un troisième à pieds égaux.
    const objects = new FakeObjects([
      [100.5, 50.3],
      [100.6, 50.75],
      [100.4, 50.5],
    ]);
    const shown = { ...scene(frame(1, [1, 100, 50, 1])), objects: [objects], month: 6.5 };
    people.draw(shown, aimedAt(100, 50, 8), viewport, world);
    const drawn = rendered(people, layer, 1);
    // Les dessins, du fond vers l'avant : l'objet du fond, celui des pieds égaux, l'humain,
    // l'objet de devant.
    expect(drawn.map((entry) => entry.entity)).toEqual([0, 0, 1, 0]);
    const tops = drawn.map((entry) => entry.box.top + entry.box.height);
    expect(tops[0]).toBeLessThan(tops[2] ?? 0);
    expect(tops[3]).toBeGreaterThan(tops[2] ?? 0);
    // Des positions entières de l'écran, à la densité de la vue.
    for (const entry of drawn) {
      expect(Number.isInteger(entry.box.left) && Number.isInteger(entry.box.top)).toBe(true);
    }
    // Une seule source de texture : les rôles des humains, puis ceux des objets.
    const sources = new Set(people.shown.particles.map((particle) => particle.texture.source));
    expect(sources.size).toBe(1);
    expect(people.stats.objects).toBe(3);
    // Une palette pour les trois objets, rangée une fois.
    const slots = new Set(people.shown.particles.map((particle) => particle.color & 0xffff));
    expect(slots.size).toBe(2);
    expect(people.paletteTexture.count).toBe(2);
  });

  it('touche ce qu’on voit : un pixel peint d’un objet cache l’humain à l’appui, ni son ombre ni son trou', () => {
    for (const resolution of [1, 2.75]) {
      const { people, layer } = setupWithObjects(resolution);
      // L'objet de devant couvre le bas de l'humain.
      const objects = new FakeObjects([[100.52, 50.62]]);
      const shown = { ...scene(frame(1, [1, 100, 50, 1])), objects: [objects], month: 6.5 };
      people.draw(shown, aimedAt(100, 50, 8), viewport, world);
      const drawn = rendered(people, layer, resolution);
      const human = drawn.find((entry) => entry.entity === 1);
      const object = drawn.find((entry) => entry.entity === 0);
      if (human === undefined || object === undefined) throw new Error('dessins absents');
      expect(drawn.indexOf(object)).toBeGreaterThan(drawn.indexOf(human));
      const counts = { painted: 0, hole: 0 };
      const unit = object.unit;
      for (let y = object.box.top; y < object.box.top + object.box.height; y++) {
        for (let x = object.box.left; x < object.box.left + object.box.width; x++) {
          if (!contains(human.box, x + 0.5, y + 0.5)) continue;
          const u = Math.floor((x - object.box.left) / unit);
          const v = Math.floor((y - object.box.top) / unit);
          const role = FAKE_ATLAS.roles[v * FAKE_ATLAS.width + u] ?? 0;
          const picked = people.pick(x + 0.5, y + 0.5, 0);
          if (role === OBJECT_PAINT) {
            counts.painted++;
            expect(picked, `(${String(x)}, ${String(y)}) peint`).toBeUndefined();
          } else {
            counts.hole++;
            expect(picked?.kind === 'person' ? picked.id : undefined).toBe(1);
          }
        }
      }
      expect(counts.painted).toBeGreaterThan(0);
      expect(counts.hole).toBeGreaterThan(0);
      // L'ombre portée tombe sous les pieds de l'objet, au sol : elle ne cache rien, et un
      // appui sur elle trouve, à la tolérance du doigt, l'humain tout proche ; un appui sur un
      // pixel peint de l'objet, non.
      const slop = 12;
      const shadowRow = object.box.top + 9 * unit;
      const left = object.box.left + 2 * unit;
      const onShadow = people.pick(left + 0.5, shadowRow + 0.5, slop);
      expect(onShadow?.kind === 'person' ? onShadow.id : undefined, 'ombre').toBe(1);
      const onPaint = people.pick(left + 0.5, object.box.top + 7 * unit + 0.5, slop);
      expect(onPaint, 'pixel peint').toBeUndefined();
      // Un atlas sans ombre déclarée (le gibier) : le même rôle y est peint sur l'objet, et cache.
      const plain = setupWithObjects(resolution, false, UNSHADED_ATLAS);
      const unshaded = new FakeObjects([[100.52, 50.62]]);
      unshaded.atlas = UNSHADED_ATLAS;
      plain.people.draw({ ...shown, objects: [unshaded] }, aimedAt(100, 50, 8), viewport, world);
      expect(plain.people.pick(left + 0.5, shadowRow + 0.5, slop), 'rôle peint').toBeUndefined();
      // Au-dessus de l'objet, l'humain se touche.
      const above = people.pick(human.box.left + 1, human.box.top + 1, 0);
      expect(above?.kind === 'person' ? above.id : undefined).toBe(1);
    }
  });

  it('compte à part les objets et la mise à jour de chaque source, sans durée quand l’image ne se refait pas', () => {
    // Relecture 2b.6, problème 20 : la ligne du décor comptait aussi le gibier, et gardait, en
    // pause, la durée de la dernière image refaite.
    const { people } = setupWithObjects(1);
    const near = new FakeObjects([
      [100.5, 50.5],
      [100.6, 50.7],
    ]);
    // Le second objet de cette source tombe hors de la vue.
    const far = new FakeObjects([
      [100.4, 50.4],
      [400.5, 50.5],
    ]);
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => (clock += 1));
    const shown = { ...scene(frame(1, [1, 100, 50, 1])), objects: [near, far], month: 6.5 };
    people.draw(shown, aimedAt(100, 50, 8), viewport, world);
    expect(people.objectCost(near)?.shown).toBe(2);
    expect(people.objectCost(far)?.shown).toBe(1);
    expect(people.stats.objects).toBe(3);
    expect(people.objectCost(near)?.ms).toBeGreaterThan(0);
    expect(people.objectCost(far)?.ms).toBeGreaterThan(0);
    expect(people.stats.objectsMs).toBeGreaterThan(0);
    // La même image : aucune source ne se met à jour, et aucune durée ne se compte.
    people.draw(shown, aimedAt(100, 50, 8), viewport, world);
    expect(near.updates).toBe(1);
    expect(people.stats.objectsMs).toBe(0);
    expect(people.objectCost(near)).toEqual({ shown: 2, ms: 0 });
    expect(people.objectCost(far)).toEqual({ shown: 1, ms: 0 });
    // Une source que la scène ne porte pas n'a rien coûté.
    expect(people.objectCost(new FakeObjects([]))).toBeUndefined();
    now.mockRestore();
  });

  it('montre les objets de près seulement, sur un monde sans foule aussi, et ne les met à jour qu’aux images refaites', () => {
    const { people, layer } = setupWithObjects(1);
    const objects = new FakeObjects([[300.5, 120.5]]);
    // Un monde sans image des groupes : le décor se montre quand même.
    const empty = new PositionMirror({ carry, passable: () => true });
    const bare: PeopleScene = {
      source: empty,
      t: 0,
      walkMs: 0,
      stepMs: STEP_MS.slowest,
      passable: () => true,
      objects: [objects],
      month: 6.5,
    };
    people.draw(bare, aimedAt(300, 120, 8), viewport, world);
    expect(rendered(people, layer, 1).map((entry) => entry.entity)).toEqual([0]);
    // À la densité et au niveau des individus.
    const density = viewDensity(displayScale(8), 1, reference, LEVEL_ROWS);
    expect(objects.views.at(-1)?.level).toBe(density.level);
    expect(objects.views.at(-1)?.k).toBe(density.k);
    // La même image : la source n'est pas rappelée, et rien ne se refait.
    const version = people.drawVersion;
    people.draw(bare, aimedAt(300, 120, 8), viewport, world);
    expect(objects.updates).toBe(1);
    expect(people.drawVersion).toBe(version);
    // Le jour change, ou la source : l'image se refait.
    people.draw({ ...bare, month: 6.6 }, aimedAt(300, 120, 8), viewport, world);
    expect(objects.updates).toBe(2);
    expect(people.drawVersion).toBe(version + 1);
    objects.version++;
    people.draw({ ...bare, month: 6.6 }, aimedAt(300, 120, 8), viewport, world);
    expect(objects.updates).toBe(3);
    expect(people.drawVersion).toBe(version + 2);
    // De loin (zooms 1 et 2), ni objet ni mise à jour ; sans source, rien non plus.
    for (const zoom of [1, 2]) {
      people.draw({ ...bare, month: 6.6 }, aimedAt(300, 120, zoom), viewport, world);
      expect(rendered(people, layer, 1)).toEqual([]);
    }
    expect(objects.updates).toBe(3);
    people.draw({ ...bare, objects: [] }, aimedAt(300, 120, 8), viewport, world);
    expect(rendered(people, layer, 1)).toEqual([]);
    // Un autre monde : une texture des palettes neuve, d'une autre génération, que la source
    // reçoit, pour redemander ses places.
    people.clear();
    people.draw(bare, aimedAt(300, 120, 8), viewport, world);
    expect(new Set(objects.generations).size).toBe(2);
    expect(objects.generations.at(-1)).toBeGreaterThan(objects.generations.at(0) ?? 0);
  });

  it('refuse un atlas d’objets d’une autre largeur, et une source dont l’atlas n’est pas rangé', () => {
    const stage = new Container();
    const app = { renderer: { resolution: 1 }, stage } as unknown as Application;
    const narrow = { ...FAKE_ATLAS, width: 512 };
    expect(
      () =>
        new PeopleLayer(app, {
          genetics: data.genetics,
          appearance: data.appearance,
          reference,
          objects: [narrow],
        }),
    ).toThrow(/512/);
    const { people } = setup(1);
    const shown = { ...scene(frame(1, [1, 100, 50, 1])), objects: [new FakeObjects([])] };
    expect(() => {
      people.draw(shown, aimedAt(100, 50, 8), viewport, world);
    }).toThrow(/atlas/);
  });

  it('fait lire au shader le sol sous l’ombre « ground » : origine de la carte, échelle, saison', () => {
    const adapter = DOMAdapter.get();
    DOMAdapter.set({
      ...adapter,
      createCanvas: () => ({ getContext: () => null }) as unknown as ICanvas,
    });
    try {
      for (const resolution of [1, 2.75]) {
        const { people } = setupWithObjects(resolution, true);
        const objects = new FakeObjects([[100.5, 50.5]]);
        const ground = {
          data: new BufferImageSource({ resource: new Uint8Array(4 * 8), width: 4, height: 2 }),
          calendars: new BufferImageSource({
            resource: new Uint8Array(4 * 16),
            width: 4,
            height: 4,
          }),
          tones: new BufferImageSource({ resource: new Uint8Array(4 * 6), width: 2, height: 3 }),
          columns: 4,
          rows: 2,
          biomes: 3,
          covers: coverUniforms(testSeasons),
        };
        people.setGround(ground);
        const camera = aimedAt(100, 50, 8 * resolution);
        const month = 1.25;
        people.draw(
          { ...scene(frame(1, [1, 100, 50, 1])), objects: [objects], month },
          camera,
          viewport,
          world,
        );
        const shader = (insides(people).humans as { shader?: Shader }).shader;
        const resources = shader?.resources as {
          uGround: BufferImageSource;
          uGroundCalendars: BufferImageSource;
          uGroundTones: BufferImageSource;
          ground: {
            uniforms: {
              uGroundView: Float32Array;
              uGroundCells: Float32Array;
              uGroundBiomes: number;
              uSeason: number;
              uDay: number;
              uSnowRamp: Float32Array;
              uIceRamp: Float32Array;
              uSeaIceRamp: Float32Array;
              uForestSnow: number;
            };
          };
        };
        expect(resources.uGround === ground.data, 'texture des saisons lue').toBe(true);
        expect(resources.uGroundCalendars === ground.calendars, 'calendriers lus').toBe(true);
        expect(resources.uGroundTones === ground.tones, 'tons d’ombre lus').toBe(true);
        const scale = displayScale(camera.zoom);
        const originX = Math.round(viewport.width / 2 - camera.x * scale);
        const originY = Math.round(viewport.height / 2 - camera.y * scale);
        expect(Array.from(resources.ground.uniforms.uGroundView)).toEqual(
          [originX / resolution, originY / resolution, scale / resolution, 0].map(Math.fround),
        );
        expect(Array.from(resources.ground.uniforms.uGroundCells)).toEqual([4, 2]);
        expect(resources.ground.uniforms.uGroundBiomes).toBe(3);
        expect(resources.ground.uniforms.uSeason).toBe(Math.fround(seasonFactor(month)));
        // Le jour continu de l'année et les rampes de data/seasons.json, comme la carte.
        expect(resources.ground.uniforms.uDay).toBe(Math.fround(month * 30));
        expect(Array.from(resources.ground.uniforms.uSnowRamp)).toEqual(
          Array.from(ground.covers.snow),
        );
        expect(Array.from(resources.ground.uniforms.uSeaIceRamp)).toEqual(
          [-6, 4, 0.85].map(Math.fround),
        );
        expect(resources.ground.uniforms.uForestSnow).toBe(Math.fround(testSeasons.snow.forest));
      }
    } finally {
      DOMAdapter.set(adapter);
    }
  });
});

// Le gibier (ADR 0018, § 7) : une vraie source, FaunaLayer, sur l'atlas du build rangé sous ceux
// des humains et du décor, que mène une chronologie factice : un animal immobile, au repos.
function oneAnimal(x: number, y: number, kind: number, facing: number): FaunaMotion {
  return {
    frame: {
      slots: Uint32Array.of(0),
      ids: Uint32Array.of(7),
      kinds: Uint8Array.of(kind),
      positions: Int32Array.of(Math.round(x * FIXED), Math.round(y * FIXED)),
      legs: noLegs(),
    },
    version: 1,
    moved: [],
    fallen: {
      count: 0,
      at: 0,
      generation: 0,
      kinds: new Uint8Array(0),
      ids: new Uint32Array(0),
      positions: new Int32Array(0),
      facing: new Int8Array(0),
    },
    span(_index, out) {
      out[0] = Math.round(x * FIXED);
      out[1] = 0;
      out[2] = Math.round(y * FIXED);
      out[3] = 0;
    },
    position(_index, _t, out) {
      out[0] = Math.round(x * FIXED);
      out[1] = Math.round(y * FIXED);
    },
    gait: () => FAUNA_GAIT.rest,
    facing: () => facing,
  };
}

describe('calque commun : le gibier (ADR 0018, § 7)', () => {
  it('trie l’animal avec l’humain par ses pieds ; sans ombre, ses pixels peints le cachent à l’appui, et il ne se choisit pas', () => {
    for (const resolution of [1, 2.75]) {
      const { people, layer } = setupWithObjects(resolution, false, DECOR_ATLAS, FAUNA_ATLAS);
      // Un sanglier qui va vers l'est, ses pieds devant ceux de l'humain de la case (100, 50).
      const game = new FaunaLayer(data, oneAnimal(100.6, 50.7, 1, 1), 512);
      const shown = { ...scene(frame(1, [1, 100, 50, 1])), objects: [game], month: 6.5 };
      people.draw(shown, aimedAt(100, 50, 8), viewport, world);
      const drawn = rendered(people, layer, resolution);
      const person = drawn.find((entry) => entry.entity === 1);
      const boar = drawn.find((entry) => entry.entity === 0);
      if (person === undefined || boar === undefined) throw new Error('dessins absents');
      expect(drawn.indexOf(boar)).toBeGreaterThan(drawn.indexOf(person));
      expect(people.stats.objects).toBe(1);
      // Retourné vers l'est : son échelle est négative.
      expect(boar.unit).toBeLessThan(0);
      const unit = Math.abs(boar.unit);
      const { frame: motif } = boar.texture as Texture;
      const top = humanAtlas.height + DECOR_ATLAS.height;
      expect(motif.y).toBeGreaterThanOrEqual(top);
      const counts = { painted: 0, hole: 0 };
      for (let y = boar.box.top; y < boar.box.top + boar.box.height; y++) {
        for (let x = boar.box.left; x < boar.box.left + boar.box.width; x++) {
          if (!contains(person.box, x + 0.5, y + 0.5)) continue;
          const u = Math.floor((x - boar.box.left) / unit);
          const v = Math.floor((y - boar.box.top) / unit);
          const column = motif.x + motif.width - 1 - u;
          const role = FAUNA_ATLAS.roles[(motif.y - top + v) * FAUNA_ATLAS.width + column] ?? 0;
          const picked = people.pick(x + 0.5, y + 0.5, 0);
          if (role !== 0) {
            counts.painted++;
            expect(picked, `(${String(x)}, ${String(y)}) peint`).toBeUndefined();
          } else {
            counts.hole++;
            expect(picked?.kind === 'person' ? picked.id : undefined).toBe(1);
          }
        }
      }
      expect(counts.painted).toBeGreaterThan(0);
      expect(counts.hole).toBeGreaterThan(0);
      // Au-dessus de lui, l'humain se touche.
      const above = people.pick(person.box.left + 1, person.box.top + 1, 0);
      expect(above?.kind === 'person' ? above.id : undefined).toBe(1);
      // De loin, rien : le gibier ne se montre que dans la vue rapprochée.
      people.draw(shown, aimedAt(100, 50, 2), viewport, world);
      expect(people.stats.objects).toBe(0);
    }
  });
});
