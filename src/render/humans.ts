/**
 * Humains des planches à l'exécution (tâche 2b.5, ADR 0016) : l'atlas de rôles rangé au build
 * (tools/human-atlas.ts), le motif de chaque corps, niveau, variante, animation et image, et
 * la palette de chaque apparence. La recoloration se fait rang pour rang : un ton de peau ou de
 * sous-vêtement de la région r devient le ton de même rang du tissu qui couvre r, des cheveux
 * sur le crâne, ou de la palette de peau de l'individu ; un ton gardé (contour, yeux, lèvres,
 * paupières) reste celui de la planche. Aucune couleur n'est calculée : chaque couleur vient
 * d'une planche ou d'une rampe des données (src/render/looks.ts). Le calque des individus range
 * ces palettes dans une texture que lit son shader (src/render/people.ts).
 */
import atlas from 'virtual:human-atlas';
import type { Appearance } from '../core/data';
import { BODY_KINDS, LOOK_BITS, PALETTE_ROLES, type BodyKind } from '../core/data/humans';
import { AGE_CODE, decodeVisual } from '../core/visual';
import { KEPT, RECOLOR, recolorRole } from '../gen/humans';
import { parseColor, type Rgb } from './bake';
import type { HumanTable } from './crowd';
import {
  cultureOutfit,
  fabricTones,
  hairTones,
  outfitPieces,
  skinPaletteOf,
  skinTones,
} from './looks';

export { atlas as humanAtlas };

/** Rôles de l'atlas, un octet par pixel, décodés une fois. */
export const ATLAS_ROLES: Uint8Array = (() => {
  const text = atob(atlas.roles);
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
  return bytes;
})();

/** Variantes au plus par niveau (tools/human-atlas.ts, ADR 0014). */
const VARIANTS = 3;

/** Rang de chaque animation de l'atlas. */
export const ANIMATION: Readonly<Partial<Record<string, number>>> = Object.fromEntries(
  atlas.animations.map((a, index) => [a.id, index]),
);

/** Corps de l'atlas : femme, homme, puis les tailles d'enfant, puis le nourrisson. */
export const BODY_FEMALE = 0;
export const BODY_MALE = 1;
const CHILDREN = atlas.kinds.flatMap((kind, index) => (kind === 'child' ? [index] : []));
const BABIES = atlas.kinds.flatMap((kind, index) => (kind === 'baby' ? [index] : []));

/** Rangées de l'adulte de référence de chaque niveau, du plus fin au plus grossier. */
export const LEVEL_ROWS = atlas.levels.map((level) => level.rows) as unknown as readonly [
  number,
  ...number[],
];

/** Nombre de motifs de l'atlas. */
export const MOTIF_COUNT = atlas.motifs.length / 6;

/** Sorte de corps d'un corps de l'atlas, pour les tenues. */
export function bodyKind(body: number): BodyKind {
  return atlas.kinds[body] ?? 'male';
}

/** Code d'une sorte de corps (BODY_KINDS), dans l'apparence d'une texture. */
export function bodyCode(kind: BodyKind): number {
  return BODY_KINDS.indexOf(kind);
}

/**
 * Corps d'un individu : son sexe pour l'adulte et l'aîné ; pour l'enfant, la taille d'enfant
 * la plus proche de sa stature (`ratio`, sa stature sur celle de l'adulte de référence) ; le
 * nourrisson n'en a qu'une.
 */
export function bodyOf(sex: number, age: number, ratio: number): number {
  if (age === AGE_CODE.baby && BABIES.length > 0) return BABIES[0] ?? BODY_MALE;
  if (age === AGE_CODE.child && CHILDREN.length > 0) {
    const rows = ratio * LEVEL_ROWS[0];
    let best = CHILDREN[0] ?? BODY_MALE;
    let gap = Number.POSITIVE_INFINITY;
    for (const body of CHILDREN) {
      const height = figureHeight(body);
      if (Math.abs(height - rows) < gap) {
        gap = Math.abs(height - rows);
        best = body;
      }
    }
    return best;
  }
  return sex === 0 ? BODY_FEMALE : BODY_MALE;
}

/** Rangées de la figure au repos d'un corps, au niveau de la planche à sa taille. */
function figureHeight(body: number): number {
  const motif = firstMotif(body, 0, 0, ANIMATION.idle ?? 0);
  return motif < 0 ? 0 : (atlas.motifs[motif * 6 + 5] ?? 0);
}

