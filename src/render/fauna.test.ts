import faunaAtlas from 'virtual:fauna-atlas';
import { describe, expect, it } from 'vitest';
import { FaunaTimeline } from '../app/faunaFrames';
import { PALETTE_ROLES } from '../core/data/humans';
import { FIXED } from '../core/position';
import {
  FAUNA_GAIT,
  FAUNA_MALE,
  FAUNA_YOUNG,
  type FaunaFrame,
  type FaunaLegArrays,
} from '../core/protocol';
import { splitmix32 } from '../core/rng';
import { dayIndex } from '../core/time';
import { KEPT } from '../gen/humans';
import { FAUNA_LEGEND, FAUNA_REGIONS, legendRole } from '../gen/legend';
import { advanceDay, step } from '../sim/day';
import { FaunaJournal, faunaFrame } from '../sim/fauna';
import { flatState, scatteredGroups, testData } from '../sim/testing';
import { parseColor } from './bake';
import { TILE_PX } from './camera';
import { viewDensity } from './crowd';
import {
  animationOf,
  FAUNA_ANIMATION,
  FAUNA_ATLAS,
  faunaPalette,
  FaunaLayer,
  idleFrame,
  moveFrame,
  phaseOf,
  type FaunaMotion,
} from './fauna';
import { LEVEL_ROWS } from './humans';
import {
  OBJECT_FLAG,
  type ObjectList,
  type ObjectPalette,
  type ObjectView,
  type PaletteSlots,
} from './objects';

const data = testData;
const rules = data.faunaRules;
const human = data.species.entries.at(0);
if (human === undefined) throw new Error('pas d’humains');
const reference = human.display.stature;
const WIDTH = 512;

/** Les places des palettes, sans GPU : chaque clé reçoit sa place à sa première demande. */
class Slots implements PaletteSlots {
  generation = 0;
  readonly keys: number[] = [];
  readonly palettes: ObjectPalette[] = [];
  slot(key: number, palette: () => ObjectPalette): number {
    const known = this.keys.indexOf(key);
    if (known >= 0) return known;
    this.keys.push(key);
    this.palettes.push(palette());
    return this.keys.length - 1;
  }
}

/** Un animal de la chronologie factice : sa position en cases, sa sorte, son allure, son sens. */
interface Animal {
  readonly x: number;
  readonly y: number;
  readonly kind?: number;
  readonly id?: number;
  readonly gait?: number;
  readonly facing?: number;
}

const noLegs = () => ({
  slots: new Uint32Array(0),
  days: new Uint32Array(0),
  start: new Int32Array(0),
  step: new Int32Array(0),
  count: new Uint16Array(0),
});

/** Une chronologie factice : des animaux immobiles, à l'allure et au sens donnés. */
class FakeMotion implements FaunaMotion {
  frame: FaunaFrame;
  version = 1;
  fallen = {
    count: 0,
    at: 0,
    generation: 0,
    kinds: new Uint8Array(0),
    ids: new Uint32Array(0),
    positions: new Int32Array(0),
    facing: new Int8Array(0),
  };
  readonly animals: Animal[];
  constructor(animals: Animal[]) {
    this.animals = animals;
    this.frame = {
      slots: Uint32Array.from(animals, (_, index) => index),
      ids: Uint32Array.from(animals, (animal, index) => animal.id ?? index + 1),
      kinds: Uint8Array.from(animals, (animal) => animal.kind ?? 0),
      herds: new Uint32Array(animals.length),
      positions: Int32Array.from(
        animals.flatMap((animal) => [Math.round(animal.x * FIXED), Math.round(animal.y * FIXED)]),
      ),
      legs: noLegs(),
    };
  }
  position(index: number, _t: number, out: Float64Array): void {
    out[0] = this.frame.positions[2 * index] ?? 0;
    out[1] = this.frame.positions[2 * index + 1] ?? 0;
  }
  gait(index: number): number {
    return this.animals[index]?.gait ?? FAUNA_GAIT.rest;
  }
  facing(index: number): number {
    return this.animals[index]?.facing ?? 0;
  }
}

