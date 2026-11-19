import { describe, expect, it } from 'vitest';
import altitudeLevelsJson from '../../../data/altitude-levels.json';
import biomesJson from '../../../data/biomes.json';
import fr from '../../i18n/fr.json';
import { DataError, loadCatalog } from './catalog';
import { checkContent, loadGameData, type GameData, type Genetics, type Species } from './index';
import {
  FACE_BOUNDS,
  GeneticsSchema,
  geneRoles,
  NomadsSchema,
  NOSE_BOUNDS,
  SpeciesSchema,
  type Nomads,
} from './people';
import { AltitudeLevelsSchema, BiomesSchema } from './schemas';
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

  it('refuse un allèle de visage ou de nez sans forme, et des cheveux sans couleur', () => {
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
    const colorless = withLocus('hair', (locus) => ({
      ...locus,
      alleles: locus.alleles.map(({ color: _color, ...allele }) => allele),
    }));
    expect(problems(colorless)).toHaveLength(4);
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
