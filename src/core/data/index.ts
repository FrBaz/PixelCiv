/** Contenu du jeu, chargé et validé une fois pour toutes. */
import activities from '../../../data/activities.json';
import altitudeLevels from '../../../data/altitude-levels.json';
import appearance from '../../../data/appearance.json';
import biomes from '../../../data/biomes.json';
import cultures from '../../../data/cultures.json';
import decor from '../../../data/decor.json';
import fauna from '../../../data/fauna.json';
import flora from '../../../data/flora.json';
import genetics from '../../../data/genetics.json';
import humans from '../../../data/humans.json';
import nomads from '../../../data/nomads.json';
import resources from '../../../data/resources.json';
import seasons from '../../../data/seasons.json';
import species from '../../../data/species.json';
import worldgen from '../../../data/worldgen.json';
import { ActivitiesFileSchema } from './activities';
import { catalogOf, DataError, loadCatalog, loadSettings, type Catalog } from './catalog';
import { DecorSchema, outlineBelow } from './decor';
import { FaunaFileSchema } from './fauna';
import { BODY_KINDS, HumansSchema, LOOK_BITS } from './humans';
import {
  AppearanceSchema,
  CulturesSchema,
  GeneticsSchema,
  geneRoles,
  NomadsSchema,
  SpeciesListSchema,
} from './people';
import {
  AltitudeLevelsSchema,
  BiomesSchema,
  FlorasSchema,
  ResourcesSchema,
  SeasonsSchema,
} from './schemas';
import { classifiedBiomes, WorldgenSchema } from './worldgen';

export type { Catalog } from './catalog';
export type {
  Allele,
  Appearance,
  Cultures,
  FaceShape,
  GeneRoles,
  Genetics,
  Locus,
  LocusRole,
  Nomads,
  NoseShape,
  Species,
  SpeciesAges,
  Subspecies,
  Trait,
  TraitRole,
} from './people';
export type {
  AltitudeLevel,
  Biome,
  CoverRampSettings,
  Flora,
  IceCover,
  Light,
  Resource,
  Seasons,
  SeasonState,
  SnowCover,
} from './schemas';
export type { Decor, DecorRamp, FloraLook, LandUse, Phenology, ShadowMethod } from './decor';
export type { FaunaRules, FaunaSpecies } from './fauna';
export type { Parameter, ParameterName, Worldgen } from './worldgen';
export type { BodyKind, Humans, Outfit, Piece, Ramp3, Ramp4, Region } from './humans';
export type {
  ActivitiesFile,
  Activity,
  ActivityPlace,
  ActivityRules,
  ActivitySeason,
  Gesture,
} from './activities';

/** Charge tout le contenu ; lève une DataError s'il est invalide. */
export function loadGameData() {
  const faunaFile = loadSettings('data/fauna.json', FaunaFileSchema, fauna);
  const data = {
    biomes: loadCatalog('data/biomes.json', BiomesSchema, biomes),
    altitudeLevels: loadCatalog('data/altitude-levels.json', AltitudeLevelsSchema, altitudeLevels),
    resources: loadCatalog('data/resources.json', ResourcesSchema, resources),
    flora: loadCatalog('data/flora.json', FlorasSchema, flora),
    decor: loadSettings('data/decor.json', DecorSchema, decor),
    /** La neige, la glace et la banquise : leurs rampes et leur inertie (ADR 0019). */
    seasons: loadSettings('data/seasons.json', SeasonsSchema, seasons),
    /** Le gibier (ADR 0018) : ses espèces, puis ses règles communes. */
    fauna: catalogOf(faunaFile.species),
    faunaRules: faunaFile.rules,
    worldgen: loadSettings('data/worldgen.json', WorldgenSchema, worldgen),
    species: loadCatalog('data/species.json', SpeciesListSchema, species),
    genetics: loadSettings('data/genetics.json', GeneticsSchema, genetics),
    cultures: loadSettings('data/cultures.json', CulturesSchema, cultures),
    nomads: loadSettings('data/nomads.json', NomadsSchema, nomads),
    appearance: loadSettings('data/appearance.json', AppearanceSchema, appearance),
    humans: loadSettings('data/humans.json', HumansSchema, humans),
    /** Les activités des individus, leurs gestes et leurs règles (ADR 0021, ADR 0022). */
    activities: loadSettings('data/activities.json', ActivitiesFileSchema, activities),
  };
  const problems = checkContent(data);
  if (problems.length > 0) throw new DataError(`contenu incohérent\n${problems.join('\n')}`);
  return data;
}