/**
 * Variante de hauteur d'un adulte au niveau `level`, d'après `ratio` : arrondi(ratio × rangées
 * du niveau), parmi les écarts que l'atlas y range (trois au plus) ; un enfant ou un nourrisson
 * n'a que la sienne. Rend le rang de la variante.
 */
export function variantOf(body: number, level: number, ratio: number): number {
  const info = atlas.levels.at(level);
  if (info === undefined || body > BODY_MALE) return 0;
  const wanted = Math.round(ratio * info.rows) - info.rows;
  let best = 0;
  info.variants.forEach((offset, index) => {
    if (Math.abs(offset - wanted) < Math.abs((info.variants[best] ?? 0) - wanted)) best = index;
  });
  return best;
}

/**
 * Premier motif d'un corps, d'un niveau, d'une variante et d'une animation ; −1 si l'atlas
 * n'en a pas (un enfant n'a que les animations montrées en jeu).
 */
export function firstMotif(
  body: number,
  level: number,
  variant: number,
  animation: number,
): number {
  const slot =
    ((body * atlas.levels.length + level) * VARIANTS + variant) * atlas.animations.length +
    animation;
  return atlas.index[slot] ?? -1;
}

/** Place d'un motif dans l'atlas, sa taille et le point de ses pieds. */
export interface MotifBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly anchorX: number;
  readonly anchorY: number;
}

export function motifBox(motif: number): MotifBox {
  const at = motif * 6;
  const m = atlas.motifs;
  return {
    x: m[at] ?? 0,
    y: m[at + 1] ?? 0,
    width: m[at + 2] ?? 1,
    height: m[at + 3] ?? 1,
    anchorX: m[at + 4] ?? 0,
    anchorY: m[at + 5] ?? 1,
  };
}

/** Largeur, hauteur et pieds (abscisse) de chaque motif, en tableaux, pour la disposition. */
export const MOTIF_WIDTH = Uint8Array.from(
  { length: MOTIF_COUNT },
  (_, m) => atlas.motifs[m * 6 + 2] ?? 1,
);
export const MOTIF_HEIGHT = Uint8Array.from(
  { length: MOTIF_COUNT },
  (_, m) => atlas.motifs[m * 6 + 3] ?? 1,
);
export const MOTIF_ANCHOR = Uint8Array.from(
  { length: MOTIF_COUNT },
  (_, m) => atlas.motifs[m * 6 + 4] ?? 0,
);

/** Corps de chaque motif. */
export const MOTIF_BODY = new Uint8Array(MOTIF_COUNT);
for (let body = 0; body < atlas.bodies.length; body++) {
  for (let level = 0; level < atlas.levels.length; level++) {
    for (let variant = 0; variant < VARIANTS; variant++) {
      atlas.animations.forEach((animation, a) => {
        const first = firstMotif(body, level, variant, a);
        if (first >= 0) MOTIF_BODY.fill(body, first, first + animation.frames);
      });
    }
  }
}

function extent(level: number, sizes: Uint8Array): number {
  let most = 1;
  for (let body = 0; body < atlas.bodies.length; body++) {
    for (let variant = 0; variant < VARIANTS; variant++) {
      atlas.animations.forEach((animation, a) => {
        const first = firstMotif(body, level, variant, a);
        if (first < 0) return;
        for (let f = 0; f < animation.frames; f++) most = Math.max(most, sizes[first + f] ?? 1);
      });
    }
  }
  return most;
}

/** Le plus large et le plus haut des motifs de chaque niveau, en pixels de motif. */
export const LEVEL_WIDEST: readonly number[] = atlas.levels.map((_, level) =>
  extent(level, MOTIF_WIDTH),
);
export const LEVEL_TALLEST: readonly number[] = atlas.levels.map((_, level) =>
  extent(level, MOTIF_HEIGHT),
);

/** Ce qu'une animation dit de sa cadence (data/humans.json). */
export interface Cadence {
  readonly frames: number;
  readonly steps?: number;
  readonly frameMs?: number;
  readonly loop: boolean;
}

