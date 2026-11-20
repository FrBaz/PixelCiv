import { describe, expect, it, vi } from 'vitest';
import { loadGameData, MAX_LOOKS, type ShadowMethod } from '../core/data';
import { SHADOW_METHODS } from '../core/data/decor';
import { PALETTE_ROLES } from '../core/data/humans';
import { geneRoles } from '../core/data/people';
import { MONTH_CENTERS, seasonFactor, southern } from '../core/seasons';
import { CHUNK_SIZE, emptyLayers, WORLD_SIZES, type WorldLayers } from '../core/world';
import { defaultWorldParams } from '../core/worldParams';
import {
  cellObjects,
  compileDecor,
  DECOR_KIND,
  DECOR_STATE,
  decorKey,
  entryOf,
  type DecorState,
  type Placed,
} from '../gen/decor';
import { DECOR_LEGEND, legendRole } from '../gen/legend';
import { generateWorld } from '../worldgen/generate';
import { parseColor } from './bake';
import { TILE_PX } from './camera';
import { viewDensity } from './crowd';
import {
  COLLECT_CELLS,
  DECOR_ATLAS,
  DECOR_FORMS,
  DECOR_LEVELS,
  decorPalette,
  DecorSource,
  MAX_CHUNKS,
  SHADOW_ROLES,
} from './decor';
import { LEVEL_ROWS } from './humans';
import type { ObjectList, ObjectPalette, ObjectView, PaletteSlots } from './objects';
import { biomeCodes, cellSeasonCodes, snowShare } from './seasons';

const data = loadGameData();
const table = compileDecor(data);
const size = WORLD_SIZES.small;
const human = data.species.entries.at(0);
if (human === undefined) throw new Error('pas d’humains');
const reference = human.display.stature;
let generated: WorldLayers | undefined;
/** Le monde Petit de la graine pixelciv, généré une fois. */
function layers(): WorldLayers {
  generated ??= generateWorld(
    { ...defaultWorldParams(data.worldgen.parameters, 'pixelciv', 'small'), size },
    data,
  );
  return generated;
}

/** Les places des palettes, sans GPU : chaque clé reçoit sa place à sa première demande. */
class Slots implements PaletteSlots {
  generation = 0;
  readonly keys: number[] = [];
  readonly palettes: ObjectPalette[] = [];
  /** Demandes de palettes, et palettes calculées. */
  asked = 0;
  built = 0;
  slot(key: number, palette: () => ObjectPalette): number {
    this.asked++;
    const known = this.keys.indexOf(key);
    if (known >= 0) return known;
    this.built++;
    this.keys.push(key);
    this.palettes.push(palette());
    return this.keys.length - 1;
  }
}

/** La vue de la caméra visant la case (x, y) d'un écran de 1 280 × 720 pixels, au mois `month`. */
function viewAt(x: number, y: number, scale: number, month: number, resolution = 1): ObjectView {
  const density = viewDensity(scale, resolution, reference, LEVEL_ROWS);
  const halfWidth = 1280 / 2 / scale;
  const halfHeight = 720 / 2 / scale;
  const cx = (x + 0.5) * TILE_PX;
  const cy = (y + 0.5) * TILE_PX;
  return {
    scale,
    resolution,
    level: density.level,
    k: density.k,
    left: cx - halfWidth,
    right: cx + halfWidth,
    top: cy - halfHeight,
    bottom: cy + halfHeight,
    t: 0,
    month,
    walkMs: 0,
    stepMs: 420,
  };
}

/** Ce que la source garde de chaque objet collecté (essais) : sa case, sa colonne, son apparence. */
function collected(source: DecorSource, list: ObjectList) {
  const inside = source as unknown as {
    cells: Int32Array;
    columns: Int32Array;
    looks: Uint16Array;
    variants: Uint8Array;
  };
  return Array.from({ length: list.count }, (_, at) => ({
    cell: inside.cells[at] ?? -1,
    column: inside.columns[at] ?? 0,
    look: inside.looks[at] ?? 0,
    variant: inside.variants[at] ?? 0,
    feet: list.feet[at] ?? 0,
    slot: list.slot[at] ?? -1,
    motif: list.motif[at] ?? -1,
  }));
}