export type GameData = ReturnType<typeof loadGameData>;

/**
 * Cohérence entre les fichiers de contenu, une fois chacun validé : une entrée par
 * problème, aucune si tout va bien.
 */
export function checkContent(data: GameData): string[] {
  // Les fichiers se renvoient les uns aux autres par identifiants : tous doivent exister.
  const problems: string[] = [];
  const check = (file: string, ids: Iterable<string>, catalog: Catalog<{ id: string }>) => {
    const unknown = [...new Set(ids)].filter((id) => catalog.indexOf(id) === undefined);
    if (unknown.length > 0) problems.push(`${file} : inconnus : ${unknown.join(', ')}`);
  };
  check('data/worldgen.json (biomes)', classifiedBiomes(data.worldgen.classification), data.biomes);
  // Les eaux d'une activité au bord de l'eau sont des biomes de l'eau : la rive d'une case de terre
  // ne vient que de sa rivière (`water.river`).
  for (const activity of data.activities.activities) {
    const waters = activity.water?.biomes ?? [];
    check(`data/activities.json (eaux de ${activity.id})`, waters, data.biomes);
    const dry = waters.filter((id) => {
      const index = data.biomes.indexOf(id);
      return index !== undefined && data.biomes.entries[index]?.family !== 'water';
    });
    if (dry.length > 0) {
      problems.push(
        `data/activities.json : eaux de ${activity.id} hors de la famille de l'eau : ${dry.join(', ')}`,
      );
    }
  }
  // Chaque segment d'un geste nomme une animation des planches, et des images qu'elle a.
  for (const gesture of data.activities.gestures) {
    for (const segment of gesture.segments) {
      const animation = data.humans.animations.find((entry) => entry.id === segment.animation);
      if (animation === undefined) {
        problems.push(
          `data/activities.json : geste ${gesture.id} : animation ${segment.animation} inconnue`,
        );
      } else if ((segment.frames ?? []).some((frame) => frame >= animation.frames)) {
        problems.push(
          `data/activities.json : geste ${gesture.id} : image hors de l'animation ${segment.animation}`,
        );
      }
    }
  }
  check(
    'data/biomes.json (ressources)',
    data.biomes.entries.flatMap((biome) => biome.resources),
    data.resources,
  );
  check(
    'data/biomes.json (flore)',
    data.biomes.entries.flatMap((biome) => biome.flora.species),
    data.flora,
  );
  check(
    'data/resources.json (biomes)',
    data.resources.entries.flatMap((resource) => resource.deposit?.biomes ?? []),
    data.biomes,
  );
  // La flore d'un biome s'accorde à ses densités : des arbres demandent une espèce
  // d'arbre, des buissons une espèce de buisson, et une espèce listée sa densité.
  for (const biome of data.biomes.entries) {
    const kinds = new Set(
      biome.flora.species.map(
        (species) => data.flora.entries.at(data.flora.indexOf(species) ?? -1)?.kind,
      ),
    );
    for (const [kind, density] of [
      ['tree', biome.flora.trees],
      ['shrub', biome.flora.shrubs],
    ] as const) {
      if (density > 0 && !kinds.has(kind))
        problems.push(`data/biomes.json (flore) : ${biome.id} a des ${kind} sans espèce`);
      if (density === 0 && kinds.has(kind))
        problems.push(`data/biomes.json (flore) : ${biome.id} liste des ${kind} sans densité`);
    }
  }
  // Les palettes d'état d'un biome sont celles des états de sa végétation (`vegetation` de
  // data/seasons.json ; ADR 0019, § 2) : une prairie ne sèche que si sa végétation sèche.
  for (const biome of data.biomes.entries) {
    const allowed = data.seasons.vegetation[biome.vegetation];
    for (const state of Object.keys(biome.seasons.states ?? {})) {
      if (biome.family !== 'water' && !allowed.some((entry) => entry === state))
        problems.push(
          `data/biomes.json (états) : la végétation « ${biome.vegetation} » de ${biome.id} ne prend pas l'état « ${state} » (data/seasons.json, vegetation)`,
        );
    }
  }
  problems.push(...checkDecor(data));
  problems.push(...checkFauna(data));
  // Espèces : leurs biomes existent, et leur apparence décrit chaque locus et chaque
  // trait de data/genetics.json, avec des allèles connus et au moins un de fréquence
  // non nulle.
  for (const entry of data.species.entries) {
    for (const subspecies of entry.subspecies) {
      const where = `data/species.json (${entry.id}, ${subspecies.id})`;
      check(`${where} (biomes)`, subspecies.biomes, data.biomes);
      const { alleles, traits } = subspecies.appearance;
      for (const locus of data.genetics.loci) {
        if (!Object.hasOwn(alleles, locus.id)) {
          problems.push(`${where} : pas de fréquences pour le locus ${locus.id}`);
          continue;
        }
        const weights = alleles[locus.id] ?? {};
        const unknown = Object.keys(weights).filter(
          (id) => !locus.alleles.some((allele) => allele.id === id),
        );
        if (unknown.length > 0)
          problems.push(`${where} : allèles inconnus : ${unknown.join(', ')}`);
        if (!locus.alleles.some((allele) => (weights[allele.id] ?? 0) > 0)) {
          problems.push(`${where} : aucun allèle du locus ${locus.id} n'a de fréquence`);
        }
      }
      const loci = Object.keys(alleles).filter(
        (id) => !data.genetics.loci.some((locus) => locus.id === id),
      );
      if (loci.length > 0) problems.push(`${where} : locus inconnus : ${loci.join(', ')}`);
      for (const trait of data.genetics.traits) {
        if (!Object.hasOwn(traits, trait.id))
          problems.push(`${where} : pas de répartition du trait ${trait.id}`);
      }
      const unknownTraits = Object.keys(traits).filter(
        (id) => !data.genetics.traits.some((trait) => trait.id === id),
      );
      if (unknownTraits.length > 0)
        problems.push(`${where} : traits inconnus : ${unknownTraits.join(', ')}`);
    }
  }
  problems.push(...checkAppearance(data));
  // Les couches du monde rangent le biome et le gisement (indice + 1) sur un octet.
  if (data.biomes.entries.length > 256)
    problems.push('data/biomes.json : 256 biomes au plus (couche biome sur un octet)');
  if (data.resources.entries.length > 255)
    problems.push(
      'data/resources.json : 255 ressources au plus (couche des gisements sur un octet)',
    );
  return problems;
}

