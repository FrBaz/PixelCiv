/** Contenu du jeu, chargé et validé une fois pour toutes. */
import altitudeLevels from '../../../data/altitude-levels.json';
import biomes from '../../../data/biomes.json';
import worldgen from '../../../data/worldgen.json';
import { loadCatalog, loadSettings } from './catalog';
import { AltitudeLevelsSchema, BiomesSchema } from './schemas';
import { WorldgenSchema } from './worldgen';

export type { Catalog } from './catalog';
export type { AltitudeLevel, Biome } from './schemas';
export type { Parameter, ParameterName, Worldgen } from './worldgen';

/** Charge tout le contenu ; lève une DataError s'il est invalide. */
export function loadGameData() {
  return {
    biomes: loadCatalog('data/biomes.json', BiomesSchema, biomes),
    altitudeLevels: loadCatalog('data/altitude-levels.json', AltitudeLevelsSchema, altitudeLevels),
    worldgen: loadSettings('data/worldgen.json', WorldgenSchema, worldgen),
  };
}

export type GameData = ReturnType<typeof loadGameData>;
