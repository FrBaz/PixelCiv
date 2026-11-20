import { describe, expect, it } from 'vitest';
import { loadGameData, type LandUse } from '../core/data';
import { floraCode, floraDensity } from '../core/flora';
import { Fingerprint } from '../core/hash';
import { latitude, MONTH_CENTERS, rainSeasonality, southern } from '../core/seasons';
import { CHUNK_SIZE, emptyLayers, riverClass, WORLD_SIZES, type WorldLayers } from '../core/world';
import { defaultWorldParams } from '../core/worldParams';
import { generateWorld } from '../worldgen/generate';
import {
  cellObjects,
  compileDecor,
  DECOR_KIND,
  DECOR_STATE,
  decorKey,
  decorSeason,
  foliageClimate,
  fruiting,
  pickLook,
  seasonMoment,
  variantOf,
  type DecorWorld,
  type Placed,
} from './decor';

const data = loadGameData();
const table = compileDecor(data);
const size = WORLD_SIZES.small;
const NATURAL: LandUse = { trees: 1, shrubs: 1, rocks: 1 };
const SEEDS = ['pixelciv', 'graine', 'autre'] as const;
const worlds = new Map<string, WorldLayers>();
/** Un monde Petit de la graine `seed`, généré une fois. */
function layersOf(seed: string): WorldLayers {
  let layers = worlds.get(seed);
  if (layers === undefined) {
    layers = generateWorld(
      { ...defaultWorldParams(data.worldgen.parameters, seed, 'small'), size },
      data,
    );
    worlds.set(seed, layers);
  }
  return layers;
}
const worldOf = (seed: string, layers = layersOf(seed)): DecorWorld => ({
  size,
  layers,
  biomes: data.biomes.entries,
  table,
  key: decorKey(seed),
});
const places = (): Placed[] => [0, 1, 2].map(() => ({ look: 0, variant: 0, fx: 0, fy: 0 }));

/** Les objets de la case (x, y), copiés. */
function objectsAt(world: DecorWorld, x: number, y: number, landUse: LandUse = NATURAL) {
  const out = places();
  const count = cellObjects(world, x, y, landUse, out);
  return out.slice(0, count).map((placed) => ({ ...placed }));
}

/** Empreinte de toute la pose d'un monde, les blocs pris dans l'ordre `chunks`. */
function poseFingerprint(world: DecorWorld, chunks: readonly number[]): string {
  const columns = size.width / CHUNK_SIZE;
  const perCell = new Map<number, Placed[]>();
  for (const chunk of chunks) {
    const cx = chunk % columns;
    const cy = Math.floor(chunk / columns);
    for (let y = cy * CHUNK_SIZE; y < (cy + 1) * CHUNK_SIZE; y++) {
      for (let x = cx * CHUNK_SIZE; x < (cx + 1) * CHUNK_SIZE; x++) {
        perCell.set(y * size.width + x, objectsAt(world, x, y));
      }
    }
  }
  const print = new Fingerprint();
  for (let cell = 0; cell < size.width * size.height; cell++) {
    for (const placed of perCell.get(cell) ?? []) {
      print
        .uint32(cell)
        .uint32(placed.look)
        .uint32(placed.variant)
        .float64(placed.fx)
        .float64(placed.fy);
    }
  }
  return print.hex();
}

const lookOf = (index: number) => table.looks.at(index);
const biomeAt = (layers: WorldLayers, cell: number) => data.biomes.entries.at(layers.biome[cell]);