/**
 * Image d'une animation de cadence `cadence` à l'instant `clockMs` de l'horloge de la marche du
 * rendu, qui n'avance qu'avec l'instant affiché (figée en pause, ADR 0014), pour un individu de
 * déphasage `phase` (de 0 à 1, tiré de son identifiant) : une animation de `steps` pas fait ses
 * images en `steps` pas de `stepMs` millisecondes ; une autre, une image toutes les `frameMs`,
 * quelle que soit la vitesse. Sans boucle, elle s'arrête sur sa dernière image. Fonction pure.
 */
export function cadenceFrame(
  cadence: Cadence,
  clockMs: number,
  stepMs: number,
  phase: number,
): number {
  const { frames } = cadence;
  const frameMs =
    cadence.steps === undefined ? (cadence.frameMs ?? 200) : (stepMs * cadence.steps) / frames;
  const at = Math.floor(clockMs / frameMs + phase * frames);
  return cadence.loop ? ((at % frames) + frames) % frames : Math.min(frames - 1, Math.max(0, at));
}

/**
 * Image de l'animation de rang `animation` de l'atlas (cadenceFrame) : le point d'entrée par
 * lequel 2b.8 animera chaque activité.
 */
export function animationFrame(
  animation: number,
  clockMs: number,
  stepMs: number,
  phase: number,
): number {
  const cadence = atlas.animations.at(animation);
  return cadence === undefined ? 0 : cadenceFrame(cadence, clockMs, stepMs, phase);
}

/**
 * Animation d'un individu : la marche quand il avance sur une étape, le repos sinon. 2b.8 y
 * passera l'activité de chacun, et data/humans.json dira laquelle montre quoi.
 */
export function animationOf(moving: boolean): number {
  return (moving ? ANIMATION.walk : ANIMATION.idle) ?? 0;
}

/** Une apparence recolorée : palette de peau, allèle des cheveux, grisonnement, tenue, corps. */
export interface HumanLook {
  readonly skin: number;
  readonly hair: number;
  readonly grey: number;
  readonly outfit: number;
  readonly body: BodyKind;
}

const SKIN_MASK = 2 ** LOOK_BITS.skin - 1;
const HAIR_SHIFT = LOOK_BITS.skin;
const HAIR_MASK = 2 ** LOOK_BITS.hair - 1;
const GREY_SHIFT = HAIR_SHIFT + LOOK_BITS.hair;
const GREY_MASK = 2 ** LOOK_BITS.grey - 1;
const OUTFIT_SHIFT = GREY_SHIFT + LOOK_BITS.grey;
const OUTFIT_MASK = 2 ** LOOK_BITS.outfit - 1;
const BODY_SHIFT = OUTFIT_SHIFT + LOOK_BITS.outfit;
const BODY_MASK = 2 ** LOOK_BITS.body - 1;

/**
 * Apparence d'un humain, sur les bits de LOOK_BITS (15) : palette de peau, allèle des cheveux,
 * cran de gris, tenue, sorte de corps. Les données ne déclarent pas plus de palettes ni de
 * tenues que ces bits n'en comptent (core/data/humans.ts).
 */
export function lookCode(look: HumanLook): number {
  return (
    (look.skin & SKIN_MASK) |
    ((look.hair & HAIR_MASK) << HAIR_SHIFT) |
    ((look.grey & GREY_MASK) << GREY_SHIFT) |
    ((look.outfit & OUTFIT_MASK) << OUTFIT_SHIFT) |
    ((bodyCode(look.body) & BODY_MASK) << BODY_SHIFT)
  );
}

export function lookParts(code: number): HumanLook {
  return {
    skin: code & SKIN_MASK,
    hair: (code >> HAIR_SHIFT) & HAIR_MASK,
    grey: (code >> GREY_SHIFT) & GREY_MASK,
    outfit: (code >> OUTFIT_SHIFT) & OUTFIT_MASK,
    body: BODY_KINDS[(code >> BODY_SHIFT) & BODY_MASK] ?? 'male',
  };
}

/** Une palette : la couleur de chaque rôle, PALETTE_ROLES rôles, undefined pour le transparent. */
export type HumanPalette = (Rgb | undefined)[];

/** Les tons gardés des planches, à leur rôle. */
function keptPalette(): HumanPalette {
  const palette = new Array<Rgb | undefined>(PALETTE_ROLES);
  atlas.kept.forEach((color, index) => {
    palette[KEPT + index] = parseColor(color);
  });
  return palette;
}

