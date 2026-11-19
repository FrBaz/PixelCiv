import { describe, expect, it } from 'vitest';
import { PALETTE_ROLES } from '../core/data/humans';
import { MAX_LOOKS } from '../core/data';
import {
  colorSlot,
  FIRST_PALETTE_ROWS,
  HUMAN_FRAGMENT,
  MAX_PALETTE_ROWS,
  PALETTE_WIDTH,
  PALETTES_PER_ROW,
  PaletteTexture,
  roleSource,
  slotColor,
} from './humanShader';
import type { HumanPalette } from './humans';

/** Une palette dont chaque rôle r prend la couleur (r, seed, 255 − r). */
const paletteOf = (seed: number): HumanPalette =>
  Array.from({ length: PALETTE_ROLES }, (_, role) =>
    role === 0 ? undefined : [role, seed, 255 - role],
  );

describe('shader des humains (ADR 0016, § 8)', () => {
  it('désigne la palette de chaque particule par sa couleur, que le shader relit sans perte', () => {
    expect(PALETTES_PER_ROW * MAX_PALETTE_ROWS).toBe(MAX_LOOKS);
    for (const slot of [0, 1, 255, 256, 4097, MAX_LOOKS - 1]) {
      const color = slotColor(slot);
      expect(colorSlot(color)).toBe(slot);
      // Ce que lit le shader : l'octet rouge, puis le vert, normalisés, et l'alpha plein.
      const r = color & 255;
      const g = (color >>> 8) & 255;
      expect(r + 256 * g).toBe(slot);
      expect(color >>> 24).toBe(255);
    }
    expect(HUMAN_FRAGMENT).toContain('precision highp float');
    expect(HUMAN_FRAGMENT).toContain('discard');
    expect(HUMAN_FRAGMENT).toContain(PALETTE_WIDTH.toFixed(1));
  });

  it('range l’atlas des rôles dans le rouge d’une texture, opaque là où il y a un pixel', () => {
    const source = roleSource(Uint8Array.from([0, 17, 120, 0]), 2, 2);
    const pixels = source.resource as Uint8Array;
    expect(Array.from(pixels)).toEqual([0, 0, 0, 0, 17, 0, 0, 255, 120, 0, 0, 255, 0, 0, 0, 0]);
    expect(source.scaleMode).toBe('nearest');
  });

  it('recolore chaque apparence une fois, à sa première vue, et la garde', () => {
    const texture = new PaletteTexture();
    let made = 0;
    const make = (seed: number) => () => {
      made++;
      return paletteOf(seed);
    };
    const first = texture.slotOf(1234, make(1));
    const second = texture.slotOf(99, make(2));
    expect([first, second]).toEqual([0, 1]);
    // Revue cent fois, une apparence ne se recolore plus.
    for (let i = 0; i < 100; i++) expect(texture.slotOf(1234, make(3))).toBe(0);
    expect(made).toBe(2);
    expect(texture.written).toBe(2);
    expect(texture.colorAt(1, 40)).toEqual([40, 2, 215, 255]);
    expect(texture.colorAt(0, 0)).toEqual([0, 0, 0, 0]);
    expect(texture.flush()).toBe(true);
    expect(texture.flush()).toBe(false);
  });

  it('double quand elle est pleine, ses palettes gardées, jusqu’à la borne des apparences possibles', () => {
    const texture = new PaletteTexture(1);
    const before = texture.source;
    for (let look = 0; look < PALETTES_PER_ROW; look++) texture.slotOf(look, () => paletteOf(look));
    expect(texture.rows).toBe(1);
    texture.slotOf(1000, () => paletteOf(77));
    expect(texture.rows).toBe(2);
    expect(texture.source).not.toBe(before);
    expect(texture.colorAt(3, 9)).toEqual([9, 3, 246, 255]);
    expect(texture.colorAt(PALETTES_PER_ROW, 9)).toEqual([9, 77, 246, 255]);
    expect(texture.bytes).toBe(PALETTE_WIDTH * 2 * 4);
    texture.release();
    expect(FIRST_PALETTE_ROWS * PALETTES_PER_ROW).toBeGreaterThanOrEqual(64);
    const full = new PaletteTexture(MAX_PALETTE_ROWS);
    expect(() => {
      for (let look = 0; look <= MAX_LOOKS; look++) full.slotOf(look, () => []);
    }).toThrow(RangeError);
  });
});