describe('pose du décor (ADR 0017, § 1)', () => {
  it('compile une apparence par espèce, la roche nue et le rocher de chaque minerai', () => {
    const minerals = data.resources.entries.filter((resource) => resource.deposit !== undefined);
    expect(table.looks).toHaveLength(data.flora.entries.length + 1 + minerals.length);
    expect(lookOf(table.looseRock)).toMatchObject({
      kind: DECOR_KIND.rock,
      form: 'rock',
      mineral: -1,
    });
    data.resources.entries.forEach((resource, index) => {
      const look = lookOf(table.depositLook[index] ?? -1);
      if (resource.deposit === undefined) expect(table.depositLook[index]).toBe(-1);
      else
        expect(look).toMatchObject({
          mineral: index,
          form: Object.hasOwn(data.decor.deposits, resource.id)
            ? data.decor.deposits[resource.id].form
            : undefined,
        });
    });
    data.biomes.entries.forEach((biome, index) => {
      for (const [kind, choices] of [
        ['tree', table.trees[index]],
        ['shrub', table.shrubs[index]],
      ] as const) {
        const ids = choices.looks.map((look) => data.flora.entries.at(look)?.id);
        const expected = biome.flora.species.filter(
          (id) => data.flora.entries[data.flora.indexOf(id) ?? -1]?.kind === kind,
        );
        expect(ids, `${biome.id} ${kind}`).toEqual(expected);
        const weights = expected.map((id) => biome.flora.weights?.[id] ?? 1);
        expect(choices.total).toBeCloseTo(
          weights.reduce((sum, weight) => sum + weight, 0),
          9,
        );
      }
    });
  });

  it('tire les espèces selon leur poids', () => {
    const tropical = table.trees.at(data.biomes.indexOf('tropical-forest') ?? -1);
    if (tropical === undefined) throw new Error('forêt tropicale absente');
    const palm = data.flora.indexOf('palm');
    let palms = 0;
    const draws = 10_000;
    for (let index = 0; index < draws; index++) {
      if (pickLook(tropical, (index + 0.5) / draws) === palm) palms++;
    }
    // Un palmier pour quatre bois tropicaux (data/biomes.json).
    expect(palms / draws).toBeCloseTo(0.2, 2);
    expect(pickLook(tropical, 0)).toBe(data.flora.indexOf('tropical-hardwood'));
    expect(pickLook(tropical, 0.999_999)).toBe(palm);
  });

  it.each(SEEDS)(
    'pose au plus un arbre, un buisson et un rocher par case, rien sur l’eau ni sur les rivières : %s',
    (seed) => {
      const world = worldOf(seed);
      const { layers } = world;
      const counted = {
        trees: 0,
        shrubs: 0,
        rocks: 0,
        expectedTrees: 0,
        expectedShrubs: 0,
        deposits: 0,
      };
      for (let y = 0; y < size.height; y++) {
        for (let x = 0; x < size.width; x++) {
          const cell = y * size.width + x;
          const biome = biomeAt(layers, cell);
          const found = objectsAt(world, x, y);
          const kinds = found.map((placed) => lookOf(placed.look)?.kind);
          expect(kinds.filter((kind) => kind === DECOR_KIND.tree).length).toBeLessThanOrEqual(1);
          expect(kinds.filter((kind) => kind === DECOR_KIND.shrub).length).toBeLessThanOrEqual(1);
          expect(kinds.filter((kind) => kind === DECOR_KIND.rock).length).toBeLessThanOrEqual(1);
          const open = biome?.family === 'water' || riverClass(layers.drainage[cell]) >= 2;
          if (open) {
            expect(found, `case ${String(cell)}`).toEqual([]);
            continue;
          }
          counted.expectedTrees += floraDensity(layers.trees[cell], biome?.flora.trees ?? 0);
          counted.expectedShrubs += floraDensity(layers.shrubs[cell], biome?.flora.shrubs ?? 0);
          for (const placed of found) {
            const look = lookOf(placed.look);
            expect(placed.fx).toBeGreaterThanOrEqual(0);
            expect(placed.fx).toBeLessThan(1);
            expect(placed.fy).toBeGreaterThanOrEqual(0);
            expect(placed.fy).toBeLessThan(1);
            expect(placed.variant).toBeGreaterThanOrEqual(0);
            expect(placed.variant).toBeLessThan(256);
            if (look?.kind === DECOR_KIND.rock) continue;
            // Une espèce du biome de la case.
            expect(biome?.flora.species).toContain(data.flora.entries.at(look?.flora ?? -1)?.id);
            if (look?.kind === DECOR_KIND.tree) counted.trees++;
            else counted.shrubs++;
          }
          // Un rocher par gisement, à l'aspect de son minerai ; ailleurs, la roche nue des seuls
          // biomes qui en ont.
          const deposit = layers.deposit[cell] ?? 0;
          const rocks = found.filter((placed) => lookOf(placed.look)?.kind === DECOR_KIND.rock);
          if (deposit > 0) {
            counted.deposits++;
            expect(rocks.map((placed) => lookOf(placed.look)?.mineral)).toEqual([deposit - 1]);
          } else if (rocks.length > 0) {
            expect(rocks[0]?.look).toBe(table.looseRock);
            expect(
              Object.entries(data.decor.rocks).find(([id]) => id === biome?.id)?.[1],
            ).toBeGreaterThan(0);
          }
          counted.rocks += rocks.length;
          // Le buisson à côté de l'arbre et devant lui ; le rocher du côté opposé à l'arbre.
          const tree = found.find((placed) => lookOf(placed.look)?.kind === DECOR_KIND.tree);
          const shrub = found.find((placed) => lookOf(placed.look)?.kind === DECOR_KIND.shrub);
          const { side, depth } = data.decor.place.shrub;
          if (tree !== undefined && shrub !== undefined) {
            expect(shrub.fy).toBeGreaterThanOrEqual(depth[0]);
            expect(shrub.fy).toBeLessThanOrEqual(depth[1]);
            const gap = Math.abs(shrub.fx - tree.fx);
            expect(gap >= side[0] - 1e-9 || shrub.fx === 0.1 || shrub.fx === 0.9).toBe(true);
          }
          const rock = rocks.at(0);
          if (tree !== undefined && rock !== undefined) {
            expect(Math.sign(rock.fx - 0.5)).toBe(tree.fx > 0.5 ? -1 : 1);
          }
        }
      }
      // Les arbres et les buissons suivent les densités des couches, à 3 % près.
      expect(counted.trees).toBeGreaterThan(5000);
      expect(Math.abs(counted.trees / counted.expectedTrees - 1)).toBeLessThan(0.03);
      expect(Math.abs(counted.shrubs / counted.expectedShrubs - 1)).toBeLessThan(0.03);
      expect(counted.deposits).toBeGreaterThan(1000);
      expect(counted.rocks).toBeGreaterThan(counted.deposits);
    },
  );

  it('montre les mêmes objets de part et d’autre de la couture, dans chaque copie du monde', () => {
    const world = worldOf('autre');
    for (let y = 0; y < size.height; y += 3) {
      for (const x of [0, 1, size.width - 2, size.width - 1]) {
        const here = objectsAt(world, x, y);
        expect(objectsAt(world, x + size.width, y)).toEqual(here);
        expect(objectsAt(world, x - size.width, y)).toEqual(here);
        expect(objectsAt(world, x + 3 * size.width, y)).toEqual(here);
      }
    }
    expect(objectsAt(world, 10, -1)).toEqual([]);
    expect(objectsAt(world, 10, size.height)).toEqual([]);
  });

  it('a une empreinte, la même quel que soit l’ordre des blocs, et propre à la graine', () => {
    const world = worldOf('pixelciv');
    const chunks = Array.from(
      { length: (size.width / CHUNK_SIZE) * (size.height / CHUNK_SIZE) },
      (_, index) => index,
    );
    const forward = poseFingerprint(world, chunks);
    // Le déterminisme de la pose (ADR 0003) : une valeur figée, que tout changement de la pose,
    // de ses tirages ou de ses données doit expliquer.
    expect(forward).toBe('f0f3aeca');
    const shuffled = [...chunks].sort((a, b) => ((a * 7919) % 31) - ((b * 7919) % 31) || b - a);
    expect(poseFingerprint(world, shuffled)).toBe(forward);
    expect(poseFingerprint(worldOf('pixelciv', layersOf('pixelciv')), [...chunks].reverse())).toBe(
      forward,
    );
    // Une autre clé, une autre pose, sur les mêmes couches.
    expect(poseFingerprint({ ...world, key: decorKey('autre') }, chunks)).not.toBe(forward);
    expect(decorKey('pixelciv')).toBe(decorKey('pixelciv'));
  });

  it('ne garde que la part du décor que laisse l’occupation du sol (C1 D7)', () => {
    const world = worldOf('graine');
    const none: LandUse = { trees: 0, shrubs: 0, rocks: 0 };
    const treesOnly: LandUse = { trees: 1, shrubs: 0, rocks: 0 };
    let natural = 0;
    for (let y = 0; y < size.height; y += 2) {
      for (let x = 0; x < size.width; x += 2) {
        const all = objectsAt(world, x, y);
        natural += all.length;
        expect(objectsAt(world, x, y, none)).toEqual([]);
        // Les arbres restent les mêmes, aux mêmes places : chaque sorte a ses tirages.
        const trees = all.filter((placed) => lookOf(placed.look)?.kind === DECOR_KIND.tree);
        expect(
          objectsAt(world, x, y, treesOnly).map((placed) => ({ ...placed, fx: placed.fx })),
        ).toEqual(trees);
      }
    }
    expect(natural).toBeGreaterThan(1000);
  });

  it('montre la densité de la couche sur une case jamais repeinte, celle du nouveau biome sur une case repeinte', () => {
    for (const seed of SEEDS) {
      const layers = layersOf(seed);
      for (let cell = 0; cell < layers.biome.length; cell++) {
        const flora = biomeAt(layers, cell)?.flora;
        if (flora === undefined) continue;
        expect(floraDensity(layers.trees[cell] ?? 0, flora.trees) * 255).toBeCloseTo(
          layers.trees[cell] ?? 0,
          9,
        );
        expect(floraDensity(layers.shrubs[cell] ?? 0, flora.shrubs) * 255).toBeCloseTo(
          layers.shrubs[cell] ?? 0,
          9,
        );
      }
    }
    // Une forêt repeinte en désert perd ses arbres ; un désert repeint en forêt en gagne, dans
    // l'étendue que la génération donne à la forêt.
    const forest = data.biomes.entries.find((biome) => biome.id === 'temperate-forest');
    const desert = data.biomes.entries.find((biome) => biome.id === 'desert');
    if (forest === undefined || desert === undefined) throw new Error('biomes absents');
    expect(floraDensity(200, desert.flora.trees)).toBe(0);
    expect(floraDensity(0, forest.flora.trees) * 255).toBe(floraCode(forest.flora.trees, -1));
    expect(floraDensity(255, forest.flora.trees) * 255).toBe(floraCode(forest.flora.trees, 1));
    // La pose suit le biome actuel de la case.
    const layers = emptyLayers({ width: 64, height: 64 });
    const forestIndex = data.biomes.indexOf('temperate-forest') ?? 0;
    layers.biome.fill(forestIndex);
    const synthetic: DecorWorld = {
      size: { width: 64, height: 64 },
      layers,
      biomes: data.biomes.entries,
      table,
      key: 7,
    };
    let trees = 0;
    for (let cell = 0; cell < 64 * 64; cell++) {
      trees += objectsAt(synthetic, cell % 64, Math.floor(cell / 64)).filter(
        (placed) => lookOf(placed.look)?.kind === DECOR_KIND.tree,
      ).length;
    }
    // Des couches à 0, ramenées au plus bas de la forêt : 0,75 × 0,65 ≈ 49 % des cases.
    expect(trees / (64 * 64)).toBeCloseTo(floraCode(forest.flora.trees, -1) / 255, 1);
  });

  it('prend la variante d’un tirage, parmi celles de sa forme', () => {
    expect([0, 85, 86, 170, 171, 255].map((variant) => variantOf(variant, 3))).toEqual([
      0, 0, 1, 1, 2, 2,
    ]);
    expect(variantOf(255, 1)).toBe(0);
    expect(variantOf(128, 2)).toBe(1);
  });
});