/**
 * Palette d'une apparence. Pour chaque région, ses rôles prennent, rang pour rang : le tissu de
 * la dernière pièce de la tenue qui la couvre (ou son tissu de rechange sur cette peau) ; sinon,
 * au crâne, les cheveux à leur cran de gris ; sinon la palette de peau. Un sous-vêtement que
 * rien ne couvre garderait ses tons de la planche, ce que le build interdit (tools/
 * human-atlas.ts). `hairIds` donne l'identifiant de chaque allèle du locus des cheveux.
 */
export function humanPalette(
  appearance: Appearance,
  hairIds: readonly string[],
  look: HumanLook,
): HumanPalette {
  const palette = keptPalette();
  const skin = skinTones(appearance, look.skin);
  const hair = hairTones(appearance, hairIds.at(look.hair) ?? '', look.grey);
  const cover = new Map<number, readonly string[]>();
  for (const piece of outfitPieces(appearance, look.outfit, look.body)) {
    const fabric = fabricTones(appearance, piece.fabric, look.skin);
    if (fabric === undefined) continue;
    for (const region of piece.regions) cover.set(atlas.regions.indexOf(region), fabric);
  }
  for (let region = 0; region < atlas.regions.length; region++) {
    const fabric = cover.get(region);
    for (let source = 0; source < 2; source++) {
      for (let rank = 0; rank < 4; rank++) {
        let color: string | undefined;
        if (fabric !== undefined) color = fabric[rank];
        else if (region === atlas.hairRegion) color = hair?.[rank];
        else color = source === 0 ? skin?.[rank] : atlas.under[rank];
        palette[recolorRole(region, source, rank)] =
          color === undefined ? undefined : parseColor(color);
      }
    }
  }
  return palette;
}

/**
 * Palette des planches elles-mêmes : la peau et le sous-vêtement de la base à leur rang, crâne
 * compris, et les tons gardés. Recolorée ainsi, une image de l'atlas au niveau de la planche
 * redonne la planche de l'auteur (tools/human-atlas.test.ts).
 */
export function sheetPalette(): HumanPalette {
  const palette = keptPalette();
  for (let region = 0; region < atlas.regions.length; region++) {
    for (let rank = 0; rank < 4; rank++) {
      palette[recolorRole(region, 0, rank)] = parseColor(atlas.skin[rank] ?? '#000000');
      palette[recolorRole(region, 1, rank)] = parseColor(atlas.under[rank] ?? '#000000');
    }
  }
  return palette;
}

/** Pixels RGBA d'un motif recoloré, ligne par ligne (planches et essais ; le jeu les peint au shader). */
export function recolorHuman(
  motif: number,
  palette: readonly (Rgb | undefined)[],
): Uint8ClampedArray<ArrayBuffer> {
  const { x, y, width, height } = motifBox(motif);
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const role = ATLAS_ROLES[(y + row) * atlas.width + x + column] ?? 0;
      if (role === 0) continue;
      const color = palette[role];
      if (color === undefined) continue;
      const at = (row * width + column) * 4;
      pixels[at] = color[0];
      pixels[at + 1] = color[1];
      pixels[at + 2] = color[2];
      pixels[at + 3] = 255;
    }
  }
  return pixels;
}

/** Rôle recolorable le plus haut de l'atlas : sous PALETTE_ROLES. */
export const ROLE_COUNT = RECOLOR + atlas.regions.length * 8;

/**
 * Les humains des planches vus de la disposition (crowd.ts) : niveaux, motifs et leur taille,
 * corps, variante, animation et image de chacun, et l'apparence de sa palette, de son code
 * d'apparence (core/visual.ts), de son corps et de sa culture.
 */
export function humanTable(appearance: Appearance): HumanTable {
  return {
    levels: LEVEL_ROWS,
    widest: LEVEL_WIDEST,
    tallest: LEVEL_TALLEST,
    width: MOTIF_WIDTH,
    height: MOTIF_HEIGHT,
    anchor: MOTIF_ANCHOR,
    bodyOf,
    variantOf,
    firstMotif,
    animationOf,
    frame: animationFrame,
    look: (code, body, culture) => {
      const visual = decodeVisual(code);
      return lookCode({
        skin: skinPaletteOf(appearance, visual.skin),
        hair: visual.hair,
        grey: visual.grey,
        outfit: cultureOutfit(appearance, culture),
        body: bodyKind(body),
      });
    },
  };
}
