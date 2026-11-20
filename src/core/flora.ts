/**
 * Densités de la flore (tâche 1.6, MON-10 ; ADR 0017) : la génération du monde les pose dans
 * les couches `trees` et `shrubs` (src/worldgen/resources.ts), et le décor les lit
 * (src/gen/decor.ts). Les deux passent par ces fonctions : un écart recopié ne tiendrait pas.
 */

/** Écart des densités autour de celles du biome, en part (±). */
export const FLORA_VARIATION = 0.35;

/**
 * Code de la densité d'une case, de 0 à 255 : la densité `base` du biome (de 0 à 1), modulée
 * par un bruit de −1 à 1, bornée à [0, 1].
 */
export function floraCode(base: number, noise: number): number {
  if (base <= 0) return 0;
  return Math.round(255 * Math.min(1, Math.max(0, base * (1 + FLORA_VARIATION * noise))));
}

/**
 * Densité qu'une case montre (de 0 à 1) : celle de sa couche, ramenée dans l'étendue que la
 * génération donne à son biome actuel, du bruit −1 au bruit 1. Une case jamais repeinte garde
 * la sienne ; une case repeinte prend la densité la plus proche dans son nouveau biome.
 */
export function floraDensity(stored: number, base: number): number {
  if (base <= 0) return 0;
  const low = floraCode(base, -1);
  const high = floraCode(base, 1);
  return Math.min(high, Math.max(low, stored)) / 255;
}
