/** Contenu du jeu, chargé et validé une fois pour toutes. */
import altitudeLevels from '../../../data/altitude-levels.json';
import biomes from '../../../data/biomes.json';
import worldgen from '../../../data/worldgen.json';
import { DataError, loadCatalog, loadSettings } from './catalog';
import { AltitudeLevelsSchema, BiomesSchema } from './schemas';
import { classifiedBiomes, WorldgenSchema } from './worldgen';

export type { Catalog } from './catalog';
export type { AltitudeLevel, Biome } from './schemas';
export type { Parameter, ParameterName, Worldgen } from './worldgen';

/** Charge tout le contenu ; lève une DataError s'il est invalide. */
export function loadGameData() {
  const data = {
    biomes: loadCatalog('data/biomes.json', BiomesSchema, biomes),
    altitudeLevels: loadCatalog('data/altitude-levels.json', AltitudeLevelsSchema, altitudeLevels),
    worldgen: loadSettings('data/worldgen.json', WorldgenSchema, worldgen),
  };
  // Les règles de classement ne nomment que des biomes connus.
  const unknown = classifiedBiomes(data.worldgen.classification).filter(
    (id) => data.biomes.indexOf(id) === undefined,
  );
  if (unknown.length > 0) {
    throw new DataError(`data/worldgen.json invalide\nbiomes inconnus : ${unknown.join(', ')}`);
  }
  return data;
}

export type GameData = ReturnType<typeof loadGameData>;
