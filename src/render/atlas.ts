/**
 * Atlas des sources pixel art et recoloration (tâche 2.7 ; AST-04, REN-09 ; ADR 0011).
 *
 * L'atlas, rangé au build par tools/pixel-atlas.ts, donne pour chaque pixel un rôle de
 * teinte. Une palette associe une couleur à chaque rôle : recolorer un motif, c'est
 * remplacer chaque rôle par sa couleur. Les rôles de lumière, de base et d'ombre prennent les
 * tons de même rang d'une rampe des données : aucune couleur n'est calculée (ADR 0016).
 */
import atlas from 'virtual:pixel-atlas';
import type { Appearance } from '../core/data';
import { ROLE } from '../core/visual';
import { parseColor, type Rgb } from './bake';

export { ROLE } from '../core/visual';

/** Couleur de chaque rôle ; un rôle sans couleur reste transparent. */
export type Palette = readonly (Rgb | undefined)[];

export interface Frame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Place d'un motif dans l'atlas ; lève une erreur s'il n'existe pas. */
export function frameOf(name: string): Frame {
  if (!Object.hasOwn(atlas.frames, name)) throw new Error(`motif inconnu : ${name}`);
  return atlas.frames[name];
}

/** L'atlas a-t-il ce motif ? Une variante de hauteur n'existe que si sa source la demande. */
export function hasFrame(name: string): boolean {
  return Object.hasOwn(atlas.frames, name);
}

/** Pixels RGBA d'une image de rôles recolorée, ligne par ligne. */
export function recolorRoles(
  roles: ArrayLike<number>,
  palette: Palette,
): Uint8ClampedArray<ArrayBuffer> {
  const pixels = new Uint8ClampedArray(roles.length * 4);
  for (let index = 0; index < roles.length; index++) {
    const role = roles[index] ?? 0;
    const color = role === ROLE.transparent ? undefined : palette[role];
    if (color === undefined) continue;
    pixels[index * 4] = color[0];
    pixels[index * 4 + 1] = color[1];
    pixels[index * 4 + 2] = color[2];
    pixels[index * 4 + 3] = 255;
  }
  return pixels;
}

/** Pixels RGBA d'un motif de l'atlas recoloré, ligne par ligne. */
export function recolor(name: string, palette: Palette): Uint8ClampedArray<ArrayBuffer> {
  const frame = frameOf(name);
  const roles = new Uint8Array(frame.width * frame.height);
  for (let row = 0; row < frame.height; row++) {
    for (let column = 0; column < frame.width; column++) {
      roles[row * frame.width + column] =
        atlas.roles[(frame.y + row) * atlas.width + frame.x + column] ?? 0;
    }
  }
  return recolorRoles(roles, palette);
}

/**
 * Palette d'un individu, pour son portrait : sa peau, ses cheveux et son habit, chacun pris rang
 * pour rang dans une rampe des données (lumière, base, ombre ; src/render/looks.ts), les yeux de
 * son allèle, et les couleurs communes. Aucune couleur n'est calculée (ADR 0016).
 */
export function personPalette(
  appearance: Appearance,
  tones: {
    readonly skin: readonly string[];
    readonly hair: readonly string[];
    readonly cloth: readonly string[];
    readonly eye?: Rgb;
  },
): Palette {
  const outline = parseColor(appearance.outline);
  const rank = (ramp: readonly string[], index: number) => {
    const color = ramp.at(index);
    return color === undefined ? outline : parseColor(color);
  };
  const palette: (Rgb | undefined)[] = [];
  palette[ROLE.outline] = outline;
  palette[ROLE.skinLight] = rank(tones.skin, 0);
  palette[ROLE.skin] = rank(tones.skin, 1);
  palette[ROLE.skinShadow] = rank(tones.skin, 2);
  palette[ROLE.hairLight] = rank(tones.hair, 0);
  palette[ROLE.hair] = rank(tones.hair, 1);
  palette[ROLE.hairShadow] = rank(tones.hair, 2);
  palette[ROLE.clothLight] = rank(tones.cloth, 0);
  palette[ROLE.cloth] = rank(tones.cloth, 1);
  palette[ROLE.clothShadow] = rank(tones.cloth, 2);
  palette[ROLE.eye] = tones.eye ?? outline;
  palette[ROLE.white] = parseColor(appearance.white);
  palette[ROLE.mouth] = parseColor(appearance.mouth);
  return palette;
}