/** La vue d'un écran de 1 280 × 720 pixels CSS visant le point (x, y), en cases. */
function viewAt(
  x: number,
  y: number,
  scale: number,
  { t = 0, walkMs = 0, resolution = 1 } = {},
): ObjectView {
  const density = viewDensity(scale, resolution, reference, LEVEL_ROWS);
  const halfWidth = (1280 * resolution) / 2 / scale;
  const halfHeight = (720 * resolution) / 2 / scale;
  return {
    scale,
    resolution,
    level: density.level,
    k: density.k,
    left: x * TILE_PX - halfWidth,
    right: x * TILE_PX + halfWidth,
    top: y * TILE_PX - halfHeight,
    bottom: y * TILE_PX + halfHeight,
    t,
    month: 0,
    walkMs,
    stepMs: 420,
  };
}

/** Ce que montre le motif `motif` de l'atlas : forme, jeune, animation, niveau et image. */
function motifOf(motif: number) {
  const { index, animations, levels, frames, forms } = faunaAtlas;
  for (let entry = 0; entry < index.length; entry++) {
    const start = index[entry] ?? -1;
    const animation = Math.floor(entry / levels) % animations.length;
    if (start < 0 || motif < start || motif >= start + (frames[animation] ?? 0)) continue;
    const formYoung = Math.floor(entry / levels / animations.length);
    return {
      form: forms[formYoung >> 1],
      young: formYoung % 2 === 1,
      animation: animations[animation],
      level: entry % levels,
      frame: motif - start,
    };
  }
  throw new Error(`motif ${String(motif)} hors de l'index`);
}

/** Les objets d'une liste, dans l'ordre du dessin. */
function objects(list: ObjectList) {
  return Array.from({ length: list.count }, (_, rank) => {
    const at = list.order[rank] ?? 0;
    const motif = list.motif[at] ?? 0;
    const box = FAUNA_ATLAS.motifs.slice(motif * 6, motif * 6 + 6);
    return {
      left: list.left[at] ?? 0,
      top: list.top[at] ?? 0,
      feet: list.feet[at] ?? 0,
      width: list.width[at] ?? 0,
      height: list.height[at] ?? 0,
      unit: list.unit[at] ?? 0,
      slot: list.slot[at] ?? 0,
      flip: ((list.flags[at] ?? 0) & OBJECT_FLAG.flip) !== 0,
      box,
      ...motifOf(motif),
    };
  });
}

