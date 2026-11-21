import { describe, expect, it } from 'vitest';
import altitudeLevelsJson from '../../../data/altitude-levels.json';
import biomesJson from '../../../data/biomes.json';
import fr from '../../i18n/fr.json';
import { DataError, loadCatalog } from './catalog';
import {
  checkContent,
  loadGameData,
  MAX_LOOKS,
  type GameData,
  type Genetics,
  type Species,
} from './index';
import { HumansSchema, LEVEL_STEP, MAX_OUTFITS, MAX_SKIN_PALETTES } from './humans';
import { DecorSchema, FloraLookSchema } from './decor';
import {
  FaunaFileSchema,
  FaunaListSchema,
  FaunaRulesSchema,
  FaunaSpeciesSchema,
  MAX_DENSITY,
  MAX_FAUNA_SPECIES,
  MAX_HERD,
} from './fauna';
import {
  AppearanceSchema,
  FACE_BOUNDS,
  GeneticsSchema,
  geneRoles,
  NomadsSchema,
  NOSE_BOUNDS,
  SpeciesSchema,
  type Nomads,
} from './people';
import {
  AltitudeLevelsSchema,
  BiomeSchema,
  BiomesSchema,
  FloraSchema,
  SEASON_STATES,
  SeasonsSchema,
  VEGETATION_STATES,
  type Seasons,
} from './schemas';
import {
  bakedWaterTone,
  CREST_TONES,
  MAX_CREST_LENGTH,
  MAX_CREST_THICKNESS,
  MAX_WAVE_BIOMES,
} from '../waves';

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