/** La première case de terre qui répond à `test`, en parcourant les rangées de `rows`. */
function findCell(
  world: WorldLayers,
  rows: Iterable<number>,
  test: (cell: number) => boolean,
): { x: number; y: number } {
  for (const y of rows) {
    for (let x = 0; x < size.width; x++) {
      if (test(y * size.width + x)) return { x, y };
    }
  }
  throw new Error('aucune case');
}

const rgb = (color: readonly number[] | undefined) =>
  color === undefined ? 'aucune' : color.slice(0, 3).join(',');
const hexRgb = (hex: string) => parseColor(hex).join(',');

/** Les rôles que peignent les motifs d'une forme, à tous les niveaux. */
function formRoles(form: string): Set<number> {
  const roles = new Set<number>();
  const sources = Object.hasOwn(DECOR_FORMS, form) ? DECOR_FORMS[form] : [];
  for (const source of sources) {
    for (let level = 0; level < DECOR_LEVELS; level++) {
      const at = (source * DECOR_LEVELS + level) * 6;
      const [x = 0, y = 0, w = 0, h = 0] = DECOR_ATLAS.motifs.slice(at, at + 4);
      for (let v = y; v < y + h; v++) {
        for (let u = x; u < x + w; u++) {
          const role = DECOR_ATLAS.roles[v * DECOR_ATLAS.width + u] ?? 0;
          if (role !== 0) roles.add(role);
        }
      }
    }
  }
  return roles;
}

