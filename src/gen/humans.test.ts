import { describe, expect, it } from 'vitest';
import {
  MAX_KEPT_TONES,
  MAX_REGIONS,
  PALETTE_ROLES,
  RECOLOR as SCHEMA_RECOLOR,
} from '../core/data/humans';
import {
  cellRoles,
  eyeRoles,
  figureRows,
  KEPT,
  keptTones,
  parseRegionGrids,
  RECOLOR,
  recolorRole,
  reduceRoles,
  roleParts,
  toneKinds,
  trimRoles,
  youngRoles,
  type BaseTones,
  type RoleImage,
} from './humans';

// Les fonctions pures des humains des planches (ADR 0016), sur des images fabriquées ; les
// planches elles-mêmes se vérifient dans tools/ (human-sheets, human-dressing, human-atlas).

const TONES: BaseTones = {
  outline: ['#000000'],
  eye: ['#111111'],
  kept: ['#ffffff'],
  skin: ['#f0f0f0', '#d0d0d0', '#b0b0b0', '#909090'],
  under: ['#0000f0', '#0000d0', '#0000b0', '#000090'],
  skinAlso: { '#e00000': 3 },
  underAlso: {},
};
const LETTERS = 'CVAB';

/** Une case RGBA de `lines`, une lettre par pixel : o contour, e œil, w gardé, s/S peau, u sous-vêtement. */
function cell(lines: readonly string[]): { rgba: Uint8Array; width: number; height: number } {
  const width = lines[0]?.length ?? 0;
  const height = lines.length;
  const colors: Record<string, [number, number, number]> = {
    o: [0, 0, 0],
    e: [17, 17, 17],
    w: [255, 255, 255],
    s: [208, 208, 208],
    S: [144, 144, 144],
    u: [0, 0, 208],
    r: [224, 0, 0],
    x: [1, 2, 3],
  };
  const rgba = new Uint8Array(width * height * 4);
  lines.forEach((line, y) => {
    line.split('').forEach((char, x) => {
      if (!Object.hasOwn(colors, char)) return;
      rgba.set([...colors[char], 255], (y * width + x) * 4);
    });
  });
  return { rgba, width, height };
}