describe('mer animée, dans data/biomes.json (ADR 0015)', () => {
  const load = (raw: unknown) => () => loadCatalog('essai.json', BiomesSchema, raw);
  const byId = (id: string) => {
    const biome = biomesJson.find((entry) => entry.id === id);
    if (biome === undefined) throw new Error(`biome ${id} absent`);
    return biome;
  };
  const coastal = byId('coastal-ocean');
  const waves = coastal.waves;
  const grassland = byId('grassland');
  /** La mer côtière, avec d'autres réglages de crête. */
  const crest = (change: Record<string, unknown>) => [
    { ...coastal, waves: { ...waves, crest: { ...waves?.crest, ...change } } },
  ];

  it('anime la mer, et elle seule, moins au large qu’à la côte', () => {
    const { biomes } = loadGameData();
    const animated = biomes.entries.filter((biome) => biome.waves !== undefined);
    // La mer seule (ADR 0015, point 3) : animer une autre eau est une décision, qui revoit ce
    // test, celui des eaux immobiles du miroir et les tons cuits envoyés au worker.
    expect(animated.map((biome) => biome.id)).toEqual(['deep-ocean', 'ocean', 'coastal-ocean']);
    // Du large à la côte, chaque réglage croît ou reste égal : parts des crêtes et des clapots,
    // longueur, épaisseur et ton des crêtes. Leurs valeurs restent celles des données, que
    // l'auteur règle sans toucher aux tests (le miroir vérifie que la côte bouge plus).
    const settings = animated.map(({ waves }) =>
      waves === undefined
        ? []
        : [
            waves.crest.share,
            waves.ripple.share,
            waves.crest.length,
            waves.crest.thickness,
            CREST_TONES.indexOf(waves.crest.tone),
          ],
    );
    settings.slice(1).forEach((coastward, rank) => {
      const offshore = settings[rank] ?? [];
      expect(coastward).toHaveLength(5);
      coastward.forEach((value, column) => {
        expect(value).toBeGreaterThanOrEqual(offshore[column] ?? Number.NaN);
      });
    });
  });

  it('accepte les bornes du motif', () => {
    expect(load(crest({ length: MAX_CREST_LENGTH, thickness: MAX_CREST_THICKNESS }))).not.toThrow();
    expect(load(crest({ length: 1, thickness: 1, tone: 'base', share: 0 }))).not.toThrow();
  });

  it('refuse un réglage hors des bornes, ou que le shader ne saurait pas dessiner', () => {
    expect(load(crest({ length: MAX_CREST_LENGTH + 1 }))).toThrow(/waves\.crest\.length/);
    expect(load(crest({ length: 0 }))).toThrow(/waves\.crest\.length/);
    expect(load(crest({ length: 2.5 }))).toThrow(/waves\.crest\.length/);
    expect(load(crest({ thickness: MAX_CREST_THICKNESS + 1 }))).toThrow(/waves\.crest\.thickness/);
    expect(load(crest({ thickness: 0 }))).toThrow(/waves\.crest\.thickness/);
    expect(load(crest({ tone: 'shadow' }))).toThrow(/waves\.crest\.tone/);
    expect(load(crest({ share: 1.2 }))).toThrow(/waves\.crest\.share/);
    expect(load(crest({ share: -0.1 }))).toThrow(/waves\.crest\.share/);
    expect(load([{ ...coastal, waves: { ...waves, ripple: { share: 2 } } }])).toThrow(
      /waves\.ripple\.share/,
    );
    expect(load(crest({ speed: 2 }))).toThrow(/waves\.crest/);
    expect(load([{ ...coastal, waves: { crest: waves?.crest } }])).toThrow(/waves\.ripple/);
  });

  it('refuse une mer animée sur une terre', () => {
    expect(load([{ ...grassland, waves }])).toThrow(/0\.waves.*seules les eaux/s);
  });

  it(`refuse plus de ${String(MAX_WAVE_BIOMES)} biomes animés`, () => {
    // Des eaux animées aux tons tous différents : seul leur nombre est en cause.
    const waters = Array.from({ length: MAX_WAVE_BIOMES + 1 }, (_, index) => {
      const tone = (step: number) =>
        `#${(16 * index + 2 * step).toString(16).padStart(2, '0')}4080`;
      return {
        ...coastal,
        id: `mer-${'abcde'.charAt(index)}`,
        palette: { shadow: tone(0), base: tone(1), light: tone(2) },
      };
    });
    expect(load(waters.slice(0, MAX_WAVE_BIOMES))).not.toThrow();
    expect(load(waters)).toThrow(/5 biomes ont une mer animée, 4 au plus/);
  });

  it('refuse deux eaux de même ton cuit, dont l’une est animée, et nomme les deux', () => {
    const lake = byId('lake');
    const hex = (value: number) => `#${value.toString(16).padStart(6, '0')}`;
    const light = Number.parseInt(coastal.palette.light.slice(1), 16);
    // La lumière de la mer côtière, aux bits faibles du rouge et du vert près, que la cuisson
    // efface : le même ton cuit.
    const twin = { ...lake, palette: { ...lake.palette, base: hex(light ^ 0x010100) } };
    const shared = hex(bakedWaterTone(coastal.palette.light));
    expect(load([coastal, twin])).toThrow(`coastal-ocean et lake partagent le ton cuit ${shared}`);
    // Au bit faible du bleu près, que la cuisson garde : un autre ton.
    expect(
      load([coastal, { ...twin, palette: { ...lake.palette, base: hex(light ^ 0x000001) } }]),
    ).not.toThrow();
    // Deux eaux immobiles peuvent se ressembler : aucune ne se reconnaît à son ton.
    const still = { ...coastal, waves: undefined };
    expect(load([still, twin])).not.toThrow();
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

describe('data/species.json et data/genetics.json', () => {
  const { species, genetics } = loadGameData();

  it('compte les humains en trois sous-espèces : nordiques, des plaines, des sables (ESP-01)', () => {
    expect(species.entries.map((entry) => entry.id)).toEqual(['human']);
    expect(species.entries[0]?.subspecies.map((entry) => entry.id)).toEqual([
      'nordic',
      'plains',
      'sands',
    ]);
  });

  it('ne distingue pas les sous-espèces par leurs capacités mentales (ESP-02)', () => {
    for (const entry of species.entries) {
      const mind = (id: string) =>
        entry.subspecies.map((subspecies) => subspecies.appearance.traits[id]);
      for (const id of ['intelligence', 'ambition']) {
        const distributions = mind(id);
        expect(distributions[0]).toBeDefined();
        for (const distribution of distributions) expect(distribution).toEqual(distributions[0]);
      }
    }
  });

  it('a un nom traduit pour chaque espèce, sous-espèce, locus, allèle et trait', () => {
    const names = [
      ...species.entries.flatMap((entry) => [
        entry.name,
        ...entry.subspecies.map((subspecies) => subspecies.name),
      ]),
      ...genetics.loci.flatMap((locus) => [locus.name, ...locus.alleles.map((a) => a.name)]),
      ...genetics.traits.map((trait) => trait.name),
    ];
    expect(names.filter((name) => typeof messages[name] !== 'string')).toEqual([]);
  });

  it('relève une apparence qui renvoie à un allèle ou à un trait inconnu', () => {
    const data = loadGameData();
    const human = data.species.entries.at(0);
    if (human === undefined) throw new Error('pas d’espèce');
    const broken = {
      ...human,
      subspecies: human.subspecies.map((subspecies, index) =>
        index === 0
          ? {
              ...subspecies,
              appearance: {
                alleles: { ...subspecies.appearance.alleles, eyes: { violet: 1 } },
                traits: { ...subspecies.appearance.traits, charm: { mean: 0.5, sd: 0.1 } },
              },
            }
          : subspecies,
      ),
    };
    const problems = checkContent({
      ...data,
      species: { ...data.species, entries: [broken] },
    });
    expect(problems).toEqual([
      'data/species.json (human, nordic) : allèles inconnus : violet',
      "data/species.json (human, nordic) : aucun allèle du locus eyes n'a de fréquence",
      'data/species.json (human, nordic) : traits inconnus : charm',
    ]);
  });
});

describe('rôles des gènes et formes des allèles (D-6, A-10, W-12)', () => {
  const { genetics } = loadGameData();
  /** Les problèmes que le schéma relève dans une variante de data/genetics.json. */
  const problems = (variant: unknown) => {
    const result = GeneticsSchema.safeParse(variant);
    return result.success
      ? []
      : result.error.issues.map((issue) => `${issue.path.join('.')} : ${issue.message}`);
  };
  /** La génétique des données, dont le locus `id` est remplacé. */
  const withLocus = (id: string, change: (locus: Genetics['loci'][number]) => object) => ({
    ...genetics,
    loci: genetics.loci.map((locus) => (locus.id === id ? change(locus) : locus)),
  });

  it('désigne par un rôle les yeux, les cheveux, le visage, le nez, le teint et la taille', () => {
    expect(problems(genetics)).toEqual([]);
    const roles = geneRoles(genetics);
    expect(genetics.loci[roles.loci.hair]?.role).toBe('hair');
    expect(genetics.loci[roles.loci.eyes]?.role).toBe('eyes');
    expect(genetics.loci[roles.loci.face]?.role).toBe('face');
    expect(genetics.loci[roles.loci.nose]?.role).toBe('nose');
    expect(genetics.traits[roles.traits.skin]?.role).toBe('skin');
    expect(genetics.traits[roles.traits.height]?.role).toBe('height');
    // La rapidité règle l'allure de la marche (ADR 0014).
    expect(genetics.traits[roles.traits.speed]?.role).toBe('speed');
  });

  it('exige que chaque rôle soit tenu, et par un seul gène', () => {
    const anonymous = {
      ...genetics,
      traits: genetics.traits.map(({ role: _role, ...entry }) => entry),
    };
    expect(problems(anonymous)).toEqual([
      'traits : aucun trait ne tient le rôle skin',
      'traits : aucun trait ne tient le rôle height',
      'traits : aucun trait ne tient le rôle speed',
    ]);
    // Le rôle de la rapidité, exigé une fois comme les autres.
    const slow = {
      ...genetics,
      traits: genetics.traits.map(({ role, ...entry }) =>
        role === 'speed' ? entry : { ...entry, ...(role === undefined ? {} : { role }) },
      ),
    };
    expect(problems(slow)).toEqual(['traits : aucun trait ne tient le rôle speed']);
    expect(() => geneRoles(slow)).toThrow(DataError);
    const fast = {
      ...genetics,
      traits: genetics.traits.map((entry) =>
        entry.id === 'strength' ? { ...entry, role: 'speed' } : entry,
      ),
    };
    expect(problems(fast)).toEqual(['traits : plusieurs traits tiennent le rôle speed']);
    expect(() => geneRoles(anonymous)).toThrow(DataError);
    const twice = {
      ...genetics,
      traits: genetics.traits.map((entry) => ({ ...entry, role: entry.role ?? 'skin' })),
    };
    expect(problems(twice)).toEqual(['traits : plusieurs traits tiennent le rôle skin']);
    const unknown = withLocus('eyes', (locus) => ({ ...locus, role: 'horns' }));
    expect(problems(unknown).at(0)).toMatch(/^loci\.0\.role : /);
  });

  it('refuse un allèle de visage ou de nez sans forme, et des cheveux colorés hors de leurs rampes', () => {
    const faceless = withLocus('face', (locus) => ({
      ...locus,
      alleles: [...locus.alleles, { id: 'heart', name: 'gene.face.oval', dominance: 0 }],
    }));
    expect(problems(faceless)).toEqual(['loci.2.alleles.4.face : demandé par le rôle face']);
    const noseless = withLocus('nose', (locus) => ({
      ...locus,
      alleles: locus.alleles.map((allele, index) =>
        index === 1 ? { ...allele, nose: undefined } : allele,
      ),
    }));
    expect(problems(noseless)).toEqual(['loci.3.alleles.1.nose : demandé par le rôle nose']);
    // Les tons des cheveux sont dans data/appearance.json, une seule source par allèle.
    const colored = withLocus('hair', (locus) => ({
      ...locus,
      alleles: locus.alleles.map((allele) => ({ ...allele, color: '#1f1b19' })),
    }));
    expect(problems(colored)).toHaveLength(4);
    expect(problems(colored).at(0)).toBe('loci.1.alleles.0.color : sans emploi pour le rôle hair');
    // Une forme hors de son rôle, ou hors des bornes du portrait.
    const misplaced = withLocus('eyes', (locus) => ({
      ...locus,
      alleles: locus.alleles.map((allele, index) =>
        index === 0 ? { ...allele, face: { width: 12, height: 16, power: 2, jaw: 0.2 } } : allele,
      ),
    }));
    expect(problems(misplaced)).toEqual(['loci.0.alleles.0.face : sans emploi pour le rôle eyes']);
    const roleless = withLocus('eyes', ({ role: _role, ...locus }) => locus);
    expect(problems(roleless)).toContain(
      'loci.0.alleles.0.color : sans emploi pour un locus sans rôle',
    );
  });

  it('borne les formes à ce que le portrait sait dessiner', () => {
    /** Les problèmes d'une forme donnée au premier allèle du visage, ou du nez. */
    const shaped = (role: 'face' | 'nose', shape: object) =>
      problems(
        withLocus(role, (locus) => ({
          ...locus,
          alleles: locus.alleles.map((allele, index) =>
            index === 0 ? { ...allele, [role]: { ...allele[role], ...shape } } : allele,
          ),
        })),
      );
    const { width, height, jaw } = FACE_BOUNDS;
    for (const shape of [
      { width: width[0], height: height[0], power: 4, jaw: jaw[1] },
      { width: width[1], height: height[1], power: 2, jaw: jaw[0] },
    ]) {
      expect(shaped('face', shape)).toEqual([]);
    }
    for (const shape of [
      { width: width[0] - 1 },
      { width: width[1] + 1 },
      { height: height[0] - 1 },
      { height: height[1] + 1 },
      { jaw: jaw[1] + 0.01 },
      { jaw: -0.01 },
      { power: 3 },
      { width: 12.5 },
    ]) {
      expect(shaped('face', shape), JSON.stringify(shape)).toHaveLength(1);
    }
    const { length, wing } = NOSE_BOUNDS;
    expect(shaped('nose', { length: length[1], wing: wing[1] })).toEqual([]);
    for (const shape of [
      { length: length[0] - 1 },
      { length: length[1] + 1 },
      { wing: wing[0] - 1 },
      { wing: wing[1] + 1 },
    ]) {
      expect(shaped('nose', shape), JSON.stringify(shape)).toHaveLength(1);
    }
  });
});

describe('âges de la vie et confort, dans data/species.json (D-6, A-10, U-12)', () => {
  const human = loadGameData().species.entries.at(0);
  if (human === undefined) throw new Error('pas d’humains');
  const valid = (species: Species) => SpeciesSchema.safeParse(species).success;

  it('donne aux humains les âges de leur apparence et de leur confort', () => {
    expect(valid(human)).toBe(true);
    expect(human.ages).toMatchObject({ baby: 3, elder: 55, grey: [40, 70], beard: 18, bald: 48 });
    expect(human.hardship).toMatchObject({ comfort: [0, 30], extremes: [-20, 40] });
  });

  it('refuse des âges de la vie qui ne se suivent pas', () => {
    expect(valid({ ...human, ages: { ...human.ages, baby: human.maturity } })).toBe(false);
    expect(valid({ ...human, ages: { ...human.ages, elder: human.maturity } })).toBe(false);
    expect(valid({ ...human, ages: { ...human.ages, elder: human.longevity } })).toBe(false);
    expect(valid({ ...human, ages: { ...human.ages, grey: [70, 40] } })).toBe(false);
    // Une espèce qui mûrit à 30 ans, vit 400 ans et devient aînée à 300 ans.
    expect(
      valid({
        ...human,
        maturity: 30,
        longevity: 400,
        ages: { ...human.ages, baby: 6, elder: 300, grey: [250, 380] },
      }),
    ).toBe(true);
  });

  it("borne la stature à l'octet de l'image des groupes (ADR 0014)", () => {
    expect(human.display.stature).toBe(0.75);
    // 0,75 × 2 × 195 / 340 = 0,86 case pour le plus grand adulte : il tient sur un octet.
    const display = (stature: number, height: [number, number] = human.height) =>
      valid({ ...human, height, display: { ...human.display, stature } });
    expect(display(1.7)).toBe(true);
    expect(display(1.8)).toBe(false);
    // La plus grande taille compte, que la liste la donne en premier ou en second.
    expect(display(1.7, [195, 145])).toBe(true);
    expect(display(1.8, [195, 145])).toBe(false);
    expect(display(0)).toBe(false);
  });

  it('refuse une croissance mal ordonnée, ou qui ne finit pas à la stature adulte', () => {
    const growth = (points: [number, number][]) =>
      valid({ ...human, display: { ...human.display, growth: points } });
    expect(
      growth([
        [0, 0.4],
        [12, 0.9],
        [18, 1],
      ]),
    ).toBe(true);
    expect(
      growth([
        [0, 0.4],
        [12, 0.9],
        [12, 1],
      ]),
    ).toBe(false);
    expect(
      growth([
        [0, 0.4],
        [18, 1],
        [12, 0.9],
      ]),
    ).toBe(false);
    expect(
      growth([
        [0, 0.4],
        [18, 0.9],
      ]),
    ).toBe(false);
    expect(
      growth([
        [0, 0],
        [18, 1],
      ]),
    ).toBe(false);
    expect(
      growth([
        [0, 0.4],
        [10, 1.2],
        [18, 1],
      ]),
    ).toBe(false);
    expect(growth([])).toBe(false);
  });

  it("refuse une allure dont les âges se suivent mal ou dont les bornes s'inversent", () => {
    const pace = (change: Partial<Species['pace']>) =>
      valid({ ...human, pace: { ...human.pace, ...change } });
    expect(pace({})).toBe(true);
    expect(pace({ speed: [1.2, 0.8] })).toBe(false);
    expect(pace({ speed: [0, 1] })).toBe(false);
    expect(
      pace({
        age: [
          [10, 1],
          [5, 0.8],
        ],
      }),
    ).toBe(false);
    expect(pace({ age: [[0, 0]] })).toBe(false);
    expect(pace({ carrying: 0 })).toBe(false);
    expect(pace({ pregnant: 1.5 })).toBe(false);
  });

  it('refuse un confort qui ne tient pas entre ses deux extrêmes', () => {
    const hardship = (comfort: [number, number], extremes: [number, number]) =>
      valid({ ...human, hardship: { ...human.hardship, comfort, extremes } });
    expect(hardship([-10, 25], [-30, 35])).toBe(true);
    expect(hardship([0, 30], [0, 40])).toBe(false);
    expect(hardship([0, 30], [-20, 30])).toBe(false);
    expect(hardship([30, 0], [-20, 40])).toBe(false);
  });
});

describe('réglages du mouvement, dans data/nomads.json (ADR 0014)', () => {
  const { nomads } = loadGameData();
  const valid = (variant: unknown) => NomadsSchema.safeParse(variant).success;
  const camp = (change: Partial<Nomads['camp']>) =>
    valid({ ...nomads, camp: { ...nomads.camp, ...change } });
  const walkers = (change: Partial<Nomads['walkers']>) =>
    valid({ ...nomads, walkers: { ...nomads.walkers, ...change } });

  it('donne au camp et aux marcheurs les réglages livrés', () => {
    expect(valid(nomads)).toBe(true);
    expect(nomads.camp).toMatchObject({ cohesion: 0.5, gap: 0.45, lag: 20, hurry: 1.25 });
    expect(nomads.walkers).toEqual({ gap: 0.25, aside: 0.3, every: 3 });
  });

  it('refuse des réglages hors de leurs bornes', () => {
    expect(camp({ cohesion: -0.1 })).toBe(false);
    expect(camp({ cohesion: 1.1 })).toBe(false);
    expect(camp({ cohesion: 1 })).toBe(true);
    expect(camp({ lag: 29 })).toBe(true);
    expect(camp({ lag: 30 })).toBe(false);
    expect(camp({ lag: 2.5 })).toBe(false);
    expect(camp({ lag: -1 })).toBe(false);
    expect(camp({ hurry: 0.9 })).toBe(false);
    expect(camp({ hurry: 2.1 })).toBe(false);
    expect(camp({ kin: [-0.1, 1] })).toBe(false);
    expect(camp({ kin: [1, 3.5] })).toBe(false);
    expect(camp({ band: [1, 7] })).toBe(true);
    expect(camp({ band: [1, 7.5] })).toBe(false);
    expect(camp({ spread: 1.5 })).toBe(false);
    expect(camp({ wean: 0 })).toBe(false);
    expect(camp({ wait: -1 })).toBe(false);
    expect(camp({ field: 4 })).toBe(false);
    expect(camp({ field: 48.5 })).toBe(false);
    expect(walkers({ aside: 0 })).toBe(false);
    expect(walkers({ aside: 0.5 })).toBe(true);
    expect(walkers({ aside: 0.6 })).toBe(false);
    expect(walkers({ every: 0 })).toBe(false);
    expect(walkers({ every: 30 })).toBe(true);
    expect(walkers({ every: 31 })).toBe(false);
    expect(walkers({ every: 1.5 })).toBe(false);
  });

  it("veut l'écart des marcheurs plus petit que celui du repos, tous deux sous une case", () => {
    expect(walkers({ gap: 0 })).toBe(false);
    expect(walkers({ gap: 0.45 })).toBe(false);
    expect(walkers({ gap: 0.44 })).toBe(true);
    expect(camp({ gap: 1 })).toBe(false);
    expect(camp({ gap: 0.2 })).toBe(false);
    expect(valid({ ...nomads, camp: { ...nomads.camp, gap: 0.9 } })).toBe(true);
  });
});

describe('humains des planches et leurs tenues (ADR 0016)', () => {
  const data = loadGameData();
  const { appearance, humans } = data;
  /** Les problèmes d'une apparence ou de données des humains, chacun « chemin : message ». */
  const issues = (schema: typeof AppearanceSchema | typeof HumansSchema, value: unknown) => {
    const parsed = schema.safeParse(value);
    return parsed.success
      ? []
      : parsed.error.issues.map((issue) => `${issue.path.join('.')} : ${issue.message}`);
  };
  const withAppearance = (change: Partial<typeof appearance>) => ({ ...appearance, ...change });
  const withHumans = (change: Partial<typeof humans>) => ({ ...humans, ...change });

  it('accepte les données livrées', () => {
    expect(issues(AppearanceSchema, appearance)).toEqual([]);
    expect(issues(HumansSchema, humans)).toEqual([]);
  });

  it(`borne les palettes de peau à ${String(MAX_SKIN_PALETTES)} et les tenues à ${String(MAX_OUTFITS)}, les bits de l’apparence`, () => {
    const palette = appearance.skinPalettes.at(0);
    if (palette === undefined) throw new Error('pas de palette');
    const palettes = Array.from({ length: MAX_SKIN_PALETTES + 1 }, (_, index) => ({
      ...palette,
      id: `skin-${'abcdefghi'[index] ?? 'z'}`,
      upTo: Math.min(15, index),
    }));
    expect(issues(AppearanceSchema, withAppearance({ skinPalettes: palettes })).join()).toMatch(
      /skinPalettes : Too big/,
    );
    const outfit = appearance.outfits.at(0);
    if (outfit === undefined) throw new Error('pas de tenue');
    const outfits = Array.from({ length: MAX_OUTFITS + 1 }, (_, index) => ({
      ...outfit,
      id: `outfit-${'abcdefghijklmnopq'[index] ?? 'z'}`,
    }));
    expect(issues(AppearanceSchema, withAppearance({ outfits })).join()).toMatch(
      /outfits : Too big/,
    );
    // Toutes les apparences possibles tiennent dans la texture des palettes.
    const looks =
      appearance.skinPalettes.length *
      4 *
      (appearance.greying.length + 1) *
      appearance.outfits.length *
      4;
    expect(looks).toBeLessThanOrEqual(MAX_LOOKS);
  });

  it('refuse des teints qui ne croissent pas, ou qui s’arrêtent avant 15', () => {
    const [first, second, ...rest] = appearance.skinPalettes;
    expect(
      issues(AppearanceSchema, withAppearance({ skinPalettes: [second, first, ...rest] })),
    ).toContain('skinPalettes : des teints croissants');
    const short = appearance.skinPalettes.slice(0, -1);
    expect(issues(AppearanceSchema, withAppearance({ skinPalettes: short }))).toContain(
      'skinPalettes : la dernière palette va au teint 15',
    );
  });

  it('refuse un tissu, une tenue, une rampe de gris ou une peau inconnus, et un tissu de rechange qui se remplace', () => {
    const outfit = appearance.outfits.at(0);
    if (outfit === undefined) throw new Error('pas de tenue');
    const silk = { ...outfit, female: [{ fabric: 'silk', regions: ['chest', 'hips'] }] };
    expect(
      issues(AppearanceSchema, withAppearance({ outfits: [silk, ...appearance.outfits.slice(1)] })),
    ).toContain('outfits.0.female.0.fabric : tissu inconnu : silk');
    expect(issues(AppearanceSchema, withAppearance({ cultureOutfits: ['toga'] }))).toContain(
      'cultureOutfits.0 : tenue inconnue : toga',
    );
    const greying = appearance.greying.map((step, index) =>
      index === 0 ? { ...step, ramp: 'silver' } : step,
    );
    expect(issues(AppearanceSchema, withAppearance({ greying }))).toContain(
      'greying.0.ramp : rampe de gris inconnue : silver',
    );
    expect(
      issues(AppearanceSchema, withAppearance({ greying: appearance.greying.slice(1) })).join(),
    ).toMatch(/greying : Too small/);
    const fabrics = appearance.fabrics.map((fabric) =>
      fabric.id === 'linen'
        ? { ...fabric, onSkin: { ...fabric.onSkin, purple: 'leather', medium: 'leather' } }
        : fabric,
    );
    const found = issues(AppearanceSchema, withAppearance({ fabrics }));
    expect(found).toContain('fabrics.5.onSkin.purple : palette de peau inconnue : purple');
    // Le cuir se remplace lui-même par du lin sur la peau medium : pas de chaîne.
    expect(found).toContain('fabrics.5.onSkin.medium : leather se remplace lui-même sur medium');
  });

  it('relève une tenue sur une région inconnue, des cheveux sans tons, ou trop d’apparences possibles', () => {
    const outfits = appearance.outfits.map((outfit, index) =>
      index === 0 ? { ...outfit, male: [{ fabric: 'linen', regions: ['hips', 'tail'] }] } : outfit,
    );
    expect(checkContent({ ...data, appearance: { ...appearance, outfits } })).toContain(
      'data/appearance.json (tunic, male) : régions inconnues : tail',
    );
    const { red: _red, ...hair } = appearance.hair;
    expect(checkContent({ ...data, appearance: { ...appearance, hair } })).toContain(
      'data/appearance.json (hair) : allèles sans tons : red',
    );
    expect(
      checkContent({
        ...data,
        appearance: {
          ...appearance,
          hair: { ...appearance.hair, green: ['#00ff00', '#00cc00', '#009900'] },
        },
      }),
    ).toContain('data/appearance.json (hair) : allèles inconnus : green');
    // Seize tenues, huit peaux, seize allèles de cheveux : 32 768 apparences possibles.
    const letters = 'abcdefghijklmnop';
    const template = appearance.outfits.at(0);
    const skin = appearance.skinPalettes.at(0);
    if (template === undefined || skin === undefined) throw new Error('données');
    const many = Array.from(letters, (letter) => ({ ...template, id: `outfit-${letter}` }));
    const palettes = Array.from(letters.slice(0, 8), (letter, index) => ({
      ...skin,
      id: `skin-${letter}`,
      upTo: index === 7 ? 15 : index,
    }));
    const hairLocus = data.genetics.loci.findIndex((locus) => locus.role === 'hair');
    const alleles = Array.from(letters, (letter, index) => ({
      id: `hair-${letter}`,
      name: 'gene.hair.black',
      dominance: index,
    }));
    const genetics = {
      ...data.genetics,
      loci: data.genetics.loci.map((locus, index) =>
        index === hairLocus ? { ...locus, alleles } : locus,
      ),
    };
    const black = appearance.hair.black;
    const ramps = Object.fromEntries(alleles.map((allele) => [allele.id, black]));
    const crowded = {
      ...appearance,
      outfits: many,
      skinPalettes: palettes,
      hair: ramps,
      cultureOutfits: [many[0]?.id ?? ''],
    };
    expect(checkContent({ ...data, genetics, appearance: crowded })).toContain(
      'data/appearance.json : 32768 apparences possibles, 16384 au plus',
    );
  });

  it('refuse des régions en double, sans cheveux, des tons gardés en trop, et des niveaux mal rangés', () => {
    const [scalp, face, ...others] = humans.regions;
    expect(
      issues(
        HumansSchema,
        withHumans({ regions: [scalp, { ...face, letter: scalp.letter }, ...others] }),
      ),
    ).toContain('regions : une lettre par région');
    expect(
      issues(HumansSchema, withHumans({ regions: [{ ...scalp, hair: false }, face, ...others] })),
    ).toContain('regions : une seule région porte les cheveux');
    expect(
      issues(
        HumansSchema,
        withHumans({ regions: [{ ...scalp, letter: 'o' }, face, ...others] }),
      ).join(),
    ).toMatch(/regions\.0\.letter : une majuscule/);
    const kept = Array.from(
      { length: 13 },
      (_, index) => `#0000${index.toString(16).padStart(2, '0')}`,
    );
    expect(issues(HumansSchema, withHumans({ tones: { ...humans.tones, kept } }))).toContain(
      'tones : 15 tons gardés au plus',
    );
    expect(
      issues(HumansSchema, withHumans({ tones: { ...humans.tones, kept: ['#13131c'] } })),
    ).toContain('tones : chaque ton une seule fois');
    const [first, second, ...rest] = humans.levels;
    expect(issues(HumansSchema, withHumans({ levels: [second, first, ...rest] }))).toContain(
      'levels.0 : le premier niveau est la planche à sa taille, sans variante',
    );
    expect(
      issues(
        HumansSchema,
        withHumans({ levels: [first, { ...second, variants: [-1, 0, 1, 2] }, ...rest] }),
      ).join(),
    ).toMatch(/levels\.1\.variants : Too big/);
    // Deux niveaux qui se suivent espacés de plus de LEVEL_STEP : la règle du niveau ne tiendrait
    // plus la taille à 25 % de la cible (src/render/crowd.ts, viewDensity).
    const spaced = [first, ...[2, 4].map((factor) => ({ ...second, factor }))];
    expect(issues(HumansSchema, withHumans({ levels: spaced }))).toContain(
      `levels.2.factor : deux niveaux qui se suivent sont espacés d'un facteur ${String(LEVEL_STEP)} au plus`,
    );
    expect(
      issues(HumansSchema, withHumans({ levels: [first, { ...second, factor: 1.6 }] })),
    ).toContain(
      `levels.1.factor : deux niveaux qui se suivent sont espacés d'un facteur ${String(LEVEL_STEP)} au plus`,
    );
    expect(
      issues(HumansSchema, withHumans({ levels: [first, { ...second, factor: LEVEL_STEP }] })),
    ).toEqual([]);
    const animations = humans.animations.map((animation) =>
      animation.id === 'walk' ? { ...animation, shown: false } : animation,
    );
    expect(issues(HumansSchema, withHumans({ animations }))).toContain(
      "animations : l'animation walk est montrée",
    );
  });
});

describe('décor : data/flora.json et data/decor.json (ADR 0017)', () => {
  const data = loadGameData();
  /** Les problèmes qu'un schéma relève, chemin compris ; aucun si la valeur est valide. */
  const issues = (schema: { safeParse: (value: unknown) => SafeResult }, value: unknown) => {
    const parsed = schema.safeParse(value);
    return parsed.success
      ? []
      : (parsed.error?.issues ?? []).map((issue) => `${issue.path.join('.')} : ${issue.message}`);
  };
  interface SafeResult {
    success: boolean;
    error?: { issues: { path: PropertyKey[]; message: string }[] };
  }
  const decor = data.decor;
  const withDecor = (change: object) => ({ ...decor, ...change });
  const look = (id: string) => {
    const entry = data.flora.entries.at(data.flora.indexOf(id) ?? -1);
    if (entry === undefined) throw new Error(`espèce ${id} absente`);
    return entry.look;
  };
  // Une rampe valide : de la lumière à l'ombre profonde, de plus en plus sombre.
  const ramp = ['#444444', '#333333', '#222222', '#111111'];

  it('donne une apparence à chaque espèce, des saisons aux buissons, des fruits à leurs mois', () => {
    for (const entry of data.flora.entries) expect(FloraSchema.parse(entry)).toEqual(entry);
    // Les buissons ont leurs saisons (consigne de 2b.6, C1 D9) : baies, roseaux et saule nain
    // sont caducs, sans grille nue, avec des tons d'hiver.
    for (const id of ['berry-bush', 'reed', 'dwarf-willow']) {
      expect(look(id).phenology, id).toBe('deciduous');
      expect(look(id).bare, id).toBeUndefined();
      expect(look(id).foliage.bare, id).toBeDefined();
    }
    expect(look('berry-bush').fruit?.months).not.toContain(0);
    expect(DecorSchema.parse(decor)).toEqual(decor);
  });

  it('refuse une apparence incomplète ou contradictoire', () => {
    const broadleaf = look('broadleaf');
    const berry = look('berry-bush');
    expect(issues(FloraLookSchema, broadleaf)).toEqual([]);
    expect(issues(FloraLookSchema, berry)).toEqual([]);
    // Une rampe de trois tons.
    expect(issues(FloraLookSchema, { ...broadleaf, wood: ramp.slice(0, 3) }).join()).toMatch(
      /^wood/,
    );
    // Une rampe dans le désordre : l'ombre profonde à la place de la lumière (relecture 2b.6,
    // problème 5), ou deux tons égaux.
    const summer = broadleaf.foliage.summer;
    const reversed = [...summer].reverse();
    expect(
      issues(FloraLookSchema, {
        ...broadleaf,
        foliage: { ...broadleaf.foliage, summer: reversed },
      }),
    ).toContain(
      "foliage.summer : des tons de plus en plus sombres, de la lumière à l'ombre profonde",
    );
    expect(
      issues(FloraLookSchema, { ...broadleaf, wood: [ramp[0], ramp[0], ramp[2], ramp[3]] }),
    ).toContain("wood : des tons de plus en plus sombres, de la lumière à l'ombre profonde");
    expect(
      issues(FloraLookSchema, { ...broadleaf, wood: ['#11111', ...ramp.slice(1)] }).join(),
    ).toMatch(/wood\.0 : couleur #rrggbb/);
    // Une caduque sans automne, sans forme nue ni tons d'hiver.
    expect(issues(FloraLookSchema, { ...broadleaf, foliage: { summer: ramp } })).toContain(
      "foliage.autumn : une espèce caduque a ses tons d'automne",
    );
    const { bare: _bare, ...noBare } = broadleaf;
    expect(issues(FloraLookSchema, noBare)).toContain(
      "bare : une espèce caduque a sa forme nue ou ses tons d'hiver",
    );
    expect(
      issues(FloraLookSchema, { ...noBare, foliage: { ...broadleaf.foliage, bare: ramp } }),
    ).toEqual([]);
    // Une persistante n'a ni automne, ni hiver ; une sèche a ses tons secs, et elle seule.
    const conifer = look('conifer');
    expect(
      issues(FloraLookSchema, { ...conifer, foliage: { ...conifer.foliage, autumn: ramp } }),
    ).toContain("foliage.autumn : seule une espèce caduque a des tons d'automne");
    expect(issues(FloraLookSchema, { ...conifer, bare: 'larch-bare' })).toContain(
      "bare : seule une espèce caduque a une forme ou des tons d'hiver",
    );
    const acacia = look('acacia');
    expect(issues(FloraLookSchema, { ...acacia, foliage: { summer: ramp } })).toContain(
      'foliage.dry : une espèce de saison sèche, et elle seule, a ses tons secs',
    );
    expect(
      issues(FloraLookSchema, { ...conifer, foliage: { ...conifer.foliage, dry: ramp } }),
    ).toContain('foliage.dry : une espèce de saison sèche, et elle seule, a ses tons secs');
    // Un fruit hors des mois de l'année, deux fois le même mois, ou sans mois.
    const fruit = (months: number[]) => ({ ...berry, fruit: { tones: ramp, months } });
    expect(issues(FloraLookSchema, fruit([12])).join()).toMatch(/fruit\.months\.0/);
    expect(issues(FloraLookSchema, fruit([-1])).join()).toMatch(/fruit\.months\.0/);
    expect(issues(FloraLookSchema, fruit([6.5])).join()).toMatch(/fruit\.months\.0/);
    expect(issues(FloraLookSchema, fruit([6, 6]))).toContain('fruit.months : chaque mois une fois');
    expect(issues(FloraLookSchema, fruit([])).join()).toMatch(/fruit\.months/);
    expect(issues(FloraLookSchema, { ...broadleaf, shape: 'tall' }).join()).toMatch(/shape/);
  });

  it('refuse chaque réglage du décor hors de ses bornes', () => {
    expect(issues(DecorSchema, decor)).toEqual([]);
    const refused: [object, RegExp][] = [
      [{ outline: '#13131' }, /^outline : couleur/],
      [{ shadow: { ...decor.shadow, alpha: 1.2 } }, /^shadow\.alpha/],
      [{ shadow: { ...decor.shadow, alpha: -0.1 } }, /^shadow\.alpha/],
      [{ shadow: { ...decor.shadow, sx: 1.6 } }, /^shadow\.sx/],
      [{ shadow: { ...decor.shadow, sy: 1.1 } }, /^shadow\.sy/],
      [{ shadow: { ...decor.shadow, sy: -0.1 } }, /^shadow\.sy/],
      [{ shadow: { ...decor.shadow, method: 'blur' } }, /^shadow\.method/],
      [{ snow: { ...decor.snow, share: 1.5 } }, /^snow\.share/],
      [{ snow: { ...decor.snow, deep: 'blanc' } }, /^snow\.deep/],
      [{ foliage: { ...decor.foliage, bareBelow: -31 } }, /^foliage\.bareBelow/],
      [{ foliage: { ...decor.foliage, autumnBelow: 41 } }, /^foliage\.autumnBelow/],
      [{ foliage: { ...decor.foliage, autumnDrop: -1 } }, /^foliage\.autumnDrop/],
      [{ foliage: { ...decor.foliage, autumnDrop: 21 } }, /^foliage\.autumnDrop/],
      [{ foliage: { ...decor.foliage, bareBelow: 13 } }, /^foliage : l'automne commence/],
      [{ foliage: { ...decor.foliage, dryShare: 1.2 } }, /^foliage\.dryShare/],
      [{ place: { ...decor.place, jitter: 0.46 } }, /^place\.jitter/],
      [{ place: { ...decor.place, jitter: -0.01 } }, /^place\.jitter/],
      [
        { place: { ...decor.place, shrub: { ...decor.place.shrub, side: [0.5, 0.3] } } },
        /^place\.shrub\.side : une étendue/,
      ],
      [
        { place: { ...decor.place, shrub: { ...decor.place.shrub, depth: [0.7, 1.2] } } },
        /^place\.shrub\.depth\.1/,
      ],
      [
        { place: { ...decor.place, rock: { ...decor.place.rock, side: 0.5 } } },
        /^place\.rock\.side/,
      ],
      [{ stone: ramp.slice(0, 3) }, /^stone/],
      [{ stone: [...ramp].reverse() }, /^stone : des tons de plus en plus sombres/],
      [{ rocks: { mountain: { chance: 1.5, form: 'rock' } } }, /^rocks\.mountain\.chance/],
      [{ rocks: { mountain: { chance: 0.5 } } }, /^rocks\.mountain\.form/],
      [{ rocks: { mountain: { chance: 0.5, form: 'Rock' } } }, /^rocks\.mountain\.form/],
      [{ rocks: { mountain: 0.5 } }, /^rocks\.mountain/],
      [{ rocks: { Mountain: { chance: 0.5, form: 'rock' } } }, /^rocks/],
      [{ deposits: { iron: { form: 'ore-rock', ore: ramp.slice(0, 3) } } }, /^deposits\.iron\.ore/],
      [{ deposits: { iron: { form: 'ore-rock', colour: 'red' } } }, /^deposits\.iron/],
      [
        { landUse: { field: { trees: 0, shrubs: 0, rocks: 1 } } },
        /^landUse : l'occupation « none »/,
      ],
      [{ landUse: { none: { trees: 1.2, shrubs: 1, rocks: 1 } } }, /^landUse\.none\.trees/],
      [{ landUse: { none: { trees: 1, shrubs: 1 } } }, /^landUse\.none\.rocks/],
      [{ seasons: true }, /seasons/],
    ];
    for (const [change, expected] of refused) {
      const found = issues(DecorSchema, withDecor(change));
      expect(found.join(' | '), JSON.stringify(change)).toMatch(expected);
    }
  });

  it('borne les poids de la flore des biomes à leurs espèces', () => {
    const taiga = data.biomes.entries.at(data.biomes.indexOf('taiga') ?? -1);
    if (taiga === undefined) throw new Error('taïga absente');
    expect(issues(BiomeSchema, taiga)).toEqual([]);
    const withWeights = (weights: Record<string, number>) => ({
      ...taiga,
      flora: { ...taiga.flora, weights },
    });
    expect(issues(BiomeSchema, withWeights({ palm: 2 }))).toContain(
      'flora.weights : un poids pour une espèce du biome',
    );
    expect(issues(BiomeSchema, withWeights({ conifer: 0 })).join()).toMatch(
      /flora\.weights\.conifer/,
    );
    expect(issues(BiomeSchema, withWeights({ conifer: 101 })).join()).toMatch(
      /flora\.weights\.conifer/,
    );
  });

  it('relève un biome ou un minerai inconnu du décor, et un minerai sans rocher', () => {
    const withSettings = (change: object): GameData => ({ ...data, decor: withDecor(change) });
    const volcano = { chance: 0.5, form: 'rock' };
    expect(checkContent(withSettings({ rocks: { ...decor.rocks, volcano } }))).toEqual([
      'data/decor.json (rochers) : biomes inconnus : volcano',
    ]);
    const { gold: _gold, ...withoutGold } = decor.deposits;
    expect(checkContent(withSettings({ deposits: withoutGold }))).toEqual([
      'data/decor.json (gisements) : minerais sans rocher : gold',
    ]);
    expect(
      checkContent(withSettings({ deposits: { ...decor.deposits, fish: { form: 'rock' } } })),
    ).toEqual(['data/decor.json (gisements) : minerais inconnus : fish']);
  });

  it('borde chaque objet d’un contour plus sombre que ses tons, et lui donne une ombre portée', () => {
    // Relecture 2b.6, problème 5 : la consigne veut un contour sombre et une ombre portée.
    expect(checkContent(data)).toEqual([]);
    const withSettings = (change: object): GameData => ({ ...data, decor: withDecor(change) });
    const [problem] = checkContent(withSettings({ outline: '#ffffff' }));
    expect(problem).toMatch(
      /^data\/decor\.json \(contour\) : pas plus sombre que les tons de stone, /,
    );
    expect(problem).toMatch(/broadleaf\.summer/);
    // Un contour à peine plus clair que l'ombre de la pierre la plus sombre suffit à le refuser.
    const [deep] = checkContent(withSettings({ outline: decor.stone[2] }));
    expect(deep).toMatch(/^data\/decor\.json \(contour\) : pas plus sombre que les tons de stone/);
    // L'ombre portée par défaut existe, se projette, et ne peut qu'assombrir le sol que montre
    // la carte : un noir translucide, ou la trame du contour (problème 2 : « ground » peignait
    // le ton brut de la palette, plus clair que le sol sur 10 à 52 % de ses pixels).
    expect(decor.shadow.method).not.toBe('none');
    expect(['multiply', 'dither']).toContain(decor.shadow.method);
    if (decor.shadow.method === 'multiply') expect(decor.shadow.alpha).toBeGreaterThan(0);
    expect(decor.shadow.sx).toBeGreaterThan(0);
    expect(decor.shadow.sy).toBeGreaterThan(0);
  });
});

describe('gibier : data/fauna.json et les habitats des biomes (ADR 0018)', () => {
  const data = loadGameData();
  interface SafeResult {
    success: boolean;
    error?: { issues: { path: PropertyKey[]; message: string }[] };
  }
  const issues = (schema: { safeParse: (value: unknown) => SafeResult }, value: unknown) => {
    const parsed = schema.safeParse(value);
    return parsed.success
      ? []
      : (parsed.error?.issues ?? []).map((issue) => `${issue.path.join('.')} : ${issue.message}`);
  };
  const species = (id: string) => {
    const entry = data.fauna.entries.at(data.fauna.indexOf(id) ?? -1);
    if (entry === undefined) throw new Error(`espèce ${id} absente`);
    return entry;
  };
  // Une rampe valide : de la lumière à l'ombre profonde, de plus en plus sombre.
  const ramp = ['#444444', '#333333', '#222222', '#111111'];

  it('décrit le cerf, le sanglier et le lièvre, nommés au masculin et au féminin', () => {
    expect(data.fauna.entries.map((entry) => entry.id)).toEqual(['deer', 'boar', 'hare']);
    const catalog = fr as Record<string, unknown>;
    for (const entry of data.fauna.entries) {
      expect(FaunaSpeciesSchema.parse(entry)).toEqual(entry);
      const name = catalog[entry.name] as { masculine?: unknown; feminine?: unknown } | undefined;
      expect(typeof name?.masculine, entry.id).toBe('string');
      expect(typeof name?.feminine, entry.id).toBe('string');
    }
    // Le lièvre vit seul ; cerf et sanglier vont en hardes.
    expect(species('hare').herd).toEqual([1, 1]);
    expect(species('deer').herd[1]).toBeGreaterThan(1);
    expect(FaunaRulesSchema.parse(data.faunaRules)).toEqual(data.faunaRules);
    // Chaque biome de terre qui rend du gibier abrite au moins une espèce, hors des glaces et des
    // sommets ; l'eau n'en abrite aucune.
    for (const biome of data.biomes.entries) {
      const qualities = Object.values(biome.fauna);
      if (biome.family === 'water') expect(qualities, biome.id).toEqual([]);
      else if (!['glacier', 'high-mountain'].includes(biome.id) && biome.forage.game > 0)
        expect(
          qualities.some((quality) => quality > 0),
          biome.id,
        ).toBe(true);
    }
  });

  it('refuse chaque valeur d’une espèce hors de ses bornes', () => {
    const deer = species('deer');
    const hare = species('hare');
    expect(issues(FaunaSpeciesSchema, deer)).toEqual([]);
    const refused: [object, RegExp][] = [
      [{ density: MAX_DENSITY + 0.001 }, /^density/],
      [{ density: -0.001 }, /^density/],
      [{ herd: [0, 4] }, /^herd\.0/],
      [{ herd: [5, 4] }, /^herd : bas ≤ haut/],
      [{ herd: [2, MAX_HERD + 1] }, /^herd\.1/],
      [{ herd: [2, 4.5] }, /^herd\.1/],
      [{ spread: 4.1 }, /^spread/],
      [{ gap: 1.1 }, /^gap/],
      [{ lag: 11 }, /^lag/],
      [{ lag: 1.5 }, /^lag/],
      [{ roam: [0.1, 2] }, /^roam\.0/],
      [{ roam: [3, 2] }, /^roam : bas ≤ haut/],
      [{ range: 0.5 }, /^range/],
      [{ rest: [0, 3] }, /^rest\.0/],
      [{ rest: [2, 61] }, /^rest\.1/],
      [{ pace: { walk: 0.01, run: 1 } }, /^pace\.walk/],
      [{ pace: { walk: 2, run: 1 } }, /^pace\.run : la fuite va au moins au pas/],
      [{ pace: { walk: 1, run: 4.5 } }, /^pace\.run/],
      [{ flee: { ...deer.flee, distance: 6.5 } }, /^flee\.distance/],
      [{ flee: { ...deer.flee, length: 0.2 } }, /^flee\.length/],
      [{ flee: { ...deer.flee, calm: 0 } }, /^flee\.calm/],
      [{ birth: { ...deer.birth, months: [12] } }, /^birth\.months\.0/],
      [{ birth: { ...deer.birth, months: [-1] } }, /^birth\.months\.0/],
      [{ birth: { ...deer.birth, months: [4, 4] } }, /^birth\.months : chaque mois une fois/],
      [{ birth: { ...deer.birth, months: [] } }, /^birth\.months/],
      [{ birth: { ...deer.birth, growth: 2.5 } }, /^birth\.growth/],
      [{ birth: { ...deer.birth, young: 0 } }, /^birth\.young/],
      [{ cull: 1.2 }, /^cull/],
      [{ colonize: -0.1 }, /^colonize/],
      [{ lifespan: 0.5 }, /^lifespan/],
      [{ males: 1.1 }, /^males/],
      [{ look: { ...deer.look, coat: ramp.slice(0, 3) } }, /^look\.coat/],
      [
        { look: { ...deer.look, coat: [...deer.look.coat].reverse() } },
        /^look\.coat : des tons de plus en plus sombres/,
      ],
      [{ look: { ...deer.look, pale: ['#fff', ...ramp.slice(1)] } }, /^look\.pale\.0 : couleur/],
      [{ look: { ...deer.look, young: 0.5 } }, /^look\.young/],
      [{ look: { ...deer.look, maleFrom: undefined } }, /^look\.maleFrom : une forme du mâle/],
      [{ look: { ...hare.look, maleFrom: 2 } }, /^look\.maleFrom : une forme du mâle/],
      [{ look: { ...deer.look, form: 'Deer' } }, /^look\.form/],
      [{ id: 'Deer' }, /^id/],
      [{ name: 'cerf' }, /^name : clé de traduction/],
      [{ speed: 2 }, /speed/],
    ];
    for (const [change, expected] of refused) {
      const found = issues(FaunaSpeciesSchema, { ...deer, ...change });
      expect(found.join(' | '), JSON.stringify(change)).toMatch(expected);
    }
    // Une espèce solitaire se tient sur son but.
    expect(issues(FaunaSpeciesSchema, { ...hare, spread: 0.5 })).toContain(
      'spread : une espèce solitaire se tient sur son but',
    );
  });

  it('refuse chaque règle commune hors de ses bornes', () => {
    const rules = data.faunaRules;
    expect(issues(FaunaRulesSchema, rules)).toEqual([]);
    const refused: [object, RegExp][] = [
      [{ territory: 24 }, /^territory : un diviseur de 128/],
      [{ territory: 4 }, /^territory/],
      [{ territory: 256 }, /^territory/],
      [{ draws: { ...rules.draws, goal: 0 } }, /^draws\.goal/],
      [{ draws: { ...rules.draws, goal: 9 } }, /^draws\.goal/],
      [{ draws: { ...rules.draws, place: 17 } }, /^draws\.place/],
      [{ draws: { ...rules.draws, cell: 0 } }, /^draws\.cell/],
      [{ camps: 6.5 }, /^camps/],
      [{ jitter: 0.6 }, /^jitter/],
      [{ turns: [200] }, /^turns\.0/],
      [{ turns: [10, 20, 30, 40, 50, 60, 70, 80, 90] }, /^turns/],
      [{ neighbors: 0 }, /^neighbors/],
      [{ idle: { ...rules.idle, period: 500 } }, /^idle\.period/],
      [{ idle: { ...rules.idle, flick: rules.idle.graze + 1 } }, /^idle : flick ≤ graze/],
      [{ idle: { ...rules.idle, rise: rules.idle.period + 1 } }, /^idle : flick ≤ graze/],
      [{ idle: { ...rules.idle, chew: 50 } }, /^idle\.chew/],
      [{ cadence: { ...rules.cadence, walk: 0.2 } }, /^cadence\.walk/],
      [{ cadence: { ...rules.cadence, run: 17 } }, /^cadence\.run/],
      [{ fall: { stumble: 900, lie: 800 } }, /^fall : stumble ≤ lie/],
      [{ fall: { stumble: 100, lie: 20_000 } }, /^fall\.lie/],
      [{ outline: '#13131' }, /^outline : couleur/],
      [{ herds: 3 }, /herds/],
    ];
    for (const [change, expected] of refused) {
      const found = issues(FaunaRulesSchema, { ...rules, ...change });
      expect(found.join(' | '), JSON.stringify(change)).toMatch(expected);
    }
  });

  it(`refuse deux espèces du même identifiant, plus de ${String(MAX_FAUNA_SPECIES)} espèces, et un fichier incomplet`, () => {
    const deer = species('deer');
    expect(issues(FaunaListSchema, [deer, deer])).toContain('1.id : identifiant en double : deer');
    const many = Array.from({ length: MAX_FAUNA_SPECIES + 1 }, (_, index) => ({
      ...deer,
      id: `deer-${'abcdefghijklmnopq'.charAt(index)}`,
    }));
    expect(issues(FaunaListSchema, many).join()).toMatch(/16/);
    expect(issues(FaunaListSchema, many.slice(0, MAX_FAUNA_SPECIES))).toEqual([]);
    expect(issues(FaunaFileSchema, { species: data.fauna.entries }).join()).toMatch(/^rules/);
    // Le contour borde le gibier d'un ton plus sombre que la lumière, la base et l'ombre de
    // chaque rampe (relecture 2b.6, problème 5 : un contour blanc passait).
    const file = { rules: data.faunaRules, species: data.fauna.entries };
    expect(issues(FaunaFileSchema, file)).toEqual([]);
    const white = issues(FaunaFileSchema, {
      ...file,
      rules: { ...data.faunaRules, outline: '#ffffff' },
    });
    expect(white).toContain(
      'species.0.look.coat : le contour (rules.outline) plus sombre que la lumière, la base et l’ombre',
    );
    expect(white).toHaveLength(
      data.fauna.entries.reduce((sum, entry) => sum + (entry.look.horn === undefined ? 3 : 4), 0),
    );
    expect(issues(FaunaFileSchema, { rules: data.faunaRules }).join()).toMatch(/^species/);
  });

  it('borne la qualité des habitats, et la demande à chaque biome', () => {
    const steppe = data.biomes.entries.at(data.biomes.indexOf('steppe') ?? -1);
    if (steppe === undefined) throw new Error('steppe absente');
    expect(issues(BiomeSchema, steppe)).toEqual([]);
    expect(issues(BiomeSchema, { ...steppe, fauna: { hare: 1.2 } }).join()).toMatch(/^fauna\.hare/);
    expect(issues(BiomeSchema, { ...steppe, fauna: { Hare: 0.5 } }).join()).toMatch(/^fauna/);
    const { fauna: _fauna, ...withoutFauna } = steppe;
    expect(issues(BiomeSchema, withoutFauna).join()).toMatch(/^fauna/);
  });

  it('relève une espèce inconnue dans un biome, et du gibier là où le biome n’en rend pas', () => {
    const withBiome = (id: string, fauna: Record<string, number>): GameData => {
      const entries = data.biomes.entries.map((biome) =>
        biome.id === id ? { ...biome, fauna } : biome,
      );
      return { ...data, biomes: { entries, indexOf: (key) => data.biomes.indexOf(key) } };
    };
    expect(checkContent(withBiome('steppe', { hare: 1, bison: 0.5 }))).toEqual([
      'data/biomes.json (faune) : inconnus : bison',
    ]);
    expect(checkContent(withBiome('salar', { hare: 0.2 }))).toEqual([
      'data/biomes.json (faune) : salar abrite du gibier sans en rendre',
    ]);
    // Une qualité nulle n'abrite rien : elle passe, même sans gibier.
    expect(checkContent(withBiome('salar', { hare: 0 }))).toEqual([]);
  });
});

describe('saisons : data/seasons.json (ADR 0019)', () => {
  const { seasons } = loadGameData();
  const valid = (variant: unknown) => SeasonsSchema.safeParse(variant).success;
  const top = (change: Partial<Seasons>) => valid({ ...seasons, ...change });
  const snow = (change: Partial<Seasons['snow']>) =>
    valid({ ...seasons, snow: { ...seasons.snow, ...change } });
  const ice = (change: Partial<Seasons['freshIce']>) =>
    valid({ ...seasons, freshIce: { ...seasons.freshIce, ...change } });
  const seaIce = (change: Partial<Seasons['seaIce']>) =>
    valid({ ...seasons, seaIce: { ...seasons.seaIce, ...change } });
  const ramp = (change: Partial<Seasons['snow']['ramp']>) =>
    snow({ ramp: { ...seasons.snow.ramp, ...change } });

  it('donne les rampes de C1 (D9), inchangées depuis la tâche 1.8, et les réglages livrés', () => {
    expect(valid(seasons)).toBe(true);
    expect(seasons.snow.ramp).toEqual({ onset: 0.5, span: 3, full: 1 });
    expect(seasons.freshIce.ramp).toEqual({ onset: -1, span: 3, full: 0.9 });
    expect(seasons.seaIce.ramp).toEqual({ onset: -6, span: 4, full: 0.85 });
    expect(seasons.snow.forest).toBe(0.7);
    expect(seasons).toMatchObject({ step: 3, minTransition: 12, summerDays: 30, calmDays: 12 });
    expect(seasons.snow).toMatchObject({ rainAbove: 2, snowBelow: -1, meltRate: 3, min: 3 });
    expect(seasons.freshIce).toMatchObject({ freezeBelow: -1, min: 1, full: 8, maxLag: 30 });
    expect(seasons.seaIce).toMatchObject({ freezeBelow: -6, min: 2, full: 12, maxLag: 30 });
  });

  it('veut un pas qui divise l’année, des durées et des fenêtres bornées', () => {
    expect(top({ step: 1 })).toBe(true);
    expect(top({ step: 15 })).toBe(true);
    expect(top({ step: 0 })).toBe(false);
    expect(top({ step: 7 })).toBe(false);
    expect(top({ step: 2.5 })).toBe(false);
    expect(top({ step: 18 })).toBe(false);
    expect(top({ minTransition: 0.5 })).toBe(false);
    expect(top({ minTransition: 61 })).toBe(false);
    expect(top({ summerDays: 0 })).toBe(true);
    expect(top({ summerDays: -1 })).toBe(false);
    expect(top({ summerDays: 121 })).toBe(false);
    expect(top({ calmDays: 0 })).toBe(false);
    expect(top({ calmDays: 61 })).toBe(false);
    expect(valid({ ...seasons, extra: 1 })).toBe(false);
  });

  it('refuse une rampe, une neige ou une glace hors de leurs bornes', () => {
    expect(ramp({ onset: -41 })).toBe(false);
    expect(ramp({ onset: 21 })).toBe(false);
    expect(ramp({ span: 0.4 })).toBe(false);
    expect(ramp({ span: 21 })).toBe(false);
    expect(ramp({ full: 0 })).toBe(false);
    expect(ramp({ full: 1.1 })).toBe(false);
    expect(snow({ forest: 1.1 })).toBe(false);
    expect(snow({ forest: -0.1 })).toBe(false);
    expect(snow({ meltRate: 0 })).toBe(false);
    expect(snow({ meltRate: 51 })).toBe(false);
    expect(snow({ rainAbove: 21 })).toBe(false);
    expect(snow({ snowBelow: -21 })).toBe(false);
    expect(snow({ maxLag: -1 })).toBe(false);
    expect(snow({ maxLag: 121 })).toBe(false);
    expect(snow({ maxLag: 2.5 })).toBe(false);
    expect(snow({ maxLag: 120 })).toBe(true);
    expect(snow({ min: -1 })).toBe(false);
    expect(snow({ full: 1001 })).toBe(false);
    expect(ice({ freezeBelow: -31 })).toBe(false);
    expect(ice({ freezeBelow: 11 })).toBe(false);
    expect(ice({ growth: 0 })).toBe(false);
    expect(ice({ thaw: 0 })).toBe(false);
    expect(ice({ thaw: 11 })).toBe(false);
    expect(ice({ stefan: 0 })).toBe(false);
    expect(seaIce({ growth: 11 })).toBe(false);
    expect(seaIce({ stefan: 1001 })).toBe(false);
    expect(seaIce({ maxLag: 121 })).toBe(false);
    expect(valid({ ...seasons, snow: { ...seasons.snow, extra: 1 } })).toBe(false);
    expect(valid({ ...seasons, seaIce: { ...seasons.seaIce, meltRate: 3 } })).toBe(false);
  });

  it('borne la lumière d’hiver : latitudes ordonnées, facteur, mélange et échelle', () => {
    const light = (change: Partial<Seasons['light']>) =>
      valid({ ...seasons, light: { ...seasons.light, ...change } });
    expect(seasons.light).toEqual({
      from: 0.25,
      to: 0.5,
      factor: -0.3,
      toward: '#5d6b86',
      mix: 0.25,
      scale: 0.94,
    });
    expect(light({ from: -0.01 })).toBe(false);
    expect(light({ from: 0.96 })).toBe(false);
    expect(light({ to: 1.01 })).toBe(false);
    expect(light({ to: 0.04 })).toBe(false);
    expect(light({ from: 0.5 })).toBe(false);
    expect(light({ from: 0.49 })).toBe(true);
    expect(light({ factor: -0.96 })).toBe(false);
    expect(light({ factor: 0.91 })).toBe(false);
    expect(light({ toward: '#5D6B86' })).toBe(false);
    expect(light({ mix: -0.01 })).toBe(false);
    expect(light({ mix: 1.01 })).toBe(false);
    expect(light({ scale: 0.49 })).toBe(false);
    expect(light({ scale: 1.51 })).toBe(false);
    expect(valid({ ...seasons, light: { ...seasons.light, extra: 1 } })).toBe(false);
    const { light: _omitted, ...withoutLight } = seasons;
    expect(valid(withoutLight)).toBe(false);
  });

  it('veut la neige seule plus froide que la pluie seule, et un réservoir qui se remplit', () => {
    expect(snow({ snowBelow: 2 })).toBe(false);
    expect(snow({ snowBelow: 1.9 })).toBe(true);
    expect(snow({ min: 20 })).toBe(false);
    expect(snow({ min: 19 })).toBe(true);
    expect(ice({ min: 8 })).toBe(false);
    expect(seaIce({ full: 2 })).toBe(false);
    expect(seaIce({ full: 2.5 })).toBe(true);
  });
});

describe('états de la végétation, dans data/biomes.json (ADR 0019, § 2)', () => {
  const { biomes } = loadGameData();
  const byId = (id: string) => {
    const biome = biomesJson.find((entry) => entry.id === id);
    if (biome === undefined) throw new Error(id);
    return biome;
  };
  /** Le biome `id`, ses états remplacés par `states`. */
  const withStates = (id: string, states: unknown) => {
    const biome = byId(id);
    return { ...biome, seasons: { ...biome.seasons, states } };
  };
  const valid = (biome: unknown) => BiomeSchema.safeParse(biome).success;
  const palette = { shadow: '#5c3c16', base: '#9a6a20', light: '#cfa13a' };

  it('donne à chaque végétation qui en prend ses états, et à elle seule', () => {
    const declared = biomes.entries
      .filter((biome) => biome.seasons.states !== undefined)
      .map((biome) => [
        biome.id,
        Object.keys(biome.seasons.states ?? {})
          .sort()
          .join(' '),
      ]);
    expect(Object.fromEntries(declared)).toEqual({
      'coastal-marsh': 'bare',
      marsh: 'bare',
      bog: 'autumn bare',
      tundra: 'autumn bare',
      'cold-forest': 'autumn bare',
      'cold-steppe': 'bare',
      alpine: 'autumn bare',
      grassland: 'bare',
      steppe: 'bare',
      'temperate-forest': 'autumn bare',
      'temperate-rainforest': 'autumn bare',
      savanna: 'dry',
      'tropical-grassland': 'dry',
    });
    // Chaque biome d'une végétation à états les porte tous ; aucun autre n'en a.
    for (const biome of biomes.entries) {
      expect(Object.keys(biome.seasons.states ?? {}).sort()).toEqual(
        biome.family === 'water' ? [] : [...VEGETATION_STATES[biome.vegetation]].sort(),
      );
    }
  });

  it('refuse un état d’une eau, ou que la végétation du biome ne prend pas', () => {
    expect(valid(withStates('temperate-forest', { autumn: palette, bare: palette }))).toBe(true);
    // L'automne mène au bois nu : un biome qui vire a sa palette nue.
    expect(valid(withStates('temperate-forest', { autumn: palette }))).toBe(false);
    expect(valid(withStates('temperate-forest', { bare: palette }))).toBe(true);
    expect(valid(withStates('lake', { bare: palette }))).toBe(false);
    // Une eau n'a pas d'état, quelle que soit sa végétation.
    expect(valid({ ...withStates('lake', { bare: palette }), vegetation: 'deciduous' })).toBe(
      false,
    );
    expect(valid({ ...withStates('lake', undefined), vegetation: 'deciduous' })).toBe(true);
    expect(valid(withStates('taiga', { autumn: palette, bare: palette }))).toBe(false);
    expect(valid(withStates('desert', { dry: palette }))).toBe(false);
    expect(valid(withStates('grassland', { autumn: palette, bare: palette }))).toBe(false);
    expect(valid(withStates('grassland', { dry: palette }))).toBe(false);
    expect(valid(withStates('savanna', { bare: palette }))).toBe(false);
    expect(valid(withStates('tundra', { dry: palette }))).toBe(false);
    for (const state of SEASON_STATES) {
      const allowed = Object.entries(VEGETATION_STATES)
        .filter(([, states]) => states.includes(state))
        .map(([vegetation]) => vegetation);
      expect(allowed.length).toBeGreaterThan(0);
    }
  });

  it('refuse une palette d’état hors de l’ombre à la lumière, mal écrite ou incomplète', () => {
    const autumn = (change: Partial<typeof palette>) =>
      valid(withStates('cold-forest', { autumn: { ...palette, ...change }, bare: palette }));
    expect(autumn({})).toBe(true);
    expect(autumn({ shadow: '#9a6a20', base: '#5c3c16' })).toBe(false);
    expect(autumn({ light: '#9a6a20' })).toBe(false);
    expect(autumn({ light: '#5c3c16' })).toBe(false);
    expect(autumn({ base: 'roux' })).toBe(false);
    expect(autumn({ base: '#9A6A20' })).toBe(false);
    expect(
      valid(withStates('cold-forest', { autumn: { shadow: '#5c3c16', base: '#9a6a20' } })),
    ).toBe(false);
    expect(valid(withStates('cold-forest', { autumn: { ...palette, deep: '#000000' } }))).toBe(
      false,
    );
    expect(valid(withStates('cold-forest', { winter: palette }))).toBe(false);
  });
});