/**
 * Cohérence du décor (ADR 0017) : les biomes des rochers épars existent ; chaque minerai de
 * data/resources.json a l'aspect de son rocher, et data/decor.json n'en décrit pas d'autre.
 * Les formes que nomment le décor et la flore ont leurs grilles, ce que vérifie le build de
 * l'atlas du décor (tools/decor-atlas.ts).
 */
export function checkDecor(data: GameData): string[] {
  const problems: string[] = [];
  const { decor } = data;
  const unknownBiomes = Object.keys(decor.rocks).filter(
    (id) => data.biomes.indexOf(id) === undefined,
  );
  if (unknownBiomes.length > 0) {
    problems.push(`data/decor.json (rochers) : biomes inconnus : ${unknownBiomes.join(', ')}`);
  }
  const minerals = data.resources.entries.filter((resource) => resource.deposit !== undefined);
  const missing = minerals.filter((resource) => !Object.hasOwn(decor.deposits, resource.id));
  if (missing.length > 0) {
    problems.push(
      `data/decor.json (gisements) : minerais sans rocher : ${missing.map((m) => m.id).join(', ')}`,
    );
  }
  const extra = Object.keys(decor.deposits).filter(
    (id) => !minerals.some((resource) => resource.id === id),
  );
  if (extra.length > 0) {
    problems.push(`data/decor.json (gisements) : minerais inconnus : ${extra.join(', ')}`);
  }
  // Le contour, plus sombre que chaque ton que prend un objet (consigne : un contour sombre) :
  // flore, pierre, minerais et neige.
  const ramps: [string, readonly string[]][] = [['stone', decor.stone]];
  for (const entry of data.flora.entries) {
    const { foliage, wood, fruit } = entry.look;
    for (const [state, ramp] of Object.entries(foliage)) ramps.push([`${entry.id}.${state}`, ramp]);
    ramps.push([`${entry.id}.wood`, wood]);
    if (fruit !== undefined) ramps.push([`${entry.id}.fruit`, fruit.tones]);
  }
  for (const [id, deposit] of Object.entries(decor.deposits)) {
    if (deposit.ore !== undefined) ramps.push([`${id}.ore`, deposit.ore]);
  }
  for (const biome of data.biomes.entries) {
    const cover = biome.seasons.palette;
    if (cover !== undefined) {
      ramps.push([`${biome.id}.snow`, [cover.light, cover.base, cover.shadow, decor.snow.deep]]);
    }
  }
  const lighter = ramps.filter(([, ramp]) => !outlineBelow(decor.outline, ramp));
  if (lighter.length > 0) {
    problems.push(
      `data/decor.json (contour) : pas plus sombre que les tons de ${lighter.map(([id]) => id).join(', ')}`,
    );
  }
  return problems;
}

