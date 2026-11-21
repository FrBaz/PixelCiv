import { describe, expect, it } from 'vitest';
import { loadGameData, type LandUse } from '../core/data';
import { floraCode, floraDensity } from '../core/flora';
import { Fingerprint } from '../core/hash';
import { VEGETATION_STATES } from '../core/data/schemas';
import {
  cellMedianThreshold,
  coldDates,
  dryDate,
  FOLIAGE_BYTES,
  FOLIAGE_STATE,
  foliageShares,
  foliageState,
  leafThreshold,
  lightDate,
  worldFoliage,
  type FoliageState,
} from '../core/foliage';
import { MONTH_CENTERS, rainSeasonality, southern } from '../core/seasons';
import { phaseDay } from '../core/snow';
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
  fruiting,
  pickLook,
  PHENOLOGY_STATES,
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
    const looseForms = new Set(Object.values(data.decor.rocks).map((rock) => rock.form));
    expect(table.looks).toHaveLength(data.flora.entries.length + looseForms.size + minerals.length);
    // Les rochers épars de chaque biome, à la forme que leur donnent les données.
    data.biomes.entries.forEach((biome, index) => {
      const rock = Object.hasOwn(data.decor.rocks, biome.id)
        ? data.decor.rocks[biome.id]
        : undefined;
      expect(table.rockChance[index], biome.id).toBe(rock?.chance ?? 0);
      if (rock === undefined) expect(table.rockLook[index], biome.id).toBe(-1);
      else
        expect(lookOf(table.rockLook[index] ?? -1), biome.id).toMatchObject({
          kind: DECOR_KIND.rock,
          form: rock.form,
          flora: -1,
          mineral: -1,
        });
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
            const loose = Object.entries(data.decor.rocks).find(([id]) => id === biome?.id)?.[1];
            expect(loose?.chance).toBeGreaterThan(0);
            expect(lookOf(rocks[0]?.look ?? -1)).toMatchObject({ form: loose?.form, mineral: -1 });
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

  it('donne aux rochers épars la forme et la chance que les données donnent à leur biome', () => {
    // Relecture 2b.6, problèmes 8 et 22 : aucune forme de rocher n'est nommée par le code.
    const tundra = data.biomes.indexOf('tundra');
    const mountain = data.biomes.indexOf('mountain');
    if (tundra === undefined || mountain === undefined) throw new Error('biomes inconnus');
    const rocks = {
      ...data.decor.rocks,
      tundra: { chance: 1, form: 'pebble' },
      mountain: { chance: 1, form: 'basalt' },
    };
    const custom = compileDecor({ ...data, decor: { ...data.decor, rocks } });
    const pebble = custom.rockLook[tundra] ?? -1;
    const basalt = custom.rockLook[mountain] ?? -1;
    expect(custom.looks.at(pebble)).toMatchObject({ kind: DECOR_KIND.rock, form: 'pebble' });
    expect(custom.looks.at(basalt)).toMatchObject({ kind: DECOR_KIND.rock, form: 'basalt' });
    // Une apparence par forme : les autres biomes rocheux gardent ensemble la leur.
    expect(custom.rockLook[data.biomes.indexOf('cliff') ?? -1]).toBe(
      custom.rockLook[data.biomes.indexOf('high-mountain') ?? -1],
    );
    const layers = emptyLayers(size);
    const world: DecorWorld = { size, layers, biomes: data.biomes.entries, table: custom, key: 7 };
    layers.biome.fill(tundra);
    for (let x = 0; x < 40; x++) {
      const found = objectsAt(world, x, 10).filter(
        (placed) => custom.looks.at(placed.look)?.kind === DECOR_KIND.rock,
      );
      expect(found.map((placed) => placed.look)).toEqual([pebble]);
    }
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

describe('saisons du décor (ADR 0017, § 5 ; ADR 0019, § 2)', () => {
  const rules = data.decor;
  const foliageRules = { foliage: data.decor.foliage, seasons: data.seasons };
  const transition = data.seasons.minTransition;
  const { bareBelow, autumnBelow } = rules.foliage;
  /** Le calendrier de la végétation d'un climat (°C) à la latitude `lat`. */
  const bytesOf = (annual: number, amplitude: number, lat: number) => {
    const cold = coldDates(annual, amplitude, foliageRules);
    return [
      cold & 255,
      cold >>> 8,
      dryDate(rainSeasonality(lat), foliageRules),
      lightDate(annual, amplitude, foliageRules),
    ];
  };
  /**
   * L'état d'une espèce sur une case de climat (annuelle, demi-amplitude) au mois `month`, au seuil
   * médian ½, à la latitude `lat`, sous la lumière d'hiver si `light`.
   */
  const state = (
    phenology: 'evergreen' | 'deciduous' | 'dry',
    annual: number,
    amplitude: number,
    month: number,
    south = false,
    lat = 0.4,
    snow = 0,
    light = false,
  ) =>
    decorSeason(
      snow,
      phenology,
      foliageShares(bytesOf(annual, amplitude, lat), 0, phaseDay(month * 30, south), transition),
      0.5,
      rules,
      light,
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

  it('ne jaunit pas un caduc au pic de l’été, même là où l’été reste frais', () => {
    // Relecture 2b.6, problème 3 : là où l'été culmine sous autumnBelow, les caducs passaient
    // à l'automne d'un coup, à la mi-juillet au nord, à la mi-janvier au sud.
    const { autumnDrop } = rules.foliage;
    // Un été à 10 °C : feuillé au pic et juste après ; l'automne attend que le mois ait perdu
    // autumnDrop degrés.
    expect(state('deciduous', 0, 10, 6.5).state).toBe(DECOR_STATE.summer);
    expect(state('deciduous', 0, 10, 6.6).state).toBe(DECOR_STATE.summer);
    expect(state('deciduous', 0, 10, 0.5, true).state).toBe(DECOR_STATE.summer);
    expect(state('deciduous', 0, 10, 0.6, true).state).toBe(DECOR_STATE.summer);
    expect(state('deciduous', 0, 10, 8.2).state).toBe(DECOR_STATE.autumn);
    expect(state('deciduous', 0, 10, 2.2, true).state).toBe(DECOR_STATE.autumn);
    expect(autumnDrop).toBeGreaterThan(0);
  });

  it('change l’état des caducs peu à peu, jour après jour, sans automne en juillet au nord', () => {
    // Sur la vraie pose des trois mondes : au nord, aucun caduc en automne du mois 6,0 au mois
    // 7,5 là où le mois le plus chaud passe bareBelow ; et, d'un jour au suivant, au plus 3 % des
    // caducs changent d'état (la bascule de la mi-juillet en changeait 11 à 13 % d'un coup).
    for (const seed of SEEDS) {
      const layers = layersOf(seed);
      const world = worldOf(seed, layers);
      const foliage = worldFoliage(size, layers, foliageRules);
      const deciduous: { cell: number; south: boolean; level: number }[] = [];
      for (let y = 0; y < size.height; y++) {
        for (let x = 0; x < size.width; x++) {
          for (const placed of objectsAt(world, x, y)) {
            if (lookOf(placed.look)?.phenology !== 'deciduous') continue;
            deciduous.push({
              cell: y * size.width + x,
              south: southern(y, size.height),
              level: cellMedianThreshold(x, y),
            });
          }
        }
      }
      expect(deciduous.length, seed).toBeGreaterThan(5000);
      const at = (object: (typeof deciduous)[number], day: number) =>
        decorSeason(
          0,
          'deciduous',
          foliageShares(
            foliage,
            object.cell * FOLIAGE_BYTES,
            phaseDay(day, object.south),
            transition,
          ),
          object.level,
          rules,
          false,
        ).state;
      for (let day = 180; day <= 225; day++) {
        for (const object of deciduous) {
          const warmest =
            ((layers.temperature[object.cell] ?? 0) + (layers.amplitude[object.cell] ?? 0)) / 10;
          if (object.south || warmest <= bareBelow) continue;
          expect(at(object, day), `${seed}, jour ${String(day)}`).not.toBe(DECOR_STATE.autumn);
        }
      }
      let previous = deciduous.map((object) => at(object, 0));
      let worst = 0;
      for (let day = 1; day <= 360; day++) {
        const states = deciduous.map((object) => at(object, day));
        const changed = states.filter((value, index) => value !== previous[index]).length;
        worst = Math.max(worst, changed / deciduous.length);
        previous = states;
      }
      expect(worst, seed).toBeLessThanOrEqual(0.03);
    }
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
    expect(rainSeasonality(lat)).toBeGreaterThan(0.5);
    expect(state('dry', 25, 3, 0.5, false, lat).state).toBe(DECOR_STATE.dry);
    expect(state('dry', 25, 3, 6.5, false, lat).state).toBe(DECOR_STATE.summer);
    expect(state('dry', 25, 3, 6.5, true, lat).state).toBe(DECOR_STATE.dry);
    // À l'équateur, il pleut toute l'année.
    for (const month of MONTH_CENTERS) {
      expect(state('dry', 25, 3, month, false, 0).state).toBe(DECOR_STATE.summer);
      expect(state('evergreen', -20, 20, month).state).toBe(DECOR_STATE.summer);
    }
  });

  it('donne la lumière d’hiver aux objets sans état, et à eux seuls, quand elle se montre', () => {
    // Un persistant du nord au cœur de l'hiver : éclairé si la lumière se montre (le cran plein),
    // jamais en été, ni sous les tropiques ; un caduc nu garde ses tons nus.
    expect(state('evergreen', -2, 18, 0.5, false, 0.6, 0, true).lit).toBe(true);
    expect(state('evergreen', -2, 18, 0.5, false, 0.6, 0, false).lit).toBe(false);
    expect(state('evergreen', -2, 18, 6.5, false, 0.6, 0, true).lit).toBe(false);
    expect(state('evergreen', 25, 2, 0.5, false, 0.1, 0, true).lit).toBe(false);
    const bare = state('deciduous', -2, 18, 0.5, false, 0.6, 0, true);
    expect([bare.state, bare.lit]).toEqual([DECOR_STATE.bare, false]);
    // Un caduc d'hiver doux, feuillé, prend la lumière comme le sol.
    expect(state('deciduous', 14, 6, 0.5, false, 0.6, 0, true).lit).toBe(true);
  });

  it('enneige un objet quand la part de neige de sa case atteint le seuil des données', () => {
    const { share } = rules.snow;
    expect(state('evergreen', 0, 10, 0.5, false, 0.4, share).snowy).toBe(true);
    expect(state('evergreen', 0, 10, 0.5, false, 0.4, share - 1e-6).snowy).toBe(false);
    expect(state('deciduous', 0, 10, 0.5, false, 0.4, 1).snowy).toBe(true);
    expect(state('deciduous', 0, 10, 0.5, false, 0.4, 0).snowy).toBe(false);
    const shares = foliageShares(bytesOf(0, 0, 0), 0, 0, transition);
    expect(
      decorSeason(0, 'evergreen', shares, 0.5, { snow: { ...rules.snow, share: 0 } }, false).snowy,
    ).toBe(false);
  });

  it('prend l’état de la majorité des pixels de son sol, chaque jour, sur chaque case', () => {
    // La critique (requis 1) : le sol et l'arbre changent le même jour. Sur les trois mondes, pour
    // chaque case dont la végétation prend les mêmes états que l'espèce (caducs sur un sol caduc
    // ou de toundra, espèces sèches sur une herbe tropicale) : chaque jour de l'année, l'état de
    // l'objet est celui de la majorité (9 pixels sur 16 au moins) des pixels de sa case, quand
    // elle existe, lumière d'hiver comprise.
    let compared = 0;
    for (const seed of SEEDS) {
      const layers = layersOf(seed);
      const world = worldOf(seed, layers);
      const foliage = worldFoliage(size, layers, foliageRules);
      for (let y = 0; y < size.height; y += 3) {
        const south = southern(y, size.height);
        for (let x = 0; x < size.width; x += 3) {
          const cell = y * size.width + x;
          const biome = data.biomes.entries.at(layers.biome[cell] ?? -1);
          if (biome === undefined || biome.family === 'water') continue;
          const ground = new Set(VEGETATION_STATES[biome.vegetation]);
          const level = cellMedianThreshold(x, y);
          for (const placed of objectsAt(world, x, y)) {
            const phenology = lookOf(placed.look)?.phenology;
            if (phenology === undefined) continue;
            const own = PHENOLOGY_STATES[phenology];
            const same =
              own.autumn === ground.has('autumn') &&
              own.bare === ground.has('bare') &&
              own.dry === ground.has('dry');
            if (!same) continue;
            const states = {
              autumn: ground.has('autumn'),
              bare: ground.has('bare'),
              dry: ground.has('dry'),
            };
            for (let day = 0; day < 360; day += 4) {
              const shares = foliageShares(
                foliage,
                cell * FOLIAGE_BYTES,
                phaseDay(day + 0.5, south),
                transition,
              );
              const tally = new Map<FoliageState, number>();
              for (let j = 0; j < 4; j++) {
                for (let i = 0; i < 4; i++) {
                  const pixel = foliageState(
                    shares,
                    states,
                    leafThreshold(x * 4 + i, y * 4 + j),
                    true,
                  );
                  tally.set(pixel, (tally.get(pixel) ?? 0) + 1);
                }
              }
              const majority = [...tally].find(([, count]) => count >= 9)?.[0];
              if (majority === undefined) continue;
              const object = decorSeason(0, phenology, shares, level, rules, true);
              const expected =
                majority === FOLIAGE_STATE.bare
                  ? DECOR_STATE.bare
                  : majority === FOLIAGE_STATE.autumn
                    ? DECOR_STATE.autumn
                    : majority === FOLIAGE_STATE.dry
                      ? DECOR_STATE.dry
                      : DECOR_STATE.summer;
              expect(
                [object.state, object.lit],
                `${seed} (${String(x)}, ${String(y)}), ${String(day)}`,
              ).toEqual([expected, majority === FOLIAGE_STATE.light]);
              compared++;
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(20000);
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
    const month = 0.5;
    let bare = 0;
    for (const seed of SEEDS) {
      const world = worldOf(seed);
      const { layers } = world;
      const foliage = worldFoliage(size, layers, foliageRules);
      for (let y = 0; y < size.height / 2; y += 2) {
        const south = southern(y, size.height);
        for (let x = 0; x < size.width; x += 2) {
          const cell = y * size.width + x;
          for (const placed of objectsAt(world, x, y)) {
            const flora = data.flora.entries.at(lookOf(placed.look)?.flora ?? -1);
            if (flora === undefined) continue;
            const fruit = flora.look.fruit;
            if (fruit !== undefined && !fruit.months.includes(0)) {
              expect(fruiting(fruit.months, month, south)).toBe(false);
            }
            if (flora.kind !== 'shrub' || flora.look.phenology !== 'deciduous') continue;
            const coldest = ((layers.temperature[cell] ?? 0) - (layers.amplitude[cell] ?? 0)) / 10;
            if (coldest >= bareBelow) continue;
            const shares = foliageShares(
              foliage,
              cell * FOLIAGE_BYTES,
              phaseDay(month * 30, south),
              transition,
            );
            const level = cellMedianThreshold(x, y);
            expect(decorSeason(0, 'deciduous', shares, level, rules, false).state, flora.id).toBe(
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
