/** Contenu du jeu, chargé et validé une fois pour toutes. */
import altitudeLevels from '../../../data/altitude-levels.json';
import biomes from '../../../data/biomes.json';
import { loadCatalog } from './catalog';
import { AltitudeLevelsSchema, BiomesSchema } from './schemas';

export type { Catalog } from './catalog';
export type { AltitudeLevel, Biome } from './schemas';

/** Charge tout le contenu ; lève une DataError s'il est invalide. */
export function loadGameData() {
  return {
    biomes: loadCatalog('data/biomes.json', BiomesSchema, biomes),
    altitudeLevels: loadCatalog('data/altitude-levels.json', AltitudeLevelsSchema, altitudeLevels),
  };
}

export type GameData = ReturnType<typeof loadGameData>;