describe('saisons du décor (ADR 0017, § 5)', () => {
  const rules = data.decor;
  const { bareBelow, autumnBelow } = rules.foliage;
  /** L'état d'une espèce sur une case de climat (annuelle, demi-amplitude) au mois `month`. */
  const state = (
    phenology: 'evergreen' | 'deciduous' | 'dry',
    annual: number,
    amplitude: number,
    month: number,
    south = false,
    rain = 0,
    snow = 0,
  ) =>
    decorSeason(
      snow,
      phenology,
      foliageClimate(annual, amplitude, south, rain, seasonMoment(month)),
      rules,
    );

  it('jaunit les caducs en refroidissant, les dénude l’hiver, au nord comme au sud à six mois d’écart', () => {
    // Une forêt tempérée : 8 °C de moyenne, 12 °C de demi-amplitude.
    expect(state('deciduous', 8, 12, 6.5).state).toBe(DECOR_STATE.summer);
    expect(state('deciduous', 8, 12, 9.8).state).toBe(DECOR_STATE.autumn);
    expect(state('deciduous', 8, 12, 0.5).state).toBe(DECOR_STATE.bare);
    // Au printemps, même froid qu'en automne, mais le mois se réchauffe : pas d'automne.
    expect(state('deciduous', 8, 12, 3.2).state).toBe(DECOR_STATE.summer);
    // Au sud, la saison inverse.
    expect(state('deciduous', 8, 12, 0.5, true).state).toBe(DECOR_STATE.summer);
    expect(state('deciduous', 8, 12, 6.5, true).state).toBe(DECOR_STATE.bare);
    expect(state('deciduous', 8, 12, 3.8, true).state).toBe(DECOR_STATE.autumn);
    expect(bareBelow).toBeLessThan(autumnBelow);
  });

  it('garde ses feuilles au caduc d’un hiver doux, toute l’année', () => {
    // Le mois le plus froid à 6 °C, au-dessus du seuil : jamais nu, jamais d'automne.
    for (const month of MONTH_CENTERS) {
      expect(state('deciduous', 12, 6, month).state).toBe(DECOR_STATE.summer);
      expect(state('deciduous', 12, 6, month, true).state).toBe(DECOR_STATE.summer);
    }
  });

  it('sèche les espèces de la saison sèche, et laisse les persistantes feuillées', () => {
    // Sous les tropiques, vers 18° : la saison sèche est l'hiver de l'hémisphère.
    const lat = 0.2;
    const rain = rainSeasonality(lat);
    expect(rain).toBeGreaterThan(0.5);
    expect(state('dry', 25, 3, 0.5, false, rain).state).toBe(DECOR_STATE.dry);
    expect(state('dry', 25, 3, 6.5, false, rain).state).toBe(DECOR_STATE.summer);
    expect(state('dry', 25, 3, 6.5, true, rain).state).toBe(DECOR_STATE.dry);
    // À l'équateur, il pleut toute l'année.
    for (const month of MONTH_CENTERS) {
      expect(state('dry', 25, 3, month, false, rainSeasonality(0)).state).toBe(DECOR_STATE.summer);
      expect(state('evergreen', -20, 20, month).state).toBe(DECOR_STATE.summer);
    }
  });

  it('enneige un objet quand la part de neige de sa case atteint le seuil des données', () => {
    const { share } = rules.snow;
    expect(state('evergreen', 0, 10, 0.5, false, 0, share).snowy).toBe(true);
    expect(state('evergreen', 0, 10, 0.5, false, 0, share - 1e-6).snowy).toBe(false);
    expect(state('deciduous', 0, 10, 0.5, false, 0, 1).snowy).toBe(true);
    expect(state('deciduous', 0, 10, 0.5, false, 0, 0).snowy).toBe(false);
    expect(
      decorSeason(0, 'evergreen', foliageClimate(0, 0, false, 0, seasonMoment(0)), {
        ...rules,
        snow: { ...rules.snow, share: 0 },
      }).snowy,
    ).toBe(false);
  });

  it('montre les fruits à leurs mois, six mois plus tard au sud', () => {
    const berries = [6, 7, 8, 9];
    expect(fruiting(berries, 7.5, false)).toBe(true);
    expect(fruiting(berries, 0.5, false)).toBe(false);
    expect(fruiting(berries, 1.5, true)).toBe(true);
    expect(fruiting(berries, 7.5, true)).toBe(false);
    expect(fruiting(berries, 12, false)).toBe(false);
    expect(fruiting([0], 12, false)).toBe(true);
  });

  it('dénude en janvier les buissons caducs des hivers froids du nord, sans leurs fruits', () => {
    // Sur trois mondes : chaque buisson caduc d'une case du nord dont le mois le plus froid
    // descend sous le seuil est nu à la mi-janvier, et aucun fruit d'aucune espèce ne se
    // montre hors de ses mois.
    const moment = seasonMoment(0.5);
    let bare = 0;
    for (const seed of SEEDS) {
      const world = worldOf(seed);
      const { layers } = world;
      for (let y = 0; y < size.height / 2; y += 2) {
        const south = southern(y, size.height);
        const rain = rainSeasonality(latitude(y, size.height));
        for (let x = 0; x < size.width; x += 2) {
          const cell = y * size.width + x;
          for (const placed of objectsAt(world, x, y)) {
            const flora = data.flora.entries.at(lookOf(placed.look)?.flora ?? -1);
            if (flora === undefined) continue;
            const fruit = flora.look.fruit;
            if (fruit !== undefined && !fruit.months.includes(0)) {
              expect(fruiting(fruit.months, moment.month, south)).toBe(false);
            }
            if (flora.kind !== 'shrub' || flora.look.phenology !== 'deciduous') continue;
            const climate = foliageClimate(
              (layers.temperature[cell] ?? 0) / 10,
              (layers.amplitude[cell] ?? 0) / 10,
              south,
              rain,
              moment,
            );
            if (climate.coldest >= bareBelow) continue;
            expect(decorSeason(0, 'deciduous', climate, rules).state, flora.id).toBe(
              DECOR_STATE.bare,
            );
            bare++;
          }
        }
      }
    }
    expect(bare).toBeGreaterThan(100);
  });
});
