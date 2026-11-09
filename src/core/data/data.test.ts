import { describe, expect, it } from 'vitest';
import altitudeLevelsJson from '../../../data/altitude-levels.json';
import biomesJson from '../../../data/biomes.json';
import fr from '../../i18n/fr.json';
import { DataError, loadCatalog } from './catalog';
import { loadGameData } from './index';
import { AltitudeLevelsSchema, BiomesSchema } from './schemas';

/** Les 32 biomes naturels de la séance C1 (D6), par famille, tels que la séance les nomme. */
const C1_BIOMES: Readonly<Record<string, readonly string[]>> = {
  water: ['océan profond', 'océan', 'océan côtier', 'rivière', 'lac', 'lac salé'],
  coast: ['plage', 'côte rocheuse', 'falaise', 'mangrove', 'marais littoral'],
  wetland: ['marais', 'tourbière', 'marécage'],
  cold: ['glacier', 'toundra', 'taïga', 'forêt froide', 'steppe froide'],
  mountain: ['alpin', 'montagne', 'haute montagne'],
  temperate: ['prairie', 'steppe', 'forêt tempérée', 'forêt pluviale tempérée'],
  arid: ['désert', 'salar'],
  tropical: ['savane', 'prairie tropicale', 'forêt tropicale', 'forêt pluviale'],
};

const messages: Readonly<Record<string, unknown>> = fr;

describe('data/biomes.json', () => {
  const { biomes } = loadGameData();

  it('est valide et compte les 32 biomes de C1', () => {
    expect(biomes.entries).toHaveLength(32);
  });

  it('suit les familles et les noms de la séance C1 (D6)', () => {
    const byFamily: Record<string, string[]> = {};
    for (const biome of biomes.entries) {
      (byFamily[biome.family] ??= []).push(String(messages[biome.name]));
    }
    expect(byFamily).toEqual(C1_BIOMES);
  });

  it('a un nom traduit pour chaque biome', () => {
    expect(biomes.entries.filter((biome) => typeof messages[biome.name] !== 'string')).toEqual([]);
  });

  it("convertit les identifiants en indices, dans l'ordre du fichier", () => {
    expect(biomes.indexOf('deep-ocean')).toBe(0);
    expect(biomes.indexOf('rainforest')).toBe(31);
    expect(biomes.indexOf('inconnu')).toBeUndefined();
  });
});

describe('validation', () => {
  const valid = biomesJson[0];
  const load = (raw: unknown) => () => loadCatalog('essai.json', BiomesSchema, raw);

  it('refuse un fichier invalide, avec le chemin de chaque problème', () => {
    expect(load([{ ...valid, fertility: 2 }])).toThrow(DataError);
    expect(load([{ ...valid, fertility: 2 }])).toThrow(/0\.fertility/);
    expect(load([{ ...valid, family: 'lunar' }])).toThrow(/0\.family/);
    expect(load([{ ...valid, palette: { ...valid.palette, base: 'bleu' } }])).toThrow(
      /palette\.base/,
    );
    expect(load([{ ...valid, extra: true }])).toThrow(DataError);
    expect(load([{ ...valid, id: 'Deep Ocean' }])).toThrow(/0\.id/);
  });

  it('refuse les identifiants en double', () => {
    expect(load([valid, valid])).toThrow(/en double : deep-ocean/);
  });

  it('vérifie la cohérence entre la famille et les effets', () => {
    expect(load([{ ...valid, landing: 'easy' }])).toThrow(/landing/);
    const beach = biomesJson.find((biome) => biome.id === 'beach');
    expect(load([{ ...beach, landing: undefined }])).toThrow(/landing/);
    expect(load([{ ...beach, movementCost: null }])).toThrow(/movementCost/);
  });

  it('laisse franchir les rivières à pied, mais pas la haute mer (C1, D3)', () => {
    const cost = (id: string) => biomesJson.find((biome) => biome.id === id)?.movementCost;
    expect(cost('river')).toBeGreaterThanOrEqual(1);
    expect(cost('deep-ocean')).toBeNull();
    expect(cost('lake')).toBeNull();
  });
});

describe('data/altitude-levels.json', () => {
  const { altitudeLevels } = loadGameData();
  const load = (raw: unknown) => () => loadCatalog('essai.json', AltitudeLevelsSchema, raw);

  it('a un nom traduit pour chaque niveau', () => {
    expect(
      altitudeLevels.entries.filter((level) => typeof messages[level.name] !== 'string'),
    ).toEqual([]);
  });

  it('refuse des niveaux qui ne se suivent pas', () => {
    const levels = altitudeLevelsJson;
    expect(load(levels)).not.toThrow();
    expect(load(levels.slice(1))).toThrow(/se suivre/);
    expect(load(levels.filter((level) => level.id !== 'plain-three'))).toThrow(/se suivre/);
    expect(load(levels.slice(0, -1))).toThrow(/dernier niveau/);
    expect(
      load(
        levels.map((level) => (level.id === 'shelf' ? { ...level, navigation: undefined } : level)),
      ),
    ).toThrow(/naviguent/);
  });
});
