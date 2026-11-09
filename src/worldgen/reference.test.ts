/**
 * Empreintes de référence des mondes (tâche 1.10 ; MON-03, NF-09, ADR 0003) : une graine
 * et des paramètres donnent toujours le même monde, d'une version du jeu à l'autre et
 * d'un moteur à l'autre.
 *
 * Si une modification change ces empreintes, les mondes changent : augmente alors
 * GENERATOR_VERSION (generate.ts), puis mets ces empreintes à jour, en connaissance de
 * cause. Celles de chaque couche disent quelle étape a bougé : le relief change tout ce
 * qui suit, une retouche des biomes ne change que les biomes et la flore.
 */
import { describe, expect, it } from 'vitest';
import { loadGameData } from '../core/data';
import { Fingerprint } from '../core/hash';
import { EXPECTED_WORLD_FINGERPRINT, SELFTEST_WORLD } from '../core/selftest';
import {
  LAYER_NAMES,
  layersFingerprint,
  WORLD_SIZES,
  type LayerName,
  type WorldSize,
} from '../core/world';
import { defaultWorldParams, type WorldParams } from '../core/worldParams';
import { generateWorld, GENERATOR_VERSION } from './generate';

const data = loadGameData();

/** Version du générateur dont viennent les empreintes ci-dessous. */
const REFERENCE_VERSION = 1;

interface Reference {
  readonly seed: string;
  readonly size: WorldSize;
  readonly overrides: Partial<WorldParams>;
  readonly layers: Readonly<Record<LayerName, string>>;
}

const PREVIEW = { width: 256, height: 128 };

const REFERENCES: readonly Reference[] = [
  {
    seed: 'pixelciv',
    size: WORLD_SIZES.small,
    overrides: {},
    layers: {
      elevation: '756cd4ca',
      waterDepth: '5f1d98a2',
      biome: '9d269d4c',
      drainage: 'cdac00fe',
      temperature: '714b9a03',
      amplitude: '0f9f9b35',
      precipitation: '300d5afa',
      deposit: '82eb2b9a',
      trees: '2e856647',
      shrubs: '4e35bb8d',
    },
  },
  {
    seed: 'alpha',
    size: PREVIEW,
    overrides: {},
    layers: {
      elevation: '1d4c8266',
      waterDepth: 'bfdcd268',
      biome: '52b3e1ed',
      drainage: 'a9edff62',
      temperature: '9d2f5f44',
      amplitude: '5de55637',
      precipitation: '8e83c70b',
      deposit: '441d43b4',
      trees: 'a7bd0ad1',
      shrubs: '3836f454',
    },
  },
  {
    // Un monde de grandes terres, montagneux, froid, humide et très arrosé.
    seed: 'beta',
    size: PREVIEW,
    overrides: {
      landShare: 0.5,
      seaLevel: 0.4,
      relief: 0.9,
      temperature: -4,
      humidity: 1.3,
      rivers: 1.6,
    },
    layers: {
      elevation: '882204d2',
      waterDepth: '7bc99dd6',
      biome: '7e20a226',
      drainage: '82d3dfbf',
      temperature: '49ea6e15',
      amplitude: '090f5558',
      precipitation: '626e603b',
      deposit: 'bd8072e3',
      trees: '1cbbdcda',
      shrubs: '02088d8a',
    },
  },
  {
    // Un archipel plat, chaud et sec.
    seed: 'gamma',
    size: PREVIEW,
    overrides: {
      landShare: 0.2,
      seaLevel: -0.5,
      relief: 0.1,
      temperature: 6,
      humidity: 0.6,
      rivers: 0.6,
    },
    layers: {
      elevation: 'c482f860',
      waterDepth: '50427725',
      biome: '75a7dd7c',
      drainage: '872a0118',
      temperature: '863b2be8',
      amplitude: '99f6ad61',
      precipitation: 'a82f4e0e',
      deposit: '36d4fe79',
      trees: '037a5e98',
      shrubs: '76e9efc7',
    },
  },
];

function layerFingerprints(layers: ReturnType<typeof generateWorld>): Record<LayerName, string> {
  return Object.fromEntries(
    LAYER_NAMES.map((name) => [name, new Fingerprint().typedArray(layers[name]).hex()]),
  ) as Record<LayerName, string>;
}

describe('empreintes de référence des mondes', () => {
  it('viennent de la version courante du générateur', () => {
    expect(GENERATOR_VERSION).toBe(REFERENCE_VERSION);
  });

  for (const reference of REFERENCES) {
    it(`redonnent le monde « ${reference.seed} », couche par couche`, () => {
      const params = {
        ...defaultWorldParams(data.worldgen.parameters, reference.seed, 'small'),
        ...reference.overrides,
        size: reference.size,
      };
      expect(layerFingerprints(generateWorld(params, data))).toEqual(reference.layers);
    });
  }

  it("redonnent le monde de l'auto-test du worker", () => {
    const params = defaultWorldParams(data.worldgen.parameters, SELFTEST_WORLD.seed, 'small');
    const world = generateWorld({ ...params, size: SELFTEST_WORLD.size }, data);
    expect(layersFingerprint(world)).toBe(EXPECTED_WORLD_FINGERPRINT);
  });
});