describe('images du gibier (ADR 0018, § 7)', () => {
  it('tire l’animation de l’allure de l’état, et ses images de l’horloge de la marche et de l’animal', () => {
    expect(animationOf(FAUNA_GAIT.run)).toBe(FAUNA_ANIMATION.run);
    expect(animationOf(FAUNA_GAIT.walk)).toBe(FAUNA_ANIMATION.walk);
    expect(animationOf(FAUNA_GAIT.rest)).toBe(FAUNA_ANIMATION.idle);
    // `cadence` images par pas du rendu, déphasées par l'animal.
    expect([0, 209, 210, 420, 630, 840].map((ms) => moveFrame(ms, 420, 2, 0, 4))).toEqual([
      0, 0, 1, 2, 3, 0,
    ]);
    expect([0, 105, 210, 315].map((ms) => moveFrame(ms, 420, 4, 0, 4))).toEqual([0, 1, 2, 3]);
    expect(moveFrame(0, 420, 2, 0.5, 4)).toBe(2);
    // Le repos : debout, un coup d'oreille ou de queue, puis il broute, tête baissée et levée
    // tous les `chew`, puis debout jusqu'à la fin du cycle.
    const { idle } = rules;
    const at = (u: number) => idleFrame(u, 0, idle);
    expect([0, idle.flick - 1].map(at)).toEqual([0, 0]);
    expect([idle.flick, idle.graze - 1].map(at)).toEqual([1, 1]);
    expect([idle.graze, idle.graze + idle.chew - 1, idle.graze + idle.chew].map(at)).toEqual([
      2, 2, 3,
    ]);
    expect([idle.rise, idle.period - 1, idle.period].map(at)).toEqual([0, 0, 0]);
    expect(idleFrame(0, idle.flick / idle.period, idle)).toBe(1);
    // La phase propre de l'animal : le second tirage de sa suite SplitMix32, le premier donnant
    // son allure propre dans la simulation.
    const next = splitmix32(77);
    next();
    expect(phaseOf(77)).toBe(next() / 2 ** 32);
    expect(phaseOf(77)).toBe(phaseOf(77));
    expect(phaseOf(78)).not.toBe(phaseOf(77));
    const phases = Array.from({ length: 1000 }, (_, id) => phaseOf(id));
    expect(Math.min(...phases)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...phases)).toBeLessThan(1);
    expect(phases.filter((phase) => phase >= 0.5).length).toBeGreaterThan(400);
  });

  it('peint chaque pixel de chaque motif d’une espèce d’un ton de sa palette, aux rangs de ses rampes', () => {
    const { index, animations, levels, frames, forms } = faunaAtlas;
    let pixels = 0;
    for (const species of data.fauna.entries) {
      const palette = faunaPalette(species, rules.outline);
      expect(palette).toHaveLength(PALETTE_ROLES);
      expect(palette[KEPT]).toEqual([...parseColor(rules.outline), 255]);
      for (const region of FAUNA_REGIONS) {
        species.look[region]?.forEach((color, rank) => {
          expect(palette[legendRole(FAUNA_LEGEND, region, rank)]).toEqual([
            ...parseColor(color),
            255,
          ]);
        });
      }
      // Ses formes : l'adulte et le jeune de look.form, l'adulte de look.male.
      const shown = [
        [forms.indexOf(species.look.form), 0],
        [forms.indexOf(species.look.form), 1],
        ...(species.look.male === undefined ? [] : [[forms.indexOf(species.look.male), 0]]),
      ];
      for (const [form = 0, young = 0] of shown) {
        for (let animation = 0; animation < animations.length; animation++) {
          for (let level = 0; level < levels; level++) {
            const start =
              index[((form * 2 + young) * animations.length + animation) * levels + level] ?? -1;
            expect(start, `${species.id} ${String(form)}`).toBeGreaterThanOrEqual(0);
            for (let image = 0; image < (frames[animation] ?? 0); image++) {
              const at = (start + image) * 6;
              const [x = 0, y = 0, width = 0, height = 0] = FAUNA_ATLAS.motifs.slice(at, at + 4);
              for (let v = 0; v < height; v++) {
                for (let u = 0; u < width; u++) {
                  const role = FAUNA_ATLAS.roles[(y + v) * FAUNA_ATLAS.width + x + u] ?? 0;
                  if (role === 0) continue;
                  pixels++;
                  expect(palette[role]?.[3], `${species.id}, rôle ${String(role)}`).toBe(255);
                }
              }
            }
          }
        }
      }
    }
    expect(pixels).toBeGreaterThan(50_000);
    // Le lièvre n'a ni bois ni défenses : ces rôles n'ont pas de ton.
    const hare = data.fauna.entries.find((species) => species.id === 'hare');
    if (hare === undefined) throw new Error('pas de lièvre');
    expect(faunaPalette(hare, rules.outline)[legendRole(FAUNA_LEGEND, 'horn', 0)]).toBeUndefined();
  });
});

