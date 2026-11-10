import { describe, expect, it } from 'vitest';
import altitudeLevelsJson from '../../../data/altitude-levels.json';
import biomesJson from '../../../data/biomes.json';
import fr from '../../i18n/fr.json';
import { DataError, loadCatalog } from './catalog';
import { checkContent, loadGameData, type GameData } from './index';
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

  it('ne laisse franchir à pied ni le fleuve, ni les lacs, ni la mer (C1, D3)', () => {
    // Le biome « rivière » est le lit d'un fleuve, qu'on passe par un pont ou un bac ;
    // ruisseaux et rivières coulent sur les autres biomes, qu'on franchit.
    const cost = (id: string) => biomesJson.find((biome) => biome.id === id)?.movementCost;
    expect(cost('river')).toBeNull();
    expect(cost('deep-ocean')).toBeNull();
    expect(cost('lake')).toBeNull();
    expect(cost('beach')).toBeGreaterThanOrEqual(1);
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

describe('noms traduits', () => {
  const data = loadGameData();

  it('a un nom traduit pour chaque ressource et chaque espèce de la flore', () => {
    // Ces noms s'affichent par tKey : leur clé ne se vérifie pas à la compilation.
    const names = [
      ...data.resources.entries.map((resource) => resource.name),
      ...data.flora.entries.map((species) => species.name),
    ];
    expect(names.filter((name) => typeof messages[name] !== 'string')).toEqual([]);
  });
});

describe('cohérence du contenu', () => {
  const data = loadGameData();
  /** Les données livrées, dont un biome est remplacé. */
  const withBiome = (
    id: string,
    change: (biome: GameData['biomes']['entries'][number]) => object,
  ) =>
    ({
      ...data,
      biomes: {
        ...data.biomes,
        entries: data.biomes.entries.map((biome) => (biome.id === id ? change(biome) : biome)),
        indexOf: (key: string) => data.biomes.indexOf(key),
      },
    }) as GameData;

  it('ne trouve rien à redire aux données livrées', () => {
    expect(checkContent(data)).toEqual([]);
  });

  it("relève une flore qui contredit les densités d'un biome", () => {
    const treeless = withBiome('desert', (biome) => ({
      ...biome,
      flora: { ...biome.flora, trees: 0.4 },
    }));
    expect(checkContent(treeless)).toEqual([
      'data/biomes.json (flore) : desert a des tree sans espèce',
    ]);
    const unlisted = withBiome('glacier', (biome) => ({
      ...biome,
      flora: { ...biome.flora, species: ['conifer'] },
    }));
    expect(checkContent(unlisted)).toEqual([
      'data/biomes.json (flore) : glacier liste des tree sans densité',
    ]);
  });

  it('relève un identifiant inconnu', () => {
    const unknown = withBiome('marsh', (biome) => ({ ...biome, resources: ['unobtainium'] }));
    expect(checkContent(unknown)).toEqual([
      'data/biomes.json (ressources) : inconnus : unobtainium',
    ]);
  });

  it('borne les catalogues aux octets des couches du monde', () => {
    const many = {
      ...data,
      resources: {
        ...data.resources,
        entries: Array.from({ length: 256 }, (_, index) => ({
          ...data.resources.entries[index % data.resources.entries.length],
        })),
      },
    } as GameData;
    expect(checkContent(many)).toContain(
      'data/resources.json : 255 ressources au plus (couche des gisements sur un octet)',
    );
  });
});