/**
 * Cohérence du gibier (ADR 0018) : les habitats des biomes ne nomment que des espèces de
 * data/fauna.json, et aucun gibier ne vit là où le biome n'en rend pas (`forage.game` nul : l'eau,
 * le salar), puisque ses effectifs se tiennent au stock de gibier de ses cases. Les formes que
 * nomment les espèces ont leurs grilles, ce que vérifie le build de l'atlas (tools/fauna-atlas.ts).
 */
export function checkFauna(data: GameData): string[] {
  const problems: string[] = [];
  const unknown = new Set<string>();
  for (const biome of data.biomes.entries) {
    for (const [id, quality] of Object.entries(biome.fauna)) {
      if (data.fauna.indexOf(id) === undefined) unknown.add(id);
      if (quality > 0 && biome.forage.game === 0) {
        problems.push(`data/biomes.json (faune) : ${biome.id} abrite du gibier sans en rendre`);
      }
    }
  }
  if (unknown.size > 0) {
    problems.push(`data/biomes.json (faune) : inconnus : ${[...unknown].join(', ')}`);
  }
  return problems;
}

/**
 * Apparences possibles d'un humain au plus (render/people.ts) : la texture des palettes en range
 * huit par ligne, sur 2 048 lignes, ce que garantit WebGL 2.
 */
export const MAX_LOOKS = 8 * 2048;

/**
 * Cohérence des humains des planches (ADR 0016) : les tenues ne couvrent que des régions de
 * data/humans.json ; chaque allèle des cheveux a ses tons, et rien d'autre n'en a ; les allèles
 * tiennent dans les bits de l'apparence (LOOK_BITS) ; et toutes les apparences possibles dans
 * la texture des palettes (MAX_LOOKS).
 */
export function checkAppearance(data: GameData): string[] {
  const problems: string[] = [];
  const { appearance, humans, genetics } = data;
  const regions = new Set(humans.regions.map((region) => region.id));
  for (const outfit of appearance.outfits) {
    for (const body of BODY_KINDS) {
      for (const piece of outfit[body]) {
        const unknown = piece.regions.filter((region) => !regions.has(region));
        if (unknown.length > 0) {
          problems.push(
            `data/appearance.json (${outfit.id}, ${body}) : régions inconnues : ${unknown.join(', ')}`,
          );
        }
      }
    }
  }
  const hair = genetics.loci.at(geneRoles(genetics).loci.hair)?.alleles ?? [];
  const missing = hair.filter((allele) => !Object.hasOwn(appearance.hair, allele.id));
  if (missing.length > 0) {
    problems.push(
      `data/appearance.json (hair) : allèles sans tons : ${missing.map((a) => a.id).join(', ')}`,
    );
  }
  const extra = Object.keys(appearance.hair).filter((id) => !hair.some((a) => a.id === id));
  if (extra.length > 0) {
    problems.push(`data/appearance.json (hair) : allèles inconnus : ${extra.join(', ')}`);
  }
  if (hair.length > 1 << LOOK_BITS.hair) {
    problems.push(
      `data/genetics.json : ${String(1 << LOOK_BITS.hair)} allèles des cheveux au plus`,
    );
  }
  const looks =
    appearance.skinPalettes.length *
    Math.max(1, hair.length) *
    (appearance.greying.length + 1) *
    appearance.outfits.length *
    BODY_KINDS.length;
  if (looks > MAX_LOOKS) {
    problems.push(
      `data/appearance.json : ${String(looks)} apparences possibles, ${String(MAX_LOOKS)} au plus`,
    );
  }
  return problems;
}
