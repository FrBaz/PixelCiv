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
const REFERENCE_VERSION = 2;

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
      elevation: '79d7deec',
      waterDepth: '5b0a52b9',
      biome: 'ced6d145',
      drainage: '15c25dc4',
      temperature: '9087ec07',
      amplitude: '391a6421',
      precipitation: 'd1fbff27',
      deposit: 'f157a5bc',
      trees: '88d7caa8',
      shrubs: 'd4ae0fc5',
    },
  },
  {
    seed: 'alpha',
    size: PREVIEW,
    overrides: {},
    layers: {
      elevation: '61c26e44',
      waterDepth: '6a5dfb95',
      biome: 'e95f7447',
      drainage: '4b7ee1ca',
      temperature: '16559913',
      amplitude: '8bc2ae6e',
      precipitation: '19ec6e39',
      deposit: '65acc879',
      trees: '2ad63247',
      shrubs: 'a6b4e528',
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
      elevation: 'b555fde1',
      waterDepth: 'eb27cca1',
      biome: 'bf68e113',
      drainage: '3cf59c92',
      temperature: 'd42259cd',
      amplitude: '2da21610',
      precipitation: '3e17199f',
      deposit: 'bfbb5af5',
      trees: 'a7b9ee9a',
      shrubs: 'e44e29e1',
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
      elevation: '0776dc81',
      waterDepth: '19ee6524',
      biome: 'f48b6fed',
      drainage: 'bad12ed0',
      temperature: 'c3351a21',
      amplitude: 'aa9b25f3',
      precipitation: 'ae96dd70',
      deposit: 'bb2ac35b',
      trees: '76a8b491',
      shrubs: 'e79fc6ac',
    },
  },
  {
    // Une carte Moyenne : les étapes qui dépendent de la taille (flou des pluies sur deux
    // cases, ouverture des zones humides) y prennent les valeurs d'une carte Grand.
    seed: 'delta',
    size: WORLD_SIZES.medium,
    overrides: {},
    layers: {
      elevation: 'e4c97ba3',
      waterDepth: '509ca591',
      biome: '0a68c13d',
      drainage: '21fc058c',
      temperature: '84c07770',
      amplitude: '33149838',
      precipitation: '1eca7683',
      deposit: '687c6962',
      trees: '70a0bfbb',
      shrubs: 'a99657a0',
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