describe('palettes du décor (ADR 0017, § 2 et 5 ; REN-09)', () => {
  const snowBiome = data.biomes.entries.findIndex((biome) => biome.seasons.cover === 'snow');
  const cover = data.biomes.entries.at(snowBiome)?.seasons.palette;
  if (cover === undefined) throw new Error('aucun biome enneigé');
  const outline = hexRgb(data.decor.outline);
  const snowTones = [cover.light, cover.base, cover.shadow, data.decor.snow.deep].map(hexRgb);
  const role = (region: string, rank: number) => legendRole(DECOR_LEGEND, region, rank);
  const ramp = (palette: ObjectPalette, region: string) =>
    [0, 1, 2, 3].map((rank) => rgb(palette[role(region, rank)]));

  it('donne à chaque rôle de chaque motif un ton des données, dans chaque état, enneigé ou non', () => {
    let checked = 0;
    table.looks.forEach((look, index) => {
      const flora = entryOf(data.flora.entries, look.flora);
      const states: DecorState[] = [DECOR_STATE.summer];
      if (look.phenology === 'deciduous') states.push(DECOR_STATE.autumn, DECOR_STATE.bare);
      if (look.phenology === 'dry') states.push(DECOR_STATE.dry);
      for (const state of states) {
        for (const snowy of [false, true]) {
          for (const fruit of flora?.look.fruit === undefined ? [false] : [false, true]) {
            for (const method of SHADOW_METHODS) {
              const choice = { look: index, state, snowy, fruit, biome: snowBiome };
              const palette = decorPalette(data, table, choice, method);
              const label = `${look.form}, état ${String(state)}, neige ${String(snowy)}, fruit ${String(fruit)}, ${method}`;
              // Les tons attendus de chaque région, tous tirés des données.
              const foliage = flora?.look.foliage;
              const stateRamp =
                foliage === undefined
                  ? data.decor.stone
                  : state === DECOR_STATE.autumn
                    ? foliage.autumn
                    : state === DECOR_STATE.dry
                      ? foliage.dry
                      : state === DECOR_STATE.bare
                        ? (foliage.bare ?? foliage.autumn)
                        : foliage.summer;
              const current = (stateRamp ?? []).map(hexRgb);
              const wood = (flora?.look.wood ?? data.decor.stone).map(hexRgb);
              const mineral = entryOf(data.resources.entries, look.mineral);
              const deposit =
                mineral !== undefined && Object.hasOwn(data.decor.deposits, mineral.id)
                  ? data.decor.deposits[mineral.id]
                  : undefined;
              const ore = (deposit?.ore ?? data.decor.stone).map(hexRgb);
              const bareGrid = state === DECOR_STATE.bare && look.bare !== undefined;
              const expected: Record<string, string[]> = {
                foliage: current,
                wood,
                fruit:
                  fruit && flora?.look.fruit !== undefined
                    ? flora.look.fruit.tones.map(hexRgb)
                    : current,
                stone: data.decor.stone.map(hexRgb),
                ore,
                snow: snowy
                  ? snowTones
                  : flora === undefined
                    ? data.decor.stone.map(hexRgb)
                    : bareGrid
                      ? wood
                      : current,
                cap: snowy ? snowTones : [outline, outline, outline, outline],
              };
              for (const [region, tones] of Object.entries(expected)) {
                expect(ramp(palette, region), `${label}, ${region}`).toEqual(tones);
              }
              expect(rgb(palette[1]), label).toBe(outline);
              // Chaque rôle que peignent ses motifs a son ton, opaque ; l'ombre suit sa méthode.
              const forms = bareGrid ? [look.bare] : [look.form];
              for (const form of forms) {
                for (const used of formRoles(form)) {
                  const color = palette[used];
                  if (used === SHADOW_ROLES[0] || used === SHADOW_ROLES[1]) continue;
                  expect(color, `${label}, rôle ${String(used)}`).toBeDefined();
                  expect(color?.[3], `${label}, rôle ${String(used)}`).toBe(255);
                  checked++;
                }
              }
              const [even, odd] = SHADOW_ROLES.map((shadow) => palette[shadow]);
              const shades: Record<ShadowMethod, [string, string]> = {
                multiply: [
                  `0,0,0,${String(Math.round(data.decor.shadow.alpha * 255))}`,
                  `0,0,0,${String(Math.round(data.decor.shadow.alpha * 255))}`,
                ],
                dither: [`${outline},255`, 'aucune'],
                ground: [`${outline},255`, `${outline},255`],
                none: ['aucune', 'aucune'],
              };
              expect([even?.join(',') ?? 'aucune', odd?.join(',') ?? 'aucune'], label).toEqual(
                shades[method],
              );
            }
          }
        }
      }
    });
    expect(checked).toBeGreaterThan(1000);
  });

  it('peint hors neige le dessus des rochers de la pierre, et non d’une flore', () => {
    // Un rocher n'a pas d'espèce (flora −1) : la dernière de data/flora.json ne doit pas
    // y prendre sa place (relecture 2b.6, problème 1).
    const rocks = table.looks
      .map((look, index) => ({ look, index }))
      .filter(({ look }) => look.kind === DECOR_KIND.rock);
    expect(rocks.length).toBe(1 + Object.keys(data.decor.deposits).length);
    const stone = data.decor.stone.map(hexRgb);
    const withSnow = new Set<string>();
    for (const { look, index } of rocks) {
      expect(look.flora).toBe(-1);
      for (const method of SHADOW_METHODS) {
        const palette = decorPalette(
          data,
          table,
          { look: index, state: DECOR_STATE.summer, snowy: false, fruit: false, biome: 0 },
          method,
        );
        expect(ramp(palette, 'snow'), `${look.form}, ${method}`).toEqual(stone);
        expect(ramp(palette, 'wood'), `${look.form}, ${method}`).toEqual(stone);
      }
      // La neige du dessus est bien peinte sur les rochers épars (la croûte de sel n'en a pas).
      const snowRoles = [0, 1, 2, 3].map((rank) => role('snow', rank));
      if ([...formRoles(look.form)].some((used) => snowRoles.includes(used))) {
        withSnow.add(look.form);
      }
    }
    for (const rock of Object.values(data.decor.rocks)) expect(withSnow).toContain(rock.form);
  });

  it('ne laisse aux caducs sans grilles nues ni le vert de l’été, ni le fruit, à l’état nu', () => {
    const naked = table.looks
      .map((look, index) => ({ look, index }))
      .filter(({ look }) => look.phenology === 'deciduous' && look.bare === undefined);
    // Le buisson à baies, les roseaux, le saule nain (critique de la conception, point 5).
    expect(naked.length).toBeGreaterThanOrEqual(3);
    for (const { look, index } of naked) {
      const flora = entryOf(data.flora.entries, look.flora);
      const summer = new Set(flora?.look.foliage.summer.map(hexRgb));
      const fruitTones = new Set(flora?.look.fruit?.tones.map(hexRgb) ?? []);
      const palette = decorPalette(
        data,
        table,
        { look: index, state: DECOR_STATE.bare, snowy: false, fruit: false, biome: 0 },
        'ground',
      );
      for (const used of formRoles(look.form)) {
        const tone = rgb(palette[used]);
        expect(summer.has(tone), `${look.form}, rôle ${String(used)} : ${tone}`).toBe(false);
        expect(fruitTones.has(tone), `${look.form}, rôle ${String(used)} : ${tone}`).toBe(false);
      }
    }
  });

  it('tient, avec toutes les apparences des humains, dans la texture des palettes', () => {
    const hair = data.genetics.loci.at(geneRoles(data.genetics).loci.hair)?.alleles ?? [];
    const humans =
      data.appearance.skinPalettes.length *
      Math.max(1, hair.length) *
      (data.appearance.greying.length + 1) *
      data.appearance.outfits.length *
      2;
    // Les compositions d'une même méthode d'ombre : apparence, état, fruit, et la neige de
    // chaque biome enneigé.
    const snowy = data.biomes.entries.filter((biome) => biome.seasons.cover === 'snow').length;
    let decor = 0;
    for (const look of table.looks) {
      const states = look.phenology === 'deciduous' ? 3 : look.phenology === 'dry' ? 2 : 1;
      const fruit = entryOf(data.flora.entries, look.flora)?.look.fruit === undefined ? 1 : 2;
      decor += states * fruit * (1 + snowy);
    }
    expect(humans + decor).toBeLessThanOrEqual(MAX_LOOKS);
  });

  it('donne de quoi blanchir à toute forme posée là où il neige : région neige ou chaperon', () => {
    // Relecture 2b.6, problème 6 : la bruyère et les roseaux restaient verts et beiges sur un
    // sol blanc. Chaque variante d'une forme posée sur une case enneigée (mi-janvier au nord,
    // mi-juillet au sud), et la forme nue de son espèce s'il y en a, doit avoir dans sa grille
    // des pixels de la neige ou du chaperon, qui blanchissent sous la neige.
    const world = layers();
    const decorWorld = {
      size,
      layers: world,
      biomes: data.biomes.entries,
      table,
      key: decorKey('pixelciv'),
    };
    const codes = biomeCodes(data.biomes.entries);
    const placed: Placed[] = [0, 1, 2].map(() => ({ look: 0, variant: 0, fx: 0, fy: 0 }));
    const whitening = new Set(
      [0, 1, 2, 3].flatMap((rank) => [role('snow', rank), role('cap', rank)]),
    );
    const natural = { trees: 1, shrubs: 1, rocks: 1 };
    const shown = new Map<string, number>();
    for (let y = 0; y < size.height; y++) {
      const south = southern(y, size.height);
      const factor = seasonFactor(MONTH_CENTERS[south ? 6 : 0] ?? 0);
      for (let x = 0; x < size.width; x++) {
        const count = cellObjects(decorWorld, x, y, natural, placed);
        if (count === 0) continue;
        const cell = y * size.width + x;
        const cellCodes = cellSeasonCodes(world, codes, cell, south);
        const share = snowShare(
          cellCodes.temperature,
          cellCodes.amplitude,
          cellCodes.flags,
          factor,
        );
        if (!(share > 0 && share >= data.decor.snow.share)) continue;
        for (const object of placed.slice(0, count)) {
          const look = table.looks.at(object.look);
          if (look === undefined) continue;
          for (const form of look.bare === undefined ? [look.form] : [look.form, look.bare]) {
            shown.set(form, (shown.get(form) ?? 0) + 1);
          }
        }
      }
    }
    // Les formes des toundras, des taïgas et des montagnes, la bruyère et les roseaux compris.
    expect([...shown.keys()]).toEqual(expect.arrayContaining(['heather', 'reed', 'conifer']));
    for (const form of shown.keys()) {
      const sources = Object.hasOwn(DECOR_FORMS, form) ? DECOR_FORMS[form] : [];
      expect(sources.length, form).toBeGreaterThan(0);
      for (const source of sources) {
        // La grille elle-même, au premier niveau.
        const at = source * DECOR_LEVELS * 6;
        const [x = 0, y = 0, w = 0, h = 0] = DECOR_ATLAS.motifs.slice(at, at + 4);
        let white = 0;
        for (let v = y; v < y + h; v++) {
          for (let u = x; u < x + w; u++) {
            if (whitening.has(DECOR_ATLAS.roles[v * DECOR_ATLAS.width + u] ?? 0)) white++;
          }
        }
        expect(white, `${form}, source ${String(source)}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('collecte du décor (ADR 0017, § 6 à 8)', () => {
  const january = MONTH_CENTERS[0] ?? 0.5;
  const july = MONTH_CENTERS[6] ?? 6.5;

  it('montre les objets de la pose de chaque case visible, à leurs pieds, au pixel près', () => {
    const world = layers();
    const source = new DecorSource(data, world, size, 'pixelciv');
    const forest = findCell(world, [60, 70, 80, 90, 100], (cell) => (world.trees[cell] ?? 0) > 200);
    const scale = 8;
    const list = source.update(viewAt(forest.x, forest.y, scale, july), new Slots());
    const objects = collected(source, list);
    expect(objects.length).toBeGreaterThan(200);
    const decorWorld = {
      size,
      layers: world,
      biomes: data.biomes.entries,
      table,
      key: decorKey('pixelciv'),
    };
    const out: Placed[] = [0, 1, 2].map(() => ({ look: 0, variant: 0, fx: 0, fy: 0 }));
    const none = Object.hasOwn(data.decor.landUse, 'none') ? data.decor.landUse.none : undefined;
    if (none === undefined) throw new Error('occupation « none » absente');
    const cellPx = TILE_PX * scale;
    const seen = new Map<number, number>();
    for (const object of objects) {
      const x = object.cell % size.width;
      const y = Math.floor(object.cell / size.width);
      expect(((object.column % size.width) + size.width) % size.width).toBe(x);
      const count = cellObjects(decorWorld, x, y, none, out);
      const rank = seen.get(object.cell) ?? 0;
      seen.set(object.cell, rank + 1);
      const placed = out.slice(0, count).at(rank);
      expect(placed?.look, `case ${String(x)}, ${String(y)}`).toBe(object.look);
      expect(object.feet).toBe(Math.round((y + (placed?.fy ?? 0)) * cellPx));
    }
    // Rien d'autre que la pose : chaque case collectée a tous ses objets, et pas plus.
    for (const [cell, rank] of seen) {
      expect(
        cellObjects(decorWorld, cell % size.width, Math.floor(cell / size.width), none, out),
      ).toBe(rank);
    }
  });

  it('montre les mêmes objets de part et d’autre de la couture, dans chaque copie du monde', () => {
    const world = layers();
    const source = new DecorSource(data, world, size, 'pixelciv');
    const land = findCell(
      world,
      Array.from({ length: 200 }, (_, row) => 30 + row),
      (cell) => cell % size.width === 0 && (world.trees[cell] ?? 0) > 100,
    );
    const slots = new Slots();
    const objects = collected(source, source.update(viewAt(0, land.y, 4, july), slots));
    const west = objects.filter((object) => object.column < 0);
    const east = objects.filter((object) => object.column >= 0);
    expect(west.length).toBeGreaterThan(50);
    expect(east.length).toBeGreaterThan(50);
    // La même case, vue dans la copie de l'ouest puis dans celle du monde, a les mêmes objets.
    const far = new DecorSource(data, world, size, 'pixelciv');
    const copy = collected(
      far,
      far.update(viewAt(size.width, land.y, 4, july), new Slots()),
    ).filter((object) => object.column < size.width);
    const key = (object: { cell: number; look: number; variant: number }) =>
      `${String(object.cell)}:${String(object.look)}:${String(object.variant)}`;
    const inCopy = new Set(copy.map(key));
    for (const object of west) expect(inCopy.has(key(object)), key(object)).toBe(true);
    for (const object of west) {
      expect(object.column + size.width).toBe(object.cell % size.width);
    }
  });

  it('garde sa collecte tant que la vue, le niveau, k et le jour ne changent pas', () => {
    const world = layers();
    const source = new DecorSource(data, world, size, 'pixelciv');
    const inside = source as unknown as { collect(): void; refreshStates(): void };
    const collect = vi.spyOn(inside, 'collect');
    const refresh = vi.spyOn(inside, 'refreshStates');
    const slots = new Slots();
    const forest = findCell(world, [70, 80, 90], (cell) => (world.trees[cell] ?? 0) > 200);
    const view = viewAt(forest.x, forest.y, 4, july);
    const first = source.update(view, slots);
    const count = first.count;
    const feet = Array.from(first.feet.subarray(0, count));
    expect(collect).toHaveBeenCalledTimes(1);
    // La même vue, puis la vue décalée de moins d'un carré de collecte : rien ne se refait, et
    // les objets gardent leur place depuis l'origine de la carte.
    source.update(view, slots);
    const nudge = (COLLECT_CELLS * TILE_PX) / 8;
    source.update({ ...view, left: view.left + nudge, right: view.right + nudge }, slots);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(Array.from(first.feet.subarray(0, first.count))).toEqual(feet);
    // Un autre jour : les états se refont, la collecte non.
    refresh.mockClear();
    source.update({ ...view, month: july + 0.2 }, slots);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    // Au-delà d'un carré, à un autre niveau, après le pinceau, ou avec une texture des
    // palettes neuve : elle se refait.
    const far = COLLECT_CELLS * TILE_PX * 2;
    source.update({ ...view, left: view.left + far, right: view.right + far }, slots);
    expect(collect).toHaveBeenCalledTimes(2);
    source.update({ ...view, level: view.level + 1 }, slots);
    expect(collect).toHaveBeenCalledTimes(3);
    source.invalidate([{ column: 0, row: 0 }]);
    source.update({ ...view, level: view.level + 1 }, slots);
    expect(collect).toHaveBeenCalledTimes(4);
    slots.generation++;
    source.update({ ...view, level: view.level + 1 }, slots);
    expect(collect).toHaveBeenCalledTimes(5);
    collect.mockRestore();
    refresh.mockRestore();
  });

  it('reprend chaque palette des données, rangée une fois par composition', () => {
    const world = layers();
    const source = new DecorSource(data, world, size, 'pixelciv');
    const slots = new Slots();
    const forest = findCell(world, [70, 80, 90], (cell) => (world.trees[cell] ?? 0) > 200);
    for (const month of [january, july, MONTH_CENTERS[9] ?? 9.5]) {
      source.update(viewAt(forest.x, forest.y, 3, month), slots);
    }
    expect(slots.asked).toBeGreaterThan(slots.built);
    expect(new Set(slots.keys).size).toBe(slots.keys.length);
    // Toutes dans les clés du décor.
    for (const key of slots.keys) {
      expect(key).toBeGreaterThanOrEqual(2 ** 20);
      expect(key).toBeLessThan(2 ** 21);
    }
    expect(slots.palettes.every((palette) => palette.length === PALETTE_ROLES)).toBe(true);
  });

  it('dénude en janvier les caducs d’un hiver froid du nord, les enneige sur la neige de la carte', () => {
    const world = layers();
    const codes = biomeCodes(data.biomes.entries);
    const snowAt = (cell: number, month: number) => {
      const row = Math.floor(cell / size.width);
      const code = cellSeasonCodes(world, codes, cell, southern(row, size.height));
      return snowShare(code.temperature, code.amplitude, code.flags, seasonFactor(month));
    };
    // Une forêt du nord, aux hivers froids : des caducs, et de la neige en janvier.
    const cold = findCell(
      world,
      Array.from({ length: 80 }, (_, row) => 20 + row),
      (cell) =>
        (world.trees[cell] ?? 0) > 150 &&
        (world.temperature[cell] ?? 0) - (world.amplitude[cell] ?? 0) < -50 &&
        (world.temperature[cell] ?? 0) > 0 &&
        !southern(Math.floor(cell / size.width), size.height),
    );
    for (const month of [january, july]) {
      const source = new DecorSource(data, world, size, 'pixelciv');
      const slots = new Slots();
      const list = source.update(viewAt(cold.x, cold.y, 4, month), slots);
      const objects = collected(source, list);
      let deciduous = 0;
      let snowy = 0;
      for (const object of objects) {
        const look = table.looks.at(object.look);
        const flora = entryOf(data.flora.entries, look?.flora ?? -1);
        const palette = slots.palettes.at(object.slot);
        if (look === undefined || palette === undefined) throw new Error('objet sans palette');
        // Enneigé, exactement quand la part de neige de sa case atteint le seuil.
        const cap = rgb(palette[legendRole(DECOR_LEGEND, 'cap', 0)]);
        const isSnowy = cap !== hexRgb(data.decor.outline);
        const share = snowAt(object.cell, month);
        expect(isSnowy, `case ${String(object.cell)}, part ${String(share)}`).toBe(
          share > 0 && share >= data.decor.snow.share,
        );
        if (isSnowy) snowy++;
        if (look.phenology !== 'deciduous' || flora === undefined) continue;
        const coldest =
          ((world.temperature[object.cell] ?? 0) - (world.amplitude[object.cell] ?? 0)) / 10;
        if (coldest >= data.decor.foliage.bareBelow) continue;
        const summer = new Set(flora.look.foliage.summer.map(hexRgb));
        const leaf = rgb(palette[legendRole(DECOR_LEGEND, 'foliage', 1)]);
        if (month === january && look.kind !== DECOR_KIND.rock) {
          deciduous++;
          // Nu : la grille nue s'il en a, sinon ses tons d'hiver ; ni vert ni fruit.
          if (look.bare !== undefined) {
            expect(DECOR_FORMS[look.bare]).toContain(Math.floor(object.motif / DECOR_LEVELS));
          }
          expect(summer.has(leaf), `${look.form} en janvier : ${leaf}`).toBe(false);
          // Ni fruit, sauf ceux que les données gardent l'hiver (les massettes des roseaux).
          const fruit = flora.look.fruit;
          if (fruit !== undefined && !fruit.months.includes(0)) {
            expect(fruit.tones.map(hexRgb)).not.toContain(
              rgb(palette[legendRole(DECOR_LEGEND, 'fruit', 1)]),
            );
          }
        }
      }
      if (month === january) {
        expect(deciduous).toBeGreaterThan(20);
        expect(snowy).toBeGreaterThan(20);
      } else {
        expect(snowy).toBe(0);
      }
    }
  });

  it('borne son cache de blocs, oublie le moins récemment vu, et ne repose que les blocs nommés', () => {
    // Un monde Grand tout en forêt tempérée : plus de blocs que le cache n'en garde.
    const large = WORLD_SIZES.large;
    const world = emptyLayers(large);
    const forest = data.biomes.indexOf('temperate-forest');
    if (forest === undefined) throw new Error('forêt tempérée absente');
    world.biome.fill(forest);
    world.trees.fill(200);
    world.shrubs.fill(100);
    world.temperature.fill(100);
    const source = new DecorSource(data, world, large, 'pixelciv');
    const slots = new Slots();
    const columns = large.width / CHUNK_SIZE;
    const rows = large.height / CHUNK_SIZE;
    // Toutes les vues du monde, bloc par bloc, au zoom 16 : plus de blocs que le cache n'en garde.
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < columns; cx++) {
        source.update(viewAt(cx * CHUNK_SIZE + 32, cy * CHUNK_SIZE + 32, 16, july), slots);
        expect(source.cachedChunks).toBeLessThanOrEqual(MAX_CHUNKS);
      }
    }
    expect(columns * rows).toBeGreaterThan(MAX_CHUNKS);
    expect(source.cachedChunks).toBe(MAX_CHUNKS);
    // Le moins récemment vu part le premier : un bloc revu reste, quand d'autres arrivent.
    const at = (chunk: number) =>
      viewAt(
        (chunk % columns) * CHUNK_SIZE + 32,
        Math.floor(chunk / columns) * CHUNK_SIZE + 32,
        16,
        july,
      );
    const oldest = columns * rows - MAX_CHUNKS;
    const before = source.stats.chunksBuilt;
    source.update(at(oldest), slots);
    expect(source.stats.chunksBuilt).toBe(before);
    for (let chunk = 0; chunk < MAX_CHUNKS - 1; chunk++) source.update(at(chunk), slots);
    expect(source.stats.chunksBuilt).toBe(before + MAX_CHUNKS - 1);
    source.update(at(oldest), slots);
    expect(source.stats.chunksBuilt, 'le bloc revu est resté').toBe(before + MAX_CHUNKS - 1);
    source.update(at(oldest + 1), slots);
    expect(source.stats.chunksBuilt, 'son voisin, non revu, est parti').toBe(before + MAX_CHUNKS);
    const built = source.stats.chunksBuilt;
    // Le pinceau sur un bloc : lui seul se repose, les autres restent.
    const last = oldest + 1;
    const cached = source.cachedChunks;
    source.invalidate([{ column: last % columns, row: Math.floor(last / columns) }]);
    expect(source.cachedChunks).toBe(cached - 1);
    source.update({ ...at(last), month: july + 1 }, slots);
    expect(source.stats.chunksBuilt).toBe(built + 1);
    source.update({ ...at(oldest), month: july + 1 }, slots);
    expect(source.stats.chunksBuilt).toBe(built + 1);
    source.invalidate();
    expect(source.cachedChunks).toBe(0);
    // Le pinceau : le bloc (0, 0) repeint en désert perd ses arbres une fois invalidé, et lui
    // seul ; avant, le cache le montre tel qu'il était.
    const desert = data.biomes.indexOf('desert');
    if (desert === undefined) throw new Error('désert absent');
    const trees = (chunk: number) =>
      collected(source, source.update({ ...at(chunk), month: july + 2 }, slots)).filter(
        (object) => table.looks.at(object.look)?.kind === DECOR_KIND.tree,
      ).length;
    expect(trees(0)).toBeGreaterThan(1000);
    for (let y = 0; y < CHUNK_SIZE; y++) {
      world.biome.fill(desert, y * large.width, y * large.width + CHUNK_SIZE);
    }
    expect(trees(0)).toBeGreaterThan(1000);
    source.invalidate([{ column: 0, row: 0 }]);
    expect(trees(0)).toBe(0);
    expect(trees(1)).toBeGreaterThan(1000);
  });
});
