/** Contenu du jeu, chargé et validé une fois pour toutes. */
import altitudeLevels from '../../../data/altitude-levels.json';
import biomes from '../../../data/biomes.json';
import cultures from '../../../data/cultures.json';
import flora from '../../../data/flora.json';
import genetics from '../../../data/genetics.json';
import nomads from '../../../data/nomads.json';
import resources from '../../../data/resources.json';
import species from '../../../data/species.json';
import worldgen from '../../../data/worldgen.json';
import { DataError, loadCatalog, loadSettings, type Catalog } from './catalog';
import { CulturesSchema, GeneticsSchema, NomadsSchema, SpeciesListSchema } from './people';
import { AltitudeLevelsSchema, BiomesSchema, FlorasSchema, ResourcesSchema } from './schemas';
import { classifiedBiomes, WorldgenSchema } from './worldgen';

export type { Catalog } from './catalog';
export type { Cultures, Genetics, Locus, Nomads, Species, Subspecies, Trait } from './people';
export type { AltitudeLevel, Biome, Flora, Resource } from './schemas';
export type { Parameter, ParameterName, Worldgen } from './worldgen';

/** Charge tout le contenu ; lève une DataError s'il est invalide. */
export function loadGameData() {
  const data = {
    biomes: loadCatalog('data/biomes.json', BiomesSchema, biomes),
    altitudeLevels: loadCatalog('data/altitude-levels.json', AltitudeLevelsSchema, altitudeLevels),
    resources: loadCatalog('data/resources.json', ResourcesSchema, resources),
    flora: loadCatalog('data/flora.json', FlorasSchema, flora),
    worldgen: loadSettings('data/worldgen.json', WorldgenSchema, worldgen),
    species: loadCatalog('data/species.json', SpeciesListSchema, species),
    genetics: loadSettings('data/genetics.json', GeneticsSchema, genetics),
    cultures: loadSettings('data/cultures.json', CulturesSchema, cultures),
    nomads: loadSettings('data/nomads.json', NomadsSchema, nomads),
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
  // Les couches du monde rangent le biome et le gisement (indice + 1) sur un octet.
  if (data.biomes.entries.length > 256)
    problems.push('data/biomes.json : 256 biomes au plus (couche biome sur un octet)');
  if (data.resources.entries.length > 255)
    problems.push(
      'data/resources.json : 255 ressources au plus (couche des gisements sur un octet)',
    );
  return problems;
}
