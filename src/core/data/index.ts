/** Contenu du jeu, chargé et validé une fois pour toutes. */
import biomes from '../../../data/biomes.json';
import { loadCatalog } from './catalog';
import { BiomesSchema } from './schemas';

export type { Catalog } from './catalog';
export type { Biome } from './schemas';

/** Charge tout le contenu ; lève une DataError s'il est invalide. */
export function loadGameData() {
  return {
    biomes: loadCatalog('data/biomes.json', BiomesSchema, biomes),
  };
}

export type GameData = ReturnType<typeof loadGameData>;