describe('le gibier dans le calque commun (ADR 0018, § 7 ; ADR 0017, § 7)', () => {
  it('pose chaque animal sur ses pieds, au pixel entier, au niveau et à la densité de la vue', () => {
    for (const resolution of [1, 2.75]) {
      for (const scale of [8, 24]) {
        const view = viewAt(100.5, 50.5, scale, { resolution });
        const motion = new FakeMotion([{ x: 100.5, y: 50.5, facing: -1 }]);
        const layer = new FaunaLayer(data, motion, WIDTH);
        const drawn = objects(layer.update(view, new Slots()));
        expect(drawn).toHaveLength(1);
        const deer = drawn.at(0);
        if (deer === undefined) throw new Error('rien de dessiné');
        expect([deer.form, deer.young, deer.animation, deer.level]).toEqual([
          'deer',
          false,
          'idle',
          view.level,
        ]);
        const [, , width = 0, height = 0, feetX = 0] = deer.box;
        const cell = TILE_PX * scale;
        expect(deer.feet).toBe(Math.round(50.5 * cell));
        expect(deer.left).toBe(Math.round(100.5 * cell) - feetX * view.k);
        expect(deer.top).toBe(deer.feet - height * view.k);
        expect([deer.width, deer.height, deer.unit]).toEqual([
          width * view.k,
          height * view.k,
          view.k,
        ]);
        expect(deer.flip).toBe(false);
        expect(Number.isInteger(deer.left) && Number.isInteger(deer.top)).toBe(true);
        expect(layer.stats.drawn).toBe(1);
      }
    }
  });

  it('retourne vers l’est autour du bord droit, et montre le cerf, le jeune et chaque espèce', () => {
    const view = viewAt(100.5, 50.5, 8);
    const motion = new FakeMotion([
      { x: 100.5, y: 50.1, facing: 1 },
      { x: 100.5, y: 50.2, kind: FAUNA_MALE, facing: -1 },
      { x: 100.5, y: 50.3, kind: FAUNA_YOUNG, facing: -1 },
      // Un jeune mâle : le cerf n'a pas de jeune, il se montre en faon.
      { x: 100.5, y: 50.4, kind: FAUNA_YOUNG | FAUNA_MALE, facing: -1 },
      { x: 100.5, y: 50.5, kind: 1, facing: -1 },
      { x: 100.5, y: 50.6, kind: 2 | FAUNA_YOUNG, facing: -1 },
    ]);
    const layer = new FaunaLayer(data, motion, WIDTH);
    const slots = new Slots();
    const drawn = objects(layer.update(view, slots));
    expect(drawn.map((entry) => [entry.form, entry.young])).toEqual([
      ['deer', false],
      ['stag', false],
      ['deer', true],
      ['deer', true],
      ['boar', false],
      ['hare', true],
    ]);
    // Vers l'est : retourné, ses pieds à la même colonne de l'écran, comptée depuis son bord droit.
    const east = drawn.at(0);
    if (east === undefined) throw new Error('rien de dessiné');
    const [, , width = 0, , feetX = 0] = east.box;
    expect(east.flip).toBe(true);
    expect(east.left).toBe(Math.round(100.5 * TILE_PX * 8) - (width - feetX) * view.k);
    expect(drawn.slice(1).every((entry) => !entry.flip)).toBe(true);
    // Une palette par espèce, rangée une fois, aux clés du gibier.
    expect(new Set(drawn.map((entry) => entry.slot)).size).toBe(3);
    expect(slots.keys).toEqual([2 ** 21, 2 ** 21 + 1, 2 ** 21 + 2]);
    // Sans étape connue, le sens vient de la phase de l'animal : la moitié vers l'est.
    const many = new FakeMotion(
      Array.from({ length: 200 }, (_, id) => ({ x: 100.5, y: 50.5, id: id + 1 })),
    );
    const flips = objects(new FaunaLayer(data, many, WIDTH).update(view, slots)).filter(
      (entry) => entry.flip,
    ).length;
    expect(flips).toBeGreaterThan(70);
    expect(flips).toBeLessThan(130);
  });

  it('montre l’animal de part et d’autre de la couture, et rien hors de la vue', () => {
    const scale = 8;
    const cell = TILE_PX * scale;
    const motion = new FakeMotion([
      { x: 0.3, y: 50.5, facing: -1 },
      { x: WIDTH - 0.3, y: 50.5, facing: -1 },
      { x: 200.5, y: 50.5, facing: -1 },
    ]);
    const layer = new FaunaLayer(data, motion, WIDTH);
    const feet = (view: ObjectView) =>
      objects(layer.update(view, new Slots())).map(
        (entry) => entry.left + (entry.box[4] ?? 0) * entry.unit,
      );
    // La vue sur la couture, côté ouest du monde : le premier à sa place, le deuxième dans la
    // copie de l'ouest ; le troisième, loin, n'est pas là.
    expect(feet(viewAt(0, 50.5, scale)).sort((a, b) => a - b)).toEqual([
      Math.round(-0.3 * cell),
      Math.round(0.3 * cell),
    ]);
    // Côté est : le premier dans la copie de l'est.
    expect(feet(viewAt(WIDTH, 50.5, scale)).sort((a, b) => a - b)).toEqual([
      Math.round((WIDTH - 0.3) * cell),
      Math.round((WIDTH + 0.3) * cell),
    ]);
    expect(feet(viewAt(200.5, 50.5, scale))).toEqual([Math.round(200.5 * cell)]);
    expect(feet(viewAt(300.5, 50.5, scale))).toEqual([]);
    expect(feet(viewAt(200.5, 120.5, scale))).toEqual([]);
  });

  it('anime la marche et la course à leur cadence et le repos en son cycle, figés en pause', () => {
    const view = (walkMs: number) => viewAt(100.5, 50.5, 8, { walkMs });
    const motion = new FakeMotion([
      { x: 100.5, y: 50.3, gait: FAUNA_GAIT.walk, facing: -1 },
      { x: 100.5, y: 50.4, gait: FAUNA_GAIT.run, facing: -1 },
      { x: 100.5, y: 50.5, gait: FAUNA_GAIT.rest, facing: -1 },
    ]);
    const layer = new FaunaLayer(data, motion, WIDTH);
    const slots = new Slots();
    const images = (walkMs: number) =>
      objects(layer.update(view(walkMs), slots)).map((entry) => [entry.animation, entry.frame]);
    const phases = [...motion.frame.ids].map((id) => phaseOf(id));
    const expected = (walkMs: number) => [
      ['walk', moveFrame(walkMs, 420, rules.cadence.walk, phases[0] ?? 0, 4)],
      ['run', moveFrame(walkMs, 420, rules.cadence.run, phases[1] ?? 0, 4)],
      ['idle', idleFrame(walkMs, phases[2] ?? 0, rules.idle)],
    ];
    const seen = new Set<string>();
    for (let walkMs = 0; walkMs < rules.idle.period; walkMs += 105) {
      const shown = images(walkMs);
      expect(shown).toEqual(expected(walkMs));
      for (const [animation, frame] of shown) seen.add(`${String(animation)} ${String(frame)}`);
      // En pause, l'horloge de la marche s'arrête : la même image.
      expect(images(walkMs)).toEqual(shown);
    }
    // Toutes les images de chaque animation se montrent au fil du cycle.
    expect(seen.size).toBe(12);
    // La version du calque est celle de la chronologie : la signature de l'image la lit.
    expect(layer.version).toBe(motion.version);
    motion.version++;
    expect(layer.version).toBe(motion.version);
  });

  it('fait tomber les morts là où ils étaient, puis les oublie ; pas ceux d’avant, au retour de la vue', () => {
    const motion = new FakeMotion([{ x: 100.5, y: 50.5, facing: -1 }]);
    const layer = new FaunaLayer(data, motion, WIDTH);
    const slots = new Slots();
    const shown = (t: number, walkMs: number) =>
      objects(layer.update(viewAt(100.5, 50.5, 8, { t, walkMs }), slots))
        .filter((entry) => entry.animation === 'fall')
        .map((entry) => [entry.form, entry.frame, entry.flip]);
    const fallen = (generation: number, at: number) => {
      motion.fallen = {
        count: 2,
        at,
        generation,
        kinds: Uint8Array.of(0, 1),
        ids: Uint32Array.of(40, 41),
        positions: Int32Array.of(100 * FIXED, 50 * FIXED, 101 * FIXED, 51 * FIXED),
        facing: Int8Array.of(1, -1),
      };
    };
    expect(shown(10, 1000)).toEqual([]);
    // Ils meurent à l'instant 10,5 : entre la mise à jour précédente (10) et celle-ci (11), à
    // mi-chemin, l'horloge de la marche valait 1 050.
    fallen(1, 10.5);
    expect(shown(11, 1100)).toEqual([
      ['deer', 0, true],
      ['boar', 0, false],
    ]);
    expect(shown(11, 1050 + rules.fall.stumble - 1)).toEqual([
      ['deer', 0, true],
      ['boar', 0, false],
    ]);
    expect(shown(11, 1050 + rules.fall.stumble)).toEqual([
      ['deer', 1, true],
      ['boar', 1, false],
    ]);
    expect(shown(11, 1050 + rules.fall.lie - 1)).toHaveLength(2);
    expect(shown(11, 1050 + rules.fall.lie)).toEqual([]);
    // Morts pendant que la vue était lointaine (le calque ne se mettait pas à jour) : longtemps
    // avant ce retour, ils ne tombent pas.
    expect(shown(20, 3000)).toEqual([]);
    fallen(2, 20.5);
    expect(shown(50, 6000)).toEqual([]);
    // Morts peu avant le retour : ils tombent, déjà à terre.
    fallen(3, 55);
    expect(shown(60, 7000)).toEqual([
      ['deer', 1, true],
      ['boar', 1, false],
    ]);
    // Une image en retard, d'un instant que la vue a déjà passé : ils tombent dès qu'elle arrive.
    fallen(4, 59);
    expect(shown(60, 7100)).toEqual([
      ['deer', 0, true],
      ['boar', 0, false],
    ]);
  });

  it('montre en course une fuite en forêt pluviale, que sa vitesse apparente ferait croire au pas', () => {
    // Requis 3 de la critique : la forêt pluviale coûte 2,5 à franchir ; un sanglier ou un cerf
    // en fuite y avance moins vite que la moyenne de son pas et de son galop, où le prototype
    // passait de la marche à la course. L'allure vient de l'état, par le protocole 7.
    const rainforest = data.biomes.indexOf('rainforest') ?? 0;
    const state = flatState('pluie', (world) => world.biome.fill(rainforest));
    step(state, scatteredGroups(state, 80), data);
    const journal = new FaunaJournal();
    state.fauna.journal = journal;
    const timeline = new FaunaTimeline(() => undefined);
    timeline.reset(faunaFrame(state, data), state, state.size.width);
    const layer = new FaunaLayer(data, timeline, state.size.width);
    const slots = new Slots();
    const { fauna } = state;
    let checked = 0;
    for (let days = 0; days < 60 && checked < 8; days++) {
      const members = advanceDay(state, [], data);
      const legs: FaunaLegArrays = journal.take();
      timeline.receive(state, legs, members === undefined ? undefined : faunaFrame(state, data));
      const now = dayIndex(state);
      timeline.show(now);
      const frame = timeline.frame;
      if (frame === undefined) throw new Error('pas d’image');
      frame.slots.forEach((slot, index) => {
        if (checked >= 8 || fauna.alive[slot] !== 1 || fauna.id[slot] !== frame.ids[index]) return;
        if (fauna.gait[slot] !== FAUNA_GAIT.run || (fauna.stepDays[slot] ?? 0) === 0) return;
        const species = data.fauna.entries.at(fauna.species[slot] ?? 0);
        if (species === undefined) return;
        const speed = Math.hypot(fauna.stepX[slot] ?? 0, fauna.stepY[slot] ?? 0) / FIXED;
        expect(speed).toBeLessThan((species.pace.walk + species.pace.run) / 2);
        expect(timeline.gait(index, now)).toBe(FAUNA_GAIT.run);
        const unitPx = (TILE_PX * 8) / FIXED;
        const footX = Math.round((fauna.x[slot] ?? 0) * unitPx);
        const footY = Math.round((fauna.y[slot] ?? 0) * unitPx);
        const view = viewAt((fauna.x[slot] ?? 0) / FIXED, (fauna.y[slot] ?? 0) / FIXED, 8, {
          t: now,
        });
        const drawn = objects(layer.update(view, slots)).filter((entry) => {
          const feetX = (entry.box[4] ?? 0) * entry.unit;
          const left = footX - (entry.flip ? entry.width - feetX : feetX);
          return entry.feet === footY && entry.left === left;
        });
        expect(drawn.map((entry) => entry.animation)).toContain('run');
        checked++;
      });
    }
    expect(checked).toBe(8);
  });
});
