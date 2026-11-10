/** Contenu du jeu, chargé et validé une fois pour toutes. */
import altitudeLevels from '../../../data/altitude-levels.json';
import biomes from '../../../data/biomes.json';
import flora from '../../../data/flora.json';
import resources from '../../../data/resources.json';
import worldgen from '../../../data/worldgen.json';
import { DataError, loadCatalog, loadSettings, type Catalog } from './catalog';
import { AltitudeLevelsSchema, BiomesSchema, FlorasSchema, ResourcesSchema } from './schemas';
import { classifiedBiomes, WorldgenSchema } from './worldgen';

export type { Catalog } from './catalog';
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
  };
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
  if (problems.length > 0) throw new DataError(`contenu incohérent\n${problems.join('\n')}`);
  return data;
}

export type GameData = ReturnType<typeof loadGameData>;
