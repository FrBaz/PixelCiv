import { describe, expect, it } from 'vitest';
import { PALETTE_ROLES } from '../core/data/humans';
import { MAX_LOOKS } from '../core/data';
import {
  colorSlot,
  FIRST_PALETTE_ROWS,
  HUMAN_FRAGMENT,
  HUMAN_VERTEX,
  MAX_PALETTE_ROWS,
  PALETTE_ADDRESS,
  PALETTE_WIDTH,
  PALETTES_PER_ROW,
  paletteTexel,
  PaletteTexture,
  roleSource,
  slotColor,
} from './humanShader';
import type { HumanPalette } from './humans';

/**
 * Évalue hors du GPU une expression GLSL de PALETTE_ADDRESS : nombres, variables (vColor.r
 * comprise), + − * /, parenthèses, floor et mod, chaque résultat arrondi en flottant de 32 bits,
 * comme le calcule un GPU en précision haute.
 */
function evaluate(expression: string, variables: Readonly<Record<string, number>>): number {
  const tokens = expression.match(/\d+\.\d+|\d+|[A-Za-z_][\w.]*|[-+*/(),]/g) ?? [];
  let at = 0;
  const next = () => tokens[at++] ?? '';
  const peek = () => tokens[at] ?? '';
  const f = Math.fround;
  const primary = (): number => {
    const token = next();
    if (token === '(') {
      const value = sum();
      next();
      return value;
    }
    if (/^\d/.test(token)) return f(Number(token));
    if (peek() === '(') {
      next();
      const args = [sum()];
      while (peek() === ',') {
        next();
        args.push(sum());
      }
      next();
      const [x = Number.NaN, y = Number.NaN] = args;
      if (token === 'floor') return Math.floor(x);
      if (token === 'mod') return f(x - f(y * Math.floor(f(x / y))));
      throw new Error(`fonction inconnue : ${token}`);
    }
    if (!Object.hasOwn(variables, token)) throw new Error(`variable inconnue : ${token}`);
    return f(variables[token] ?? Number.NaN);
  };
  const product = (): number => {
    let value = primary();
    while (peek() === '*' || peek() === '/') {
      const operator = next();
      const right = primary();
      value = f(operator === '*' ? value * right : value / right);
    }
    return value;
  };
  const sum = (): number => {
    let value = product();
    while (peek() === '+' || peek() === '-') {
      const operator = next();
      const right = product();
      value = f(operator === '+' ? value + right : value - right);
    }
    return value;
  };
  const value = sum();
  if (at !== tokens.length) throw new Error(`expression mal lue : ${expression}`);
  return value;
}

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

  it('lit en GLSL la place que désigne la couleur de la particule, puis le texel de paletteTexel, à tout nombre de rangées', () => {
    for (const rows of [FIRST_PALETTE_ROWS, 32, MAX_PALETTE_ROWS]) {
      for (const slot of [0, 1, 7, 8, 255, 256, 257, 1023, 4097, MAX_LOOKS - 1]) {
        if (slot >= rows * PALETTES_PER_ROW) continue;
        const color = slotColor(slot);
        // La couleur de la particule, quatre octets normalisés, comme les lit le GPU.
        const channel = (shift: number) => ((color >>> shift) & 255) / 255;
        for (const role of [1, 17, PALETTE_ROLES - 1]) {
          const variables: Record<string, number> = {
            roleRed: role / 255,
            'vColor.r': channel(0),
            'vColor.g': channel(8),
            'vColor.b': channel(16),
            'vColor.a': channel(24),
            uPaletteRows: rows,
          };
          for (const name of ['role', 'slot', 'column', 'row'] as const) {
            variables[name] = evaluate(PALETTE_ADDRESS[name], variables);
          }
          const texel = paletteTexel(slot, role);
          const label = `place ${String(slot)}, rôle ${String(role)}, ${String(rows)} rangées`;
          expect([variables.role, variables.slot, variables.column, variables.row], label).toEqual([
            role,
            slot,
            texel.column,
            texel.row,
          ]);
          // Le centre de ce texel, que le GPU lit au plus proche.
          const u = evaluate(PALETTE_ADDRESS.u, variables) * PALETTE_WIDTH;
          const v = evaluate(PALETTE_ADDRESS.v, variables) * rows;
          expect(u - texel.column, label).toBeCloseTo(0.5, 3);
          expect(v - texel.row, label).toBeCloseTo(0.5, 3);
        }
      }
    }
    // Le shader assemble ces expressions ; la couleur de la particule passe telle quelle du
    // sommet au fragment.
    for (const expression of Object.values(PALETTE_ADDRESS)) {
      expect(HUMAN_FRAGMENT).toContain(expression);
    }
    expect(HUMAN_VERTEX.match(/vColor\s*=[^;]*;/g)).toEqual(['vColor = aColor;']);
  });

  it('range chaque palette là où le shader la lit : au texel de paletteTexel', () => {
    const texture = new PaletteTexture(2);
    for (let look = 0; look < 11; look++) texture.slotOf(look, () => paletteOf(look));
    const pixels = texture.source.resource as Uint8Array;
    for (const slot of [0, 5, 8, 10]) {
      for (const role of [1, 64, PALETTE_ROLES - 1]) {
        const { column, row } = paletteTexel(slot, role);
        const at = (row * PALETTE_WIDTH + column) * 4;
        expect(Array.from(pixels.subarray(at, at + 4))).toEqual([role, slot, 255 - role, 255]);
        expect(texture.colorAt(slot, role)).toEqual([role, slot, 255 - role, 255]);
      }
    }
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
