/**
 * Tons d'un individu (tâche 2b.5, ADR 0016 ; REN-09) : sa palette de peau, ses cheveux au cran
 * de leur grisonnement, sa tenue et ses tissus, tirés des palettes de l'auteur que range
 * data/appearance.json. La carte (src/render/humans.ts) et le portrait (src/ui/Portrait.tsx) les
 * prennent ici, pour s'accorder : même palette de peau au même code de teint, mêmes cheveux,
 * même premier tissu. Aucune couleur n'est calculée : chaque ton est un ton des données.
 */
import type { Appearance, BodyKind, Piece, Ramp4 } from '../core/data';
import { GREY_LEVELS } from '../core/visual';

export { skinCode } from '../core/visual';

/** Palette de peau d'un code de teint (0 à 15) : la première dont `upTo` l'atteint. */
export function skinPaletteOf(appearance: Appearance, skin: number): number {
  const index = appearance.skinPalettes.findIndex((palette) => skin <= palette.upTo);
  return index < 0 ? appearance.skinPalettes.length - 1 : index;
}

/** Les quatre tons d'une palette de peau, par rang. */
export function skinTones(appearance: Appearance, palette: number): Ramp4 | undefined {
  return appearance.skinPalettes.at(palette)?.tones;
}

/**
 * Tons des cheveux de l'allèle `allele` au cran de gris `grey` (0 à GREY_LEVELS − 1), un par
 * rang, de la lumière à l'ombre profonde : la rampe de l'allèle a trois tons, l'ombre profonde
 * prend le dernier ; chaque cran de data/appearance.json (greying) remplace ses rangs par ceux
 * d'une rampe de gris. Undefined pour un allèle sans tons, ce que checkContent empêche.
 */
export function hairTones(
  appearance: Appearance,
  allele: string,
  grey: number,
): readonly string[] | undefined {
  if (!Object.hasOwn(appearance.hair, allele)) return undefined;
  const ramp = appearance.hair[allele];
  const tones = [0, 1, 2, 3].map((rank) => ramp[Math.min(rank, 2)] ?? ramp[2]);
  const step = appearance.greying.at(Math.min(grey, GREY_LEVELS - 1) - 1);
  if (grey <= 0 || step === undefined || !Object.hasOwn(appearance.greyRamps, step.ramp)) {
    return tones;
  }
  const greys = appearance.greyRamps[step.ramp];
  for (const rank of step.ranks) tones[rank] = greys[Math.min(rank, 2)] ?? greys[2];
  return tones;
}

/** Tenue d'une culture : les cultures embryonnaires prennent à tour de rôle celles des données. */
export function cultureOutfit(appearance: Appearance, culture: number): number {
  const ids = appearance.cultureOutfits;
  const id = ids[(Math.max(1, culture) - 1) % ids.length];
  return Math.max(
    0,
    appearance.outfits.findIndex((outfit) => outfit.id === id),
  );
}

/** Les pièces d'une tenue pour une sorte de corps. */
export function outfitPieces(
  appearance: Appearance,
  outfit: number,
  body: BodyKind,
): readonly Piece[] {
  return appearance.outfits.at(outfit)?.[body] ?? [];
}

/**
 * Le tissu que porte vraiment, sur la palette de peau `palette`, qui porte le tissu `fabric` :
 * lui-même, ou son tissu de rechange sur cette peau (onSkin), dont il ne se détacherait pas.
 */
export function wornFabric(appearance: Appearance, fabric: string, palette: number): string {
  const entry = appearance.fabrics.find((candidate) => candidate.id === fabric);
  const skin = appearance.skinPalettes.at(palette)?.id ?? '';
  const spare =
    entry?.onSkin !== undefined && Object.hasOwn(entry.onSkin, skin)
      ? entry.onSkin[skin]
      : undefined;
  return spare !== undefined && appearance.fabrics.some((candidate) => candidate.id === spare)
    ? spare
    : fabric;
}

/** Les tons d'un tissu sur la palette de peau `palette` : ceux du tissu porté (wornFabric). */
export function fabricTones(
  appearance: Appearance,
  fabric: string,
  palette: number,
): Ramp4 | undefined {
  const worn = wornFabric(appearance, fabric, palette);
  return appearance.fabrics.find((candidate) => candidate.id === worn)?.tones;
}

/**
 * Le tissu qui porte la couleur d'une tenue : celui de sa première pièce, pour une femme, sur la
 * palette de peau `palette`, ou tel quel sans palette. Le portrait le prend, jusqu'à 2b.9, sur sa
 * palette de peau, pour l'habit ; la bannière d'un groupe, tel que le porte le plus grand nombre
 * de ses membres (bannerFabric).
 */
export function outfitColor(
  appearance: Appearance,
  outfit: number,
  body: BodyKind,
  palette?: number,
): Ramp4 | undefined {
  const fabric = outfitPieces(appearance, outfit, body).at(0)?.fabric;
  if (fabric === undefined) return undefined;
  if (palette === undefined) return appearance.fabrics.find((entry) => entry.id === fabric)?.tones;
  return fabricTones(appearance, fabric, palette);
}

/**
 * Le tissu de la bannière d'un groupe de la culture `culture`, dont les membres ont pour codes de
 * teint `skins` (de 0 à 15) : le premier tissu de sa tenue (outfitColor), tel que le porte chacun
 * sur sa palette de peau, rechange compris (wornFabric) ; celui que porte le plus grand nombre.
 * À égalité, et sans membre, celui de la culture. La couleur de loin est ainsi celle que porte de
 * près le plus grand nombre (ADR 0016, § 3).
 */
export function bannerFabric(
  appearance: Appearance,
  culture: number,
  skins: Iterable<number>,
): string {
  const fabric =
    outfitPieces(appearance, cultureOutfit(appearance, culture), 'female').at(0)?.fabric ?? '';
  const counts = new Map<string, number>([[fabric, 0]]);
  for (const skin of skins) {
    const worn = wornFabric(appearance, fabric, skinPaletteOf(appearance, skin));
    counts.set(worn, (counts.get(worn) ?? 0) + 1);
  }
  let best = fabric;
  for (const [id, count] of counts) {
    if (count > (counts.get(best) ?? 0)) best = id;
  }
  return best;
}
