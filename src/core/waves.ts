/**
 * Bornes de la mer animée (tâche 2b.4, ADR 0015), que partagent le schéma des données
 * (`waves` dans data/biomes.json) et le rendu (src/render/waves.ts, qui en tire le shader et
 * son miroir) : le schéma refuse un réglage que le shader ne saurait pas dessiner, et une
 * crête ne sort jamais de son bloc.
 */

/** Nombre maximal de biomes animés : la table d'uniformes du shader a autant de places. */
export const MAX_WAVE_BIOMES = 4;

/** Côté d'un bloc du cadre des crêtes et de la grille des clapots, en pixels de carte. */
export const WAVE_BLOCK = 16;

/** Départ d'une crête dans son bloc, en pixels : x0 < CREST_START.x, y0 < CREST_START.y. */
export const CREST_START = { x: 10, y: 12 } as const;

/** Épaisseur maximale d'une crête, en pixels : le shader en trace une ou deux diagonales. */
export const MAX_CREST_THICKNESS = 2;

/**
 * Longueur maximale d'une crête, en pixels. Une crête « \ » de longueur L et d'épaisseur e,
 * partie de (x0, y0), finit en (x0 + L + e − 2, y0 + L − 1) : depuis le départ le plus
 * lointain, à l'épaisseur maximale, elle tient dans son bloc tant que L ne dépasse ni
 * WAVE_BLOCK − CREST_START.y + 1, ni WAVE_BLOCK − CREST_START.x + 2 − MAX_CREST_THICKNESS.
 */
export const MAX_CREST_LENGTH = Math.min(
  WAVE_BLOCK - CREST_START.y + 1,
  WAVE_BLOCK - CREST_START.x + 2 - MAX_CREST_THICKNESS,
);

/** Tons de la palette d'un biome qu'une crête peut prendre : jamais l'ombre. */
export const CREST_TONES = ['base', 'light'] as const;

/**
 * Ton cuit d'une couleur d'eau #rrggbb, en entier 0xrrggbb : la cuisson en écrit les bits
 * faibles du rouge et du vert à 0 (eau, pas de ruisseau ; ADR 0010). Le shader reconnaît le
 * biome d'un pixel d'eau à ce ton : deux eaux ne doivent pas en partager un.
 */
export function bakedWaterTone(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  return value & 0xfefeff;
}