describe('rôles des humains des planches (ADR 0016)', () => {
  it('range les rôles sur un octet, dans les bornes que vérifie le schéma', () => {
    expect(RECOLOR).toBe(SCHEMA_RECOLOR);
    expect(RECOLOR - KEPT).toBe(MAX_KEPT_TONES);
    expect(RECOLOR + 8 * MAX_REGIONS).toBeLessThanOrEqual(PALETTE_ROLES);
    for (const [region, source, rank] of [
      [0, 0, 0],
      [MAX_REGIONS - 1, 1, 3],
      [5, 1, 2],
    ] as const) {
      const role = recolorRole(region, source, rank);
      expect(role).toBeLessThan(PALETTE_ROLES);
      expect(roleParts(role)).toEqual({ region, source, rank });
    }
    expect(keptTones(TONES)).toEqual(['#000000', '#111111', '#ffffff']);
    expect(eyeRoles(TONES)).toEqual([KEPT + 1]);
    const kinds = toneKinds(TONES);
    expect(kinds.get('#111111')).toEqual({ kind: 'kept', role: KEPT + 1 });
    expect(kinds.get('#b0b0b0')).toEqual({ kind: 'skin', rank: 2 });
    expect(kinds.get('#e00000')).toEqual({ kind: 'skin', rank: 3 });
    expect(kinds.get('#0000d0')).toEqual({ kind: 'under', rank: 1 });
  });

  it('lit une grille de régions, et nomme la ligne de toute erreur', () => {
    const text = '# case 1 0\n# image 0\nooo\noVo\n# image 1\noAo\n';
    const grids = parseRegionGrids('g.txt', text, 5, 3, LETTERS);
    expect(grids.frames).toHaveLength(2);
    expect(grids.frames[0]).toEqual(['.ooo.', '.oVo.', '.....']);
    expect(grids.frames[1]).toEqual(['.oAo.', '.....', '.....']);
    expect(() => parseRegionGrids('g.txt', '# case 0 0\n# image 0\noZo\n', 3, 1, LETTERS)).toThrow(
      'g.txt, ligne 3 : lettre inconnue « Z »',
    );
    expect(() => parseRegionGrids('g.txt', 'ooo\n', 3, 1, LETTERS)).toThrow(
      "g.txt, ligne 1 : ligne hors d'une image",
    );
    expect(() =>
      parseRegionGrids('g.txt', '# case 0 0\n# image 0\no\n# image 0\no\n', 3, 1, LETTERS),
    ).toThrow('image 0 répétée');
    expect(() => parseRegionGrids('g.txt', '# case 0 0\n# image 1\no\n', 3, 1, LETTERS)).toThrow(
      'image 0 absente',
    );
    expect(() => parseRegionGrids('g.txt', '# case 2 0\n# image 0\nooo\n', 3, 1, LETTERS)).toThrow(
      'trop large',
    );
  });

  it('donne à chaque pixel de peau sa région et son rang, et refuse toute grille qui contredit la planche', () => {
    const { rgba, width, height } = cell(['oso', 'eSu', 'ru.']);
    const kinds = toneKinds(TONES);
    const roles = (grid: string[]) =>
      cellRoles('case', rgba, width, 0, 0, width, height, [1, 3], grid, kinds, LETTERS);
    const image = roles(['oVo', 'oAB', 'AB.']);
    expect(Array.from(image.roles)).toEqual([
      KEPT,
      recolorRole(1, 0, 1),
      KEPT,
      KEPT + 1,
      recolorRole(2, 0, 3),
      recolorRole(3, 1, 1),
      recolorRole(2, 0, 3),
      recolorRole(3, 1, 1),
      0,
    ]);
    expect([image.anchorX, image.anchorY]).toEqual([1, 3]);
    expect(() => roles(['oVo', 'oAB', 'ABo'])).toThrow(
      'case, pixel (2, 2) : transparent, la grille dit « o »',
    );
    expect(() => roles(['oVo', 'AAB', 'AB.'])).toThrow(
      'case, pixel (0, 1) : ton gardé #111111, la grille dit « A »',
    );
    expect(() => roles(['ooo', 'oAB', 'AB.'])).toThrow(
      'case, pixel (1, 0) : #d0d0d0 sans région, la grille dit « o »',
    );
    const odd = cell(['oxo', 'oso', '...']);
    expect(() =>
      cellRoles('case', odd.rgba, 3, 0, 0, 3, 3, [1, 3], ['oVo', 'oVo', '...'], kinds, LETTERS),
    ).toThrow('case, pixel (1, 0) : ton inconnu #010203');
    const partial = cell(['s']);
    partial.rgba[3] = 128;
    expect(() =>
      cellRoles('case', partial.rgba, 1, 0, 0, 1, 1, [0, 1], ['V'], kinds, LETTERS),
    ).toThrow('alpha 128, ni 0 ni 255');
  });

  /** Une figure de `rows` rangées, d'un rôle par région en bandes, contour autour. */
  function figure(rows: number, width = 9): RoleImage {
    const roles = new Uint8Array(width * rows);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < width; x++) {
        const edge = x === 0 || x === width - 1 || y === 0;
        const region = y < rows / 4 ? 0 : y < rows / 2 ? 1 : 2;
        roles[y * width + x] = edge ? KEPT : recolorRole(region, 0, (x + y) % 4);
      }
    }
    roles[2 * width + 4] = KEPT + 1;
    return { width, height: rows, roles, anchorX: Math.floor(width / 2), anchorY: rows };
  }

  it('réduit sans couleur nouvelle : rôles de l’entrée ou contour, pieds sur les pieds', () => {
    const image = figure(40);
    const input = new Set(image.roles);
    for (const [factor, mode] of [
      [1.5, 'thick'],
      [2, 'thick'],
      [3, 'none'],
      [4, 'none'],
    ] as const) {
      const reduced = reduceRoles(image, factor, mode, [KEPT + 1]);
      for (const role of reduced.roles) {
        expect(role === 0 || role === KEPT || input.has(role), `×${String(factor)}`).toBe(true);
      }
      expect(reduced.anchorY).toBe(reduced.height);
      expect(Math.abs(figureRows(reduced) - 40 / factor)).toBeLessThanOrEqual(1);
      // La rangée des pieds porte des pixels : la figure ne flotte pas.
      const bottom = reduced.roles.subarray((reduced.height - 1) * reduced.width);
      expect(bottom.some((role) => role !== 0)).toBe(true);
    }
    expect(reduceRoles(image, 1, 'keep', [])).toBe(image);
  });

  it('garde la ligne des pieds d’une figure debout, même là où le vote la viderait', () => {
    // Une figure aux pieds d'un pixel de large, sur une rangée : à ×4, le vote les perdrait.
    const width = 8;
    const rows = 16;
    const roles = new Uint8Array(width * rows);
    for (let y = 0; y < rows - 1; y++)
      for (let x = 2; x < 6; x++) roles[y * width + x] = recolorRole(1, 0, 1);
    roles[(rows - 1) * width + 3] = recolorRole(2, 0, 2);
    const reduced = reduceRoles(
      { width, height: rows, roles, anchorX: 4, anchorY: rows },
      4,
      'none',
      [],
    );
    expect(
      reduced.roles.subarray((reduced.height - 1) * reduced.width).some((role) => role !== 0),
    ).toBe(true);
  });

  it('compose un enfant de la tête d’un adulte et de son corps, à la hauteur demandée, sans couleur nouvelle', () => {
    const image = figure(40);
    const input = new Set(image.roles);
    for (const [rows, head] of [
      [26, 9],
      [19, 8],
    ] as const) {
      const young = trimRoles(youngRoles(image, rows, head, 'thick', [KEPT + 1], [0]));
      expect(Math.abs(figureRows(young) - rows)).toBeLessThanOrEqual(1);
      for (const role of young.roles)
        expect(role === 0 || role === KEPT || input.has(role)).toBe(true);
    }
  });

  it('recadre une image sur ses pixels, pieds gardés', () => {
    const roles = new Uint8Array(25);
    roles[2 * 5 + 1] = KEPT;
    roles[3 * 5 + 3] = KEPT;
    const trimmed = trimRoles({ width: 5, height: 5, roles, anchorX: 2, anchorY: 5 });
    expect([trimmed.width, trimmed.height, trimmed.anchorX, trimmed.anchorY]).toEqual([3, 2, 1, 3]);
    expect(figureRows(trimmed)).toBe(3);
    expect(
      trimRoles({ width: 2, height: 2, roles: new Uint8Array(4), anchorX: 1, anchorY: 2 }).width,
    ).toBe(1);
  });
});
