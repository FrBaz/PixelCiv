import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/core/data';
import { loadHumans } from './human-atlas';
import { decodeRgba, type RgbaImage } from './png';

// Les planches de l'auteur (sprites/humans/skin/), telles qu'il les a versées (ADR 0016) : le jeu
// part des deux planches de base et des six palettes de peau des données ; ce test prouve que les
// douze planches de teinte n'apportent rien d'autre.

const root = fileURLToPath(new URL('..', import.meta.url));
const humans = loadHumans(root);
const { appearance } = loadGameData();
const sheet = (path: string): RgbaImage => decodeRgba(readFileSync(`${root}/${path}`));
const hex = (rgba: Uint8Array, at: number) =>
  `#${[0, 1, 2].map((i) => (rgba[at + i] ?? 0).toString(16).padStart(2, '0')).join('')}`;

/** Le suffixe des planches de teinte de chaque palette de peau des données. */
const SHEET_OF: Record<string, string> = {
  xlight: 'xlight',
  light: 'light',
  medium: 'medium',
  olive: 'olive',
  dark: 'dark',
  xdark: 'xdark',
};

describe('planches de l’auteur (ADR 0016, § 1)', () => {
  it('sont deux bases et douze planches de teinte, toutes de 800 × 448 pixels', () => {
    for (const sex of ['female', 'male'] as const) {
      const files = readdirSync(`${root}/sprites/humans/skin/${sex}`).sort();
      expect(files).toEqual(
        Object.values(SHEET_OF)
          .map((suffix) => `${sex}_spritesheet_${suffix}.png`)
          .sort(),
      );
      const base = sheet(humans.sheets[sex]);
      expect([base.width, base.height]).toEqual([800, 448]);
    }
  });

  it('n’emploient que les tons de leur base, l’alpha à 0 ou 255', () => {
    const { outline, eye, kept, skin, under, skinAlso, underAlso } = humans.tones;
    const known = new Set([
      ...outline,
      ...eye,
      ...kept,
      ...skin,
      ...under,
      ...Object.keys(skinAlso),
      ...Object.keys(underAlso),
    ]);
    for (const sex of ['female', 'male'] as const) {
      const { rgba } = sheet(humans.sheets[sex]);
      const seen = new Set<string>();
      let partial = 0;
      for (let at = 0; at < rgba.length; at += 4) {
        const alpha = rgba[at + 3] ?? 0;
        if (alpha !== 0 && alpha !== 255) partial++;
        if (alpha === 255) seen.add(hex(rgba, at));
      }
      expect(partial, `${sex} : alphas ni 0 ni 255`).toBe(0);
      expect(
        [...seen].filter((tone) => !known.has(tone)),
        sex,
      ).toEqual([]);
      // Chaque base emploie toute la peau, tout le sous-vêtement et ses contours.
      for (const tone of [...skin, ...under]) expect(seen.has(tone), `${sex} ${tone}`).toBe(true);
    }
  });

  it('rangent leurs images en cases de 80 × 64, sept rangées de 5, 8, 8, 4, 4, 6 et 10, vides au-delà', () => {
    const { width, height } = humans.cell;
    expect([width, height]).toEqual([80, 64]);
    expect(humans.animations.map((animation) => animation.frames)).toEqual([5, 8, 8, 4, 4, 6, 10]);
    for (const sex of ['female', 'male'] as const) {
      const { rgba, width: sheetWidth } = sheet(humans.sheets[sex]);
      const filled = (column: number, row: number) => {
        for (let y = row * height; y < (row + 1) * height; y++) {
          for (let x = column * width; x < (column + 1) * width; x++) {
            if ((rgba[(y * sheetWidth + x) * 4 + 3] ?? 0) !== 0) return true;
          }
        }
        return false;
      };
      humans.animations.forEach((animation) => {
        for (let column = 0; column < sheetWidth / width; column++) {
          expect(filled(column, animation.row), `${sex} ${animation.id} ${String(column)}`).toBe(
            column < animation.frames,
          );
        }
      });
    }
  });

  it('sont, pour chaque teinte, la base où chaque ton de peau devient le ton de même rang de sa palette', () => {
    const { skin, skinAlso } = humans.tones;
    const rank = new Map<string, number>([
      ...skin.map((tone, index): [string, number] => [tone, index]),
      ...Object.entries(skinAlso),
    ]);
    let replaced = 0;
    for (const sex of ['female', 'male'] as const) {
      const base = sheet(humans.sheets[sex]);
      for (const palette of appearance.skinPalettes) {
        const tinted = sheet(
          `sprites/humans/skin/${sex}/${sex}_spritesheet_${SHEET_OF[palette.id] ?? palette.id}.png`,
        );
        let differences = 0;
        for (let at = 0; at < base.rgba.length; at += 4) {
          const alpha = base.rgba[at + 3] ?? 0;
          if ((tinted.rgba[at + 3] ?? 0) !== alpha) differences++;
          if (alpha === 0) continue;
          const tone = hex(base.rgba, at);
          const level = rank.get(tone);
          const expected = level === undefined ? tone : palette.tones[level];
          if (level !== undefined) replaced++;
          if (hex(tinted.rgba, at) !== expected) differences++;
        }
        expect(differences, `${sex} ${palette.id}`).toBe(0);
      }
    }
    expect(replaced).toBeGreaterThan(0);
  });
});
