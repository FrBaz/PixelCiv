/**
 * Légendes des grilles de rôles (tâche 2b.6 ; AST-04 ; ADR 0017, § 3 et 7) : chaque atlas
 * d'objets du calque commun (le décor, puis le gibier) déclare la sienne, sous un nom que chaque
 * grille rappelle en tête (« # légende decor »). Une grille lue avec la légende d'un autre atlas
 * est refusée, même si ses caractères y avaient un sens (tools/role-grids.ts).
 *
 * Le codage des rôles est celui des humains (src/gen/humans.ts) : 1 le contour, puis
 * RECOLOR + région × 8 + rang, du rang 0 (la lumière) au rang 3 (l'ombre profonde). La
 * réduction par vote des humains (reduceRoles) s'y applique telle quelle, et chaque atlas range
 * ses palettes sur PALETTE_ROLES rôles. Le code d'une région est son rang dans `regions` : deux
 * atlas peuvent donner le même code à des régions différentes, puisque chaque objet a sa palette.
 *
 * N'importe rien : l'extension de Vite qui range les atlas le charge avec la configuration, dont
 * le chargeur veut l'extension .ts à chaque import, que le programme du worker refuse. Le codage
 * des rôles y est donc récrit, et legend.test.ts vérifie qu'il est celui de src/gen/humans.ts.
 */

/** Rôle du contour, et premier rôle recolorable (src/gen/humans.ts, KEPT et RECOLOR). */
const KEPT = 1;
const RECOLOR = 16;
/** Rôle du rang `rank` de la région `code` (src/gen/humans.ts, recolorRole, source 0). */
function recolorRole(code: number, rank: number): number {
  return RECOLOR + code * 8 + rank;
}

/** Une région d'une légende : son identifiant, et les caractères de ses quatre rangs. */
export interface LegendRegion {
  readonly id: string;
  /** Lumière, base, ombre, ombre profonde ; vide pour une région que le build ajoute (l'ombre). */
  readonly chars: string;
}

/** Une légende de grilles de rôles. */
export interface RoleLegend {
  /** Nom de la légende, que chaque grille rappelle en tête : « # légende <nom> ». */
  readonly name: string;
  /** Caractère du transparent, et celui du contour. */
  readonly empty: string;
  readonly outline: string;
  /** Les régions, dans l'ordre de leur code. */
  readonly regions: readonly LegendRegion[];
}

/** Code d'une région d'une légende, ou une erreur si la légende ne la connaît pas. */
export function regionCode(legend: RoleLegend, id: string): number {
  const code = legend.regions.findIndex((region) => region.id === id);
  if (code < 0) throw new Error(`légende ${legend.name} : région ${id} inconnue`);
  return code;
}

/** Rôle du rang `rank` (0 la lumière, 3 l'ombre profonde) de la région `id`. */
export function legendRole(legend: RoleLegend, id: string, rank: number): number {
  return recolorRole(regionCode(legend, id), rank);
}

/** Les rôles des caractères d'une légende : transparent, contour, puis chaque rang peint. */
export function legendRoles(legend: RoleLegend): ReadonlyMap<string, number> {
  const roles = new Map<string, number>([
    [legend.empty, 0],
    [legend.outline, KEPT],
  ]);
  legend.regions.forEach((region, code) => {
    // Des caractères ASCII, un par rang.
    for (let rank = 0; rank < region.chars.length; rank++) {
      const char = region.chars.charAt(rank);
      if (roles.has(char)) throw new Error(`légende ${legend.name} : « ${char} » deux fois`);
      roles.set(char, recolorRole(code, rank));
    }
  });
  return roles;
}

/**
 * Légende du décor (assets/decor/README.md) : le feuillage, le bois, la neige (peinte dans la
 * silhouette, aux tons de ce qu'elle recouvre hors neige), le fruit, la pierre, le minerai,
 * l'ombre portée (ajoutée par le build, deux rangs en damier) et le chaperon (le dessus du
 * contour, au ton du contour hors neige et à celui de la neige sous la neige).
 */
export const DECOR_LEGEND: RoleLegend = {
  name: 'decor',
  empty: '.',
  outline: 'o',
  regions: [
    { id: 'foliage', chars: 'FfgG' },
    { id: 'wood', chars: 'WwvV' },
    { id: 'snow', chars: 'SszZ' },
    { id: 'fruit', chars: 'PpqQ' },
    { id: 'stone', chars: 'RrkK' },
    { id: 'ore', chars: 'UunN' },
    { id: 'shadow', chars: '' },
    { id: 'cap', chars: 'CcjJ' },
  ],
};
