/**
 * Atlas des sources pixel art et recoloration (tâche 2.7 ; AST-04, REN-09 ; ADR 0011).
 *
 * L'atlas, rangé au build par tools/pixel-atlas.ts, donne pour chaque pixel un rôle de
 * teinte. Une palette associe une couleur à chaque rôle : recolorer un motif, c'est
 * remplacer chaque rôle par sa couleur. Les rôles d'ombre et de lumière se déduisent de la
 * base, assombrie ou éclaircie, pour rester dans une gamme restreinte.
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

/** Couleur assombrie (facteur < 1) ou éclaircie (> 1), arrondie. */
export function shade(color: Rgb, factor: number): Rgb {
  return [
    Math.min(255, Math.round(color[0] * factor)),
    Math.min(255, Math.round(color[1] * factor)),
    Math.min(255, Math.round(color[2] * factor)),
  ];
}

/** Teint de la rampe de data/appearance.json, de 0 (clair) à 1 (foncé), interpolé. */
export function skinColor(appearance: Appearance, value: number): Rgb {
  const ramp = appearance.skin.map((color) => parseColor(color));
  const position = Math.min(1, Math.max(0, value)) * (ramp.length - 1);
  const low = Math.floor(position);
  const a = ramp.at(low) ?? ramp.at(0) ?? [0, 0, 0];
  const b = ramp.at(Math.min(ramp.length - 1, low + 1)) ?? a;
  const t = position - low;
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/**
 * Habit d'une culture : les cultures embryonnaires prennent à tour de rôle les habits de
 * data/appearance.json, le premier pour la culture 1. Indéfini sans habit.
 */
export function cultureCloth<T>(clothing: readonly T[], culture: number): T | undefined {
  return clothing[(Math.max(1, culture) - 1) % clothing.length];
}

/** Ombre et lumière d'une teinte de base. */
const SHADOW = 0.78;
const LIGHT = 1.16;

/** Palette d'un individu : teint, cheveux, habit, et les couleurs communes. */
export function personPalette(
  appearance: Appearance,
  colors: { readonly skin: Rgb; readonly hair: Rgb; readonly cloth: Rgb; readonly eye?: Rgb },
): Palette {
  const palette: (Rgb | undefined)[] = [];
  palette[ROLE.outline] = parseColor(appearance.outline);
  palette[ROLE.skinShadow] = shade(colors.skin, SHADOW);
  palette[ROLE.skin] = colors.skin;
  palette[ROLE.skinLight] = shade(colors.skin, LIGHT);
  palette[ROLE.hairShadow] = shade(colors.hair, SHADOW);
  palette[ROLE.hair] = colors.hair;
  palette[ROLE.hairLight] = shade(colors.hair, LIGHT);
  palette[ROLE.clothShadow] = shade(colors.cloth, SHADOW);
  palette[ROLE.cloth] = colors.cloth;
  palette[ROLE.clothLight] = shade(colors.cloth, LIGHT);
  palette[ROLE.eye] = colors.eye ?? parseColor(appearance.outline);
  palette[ROLE.white] = parseColor(appearance.white);
  palette[ROLE.mouth] = parseColor(appearance.mouth);
  return palette;
}
