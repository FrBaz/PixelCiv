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
 * Les tons d'un tissu sur la palette de peau `palette` : les siens, ou ceux de son tissu de
 * rechange sur cette peau (onSkin), dont il ne se détacherait pas.
 */
export function fabricTones(
  appearance: Appearance,
  fabric: string,
  palette: number,
): Ramp4 | undefined {
  const entry = appearance.fabrics.find((candidate) => candidate.id === fabric);
  const skin = appearance.skinPalettes.at(palette)?.id ?? '';
  const spare =
    entry?.onSkin !== undefined && Object.hasOwn(entry.onSkin, skin)
      ? entry.onSkin[skin]
      : undefined;
  if (spare === undefined) return entry?.tones;
  return appearance.fabrics.find((candidate) => candidate.id === spare)?.tones ?? entry?.tones;
}

/**
 * Le tissu qui porte la couleur d'une tenue : celui de sa première pièce, pour une femme, sur la
 * palette de peau `palette`, ou tel quel sans palette. La bannière d'un groupe le prend, et le
 * portrait, jusqu'à 2b.9, pour l'habit.
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
