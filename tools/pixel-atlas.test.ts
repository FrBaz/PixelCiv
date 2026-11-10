import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { packAtlas, parseGrid, readSources } from './pixel-atlas';

describe("pipeline d'assets (AST-04)", () => {
  it('lit une grille de rôles, et nomme la source et la ligne en défaut', () => {
    const grid = parseGrid('essai', '# commentaire\n.s\nhc\n');
    expect(grid).toEqual({ width: 2, height: 2, roles: [0, 3, 6, 9] });
    expect(() => parseGrid('essai', '..\n.')).toThrow(/essai, ligne 2/);
    expect(() => parseGrid('essai', '.q')).toThrow(/rôle inconnu « q »/);
    expect(() => parseGrid('essai', '# rien')).toThrow(/vide/);
  });

  it('range les motifs sans recouvrement, avec leurs rôles', () => {
    const a = parseGrid('a', 'ss\nss');
    const b = parseGrid('b', 'hhh');
    const atlas = packAtlas({ a, b }, 4);
    expect(Object.keys(atlas.frames).sort()).toEqual(['a', 'b']);
    const frameA = atlas.frames.a;
    const frameB = atlas.frames.b;
    const overlap =
      frameA.x < frameB.x + frameB.width &&
      frameB.x < frameA.x + frameA.width &&
      frameA.y < frameB.y + frameB.height &&
      frameB.y < frameA.y + frameA.height;
    expect(overlap).toBe(false);
    expect(atlas.roles[frameA.y * atlas.width + frameA.x]).toBe(3);
    expect(atlas.roles[frameB.y * atlas.width + frameB.x + 2]).toBe(6);
  });

  it('lit toutes les sources du jeu, mini-sprites et icônes compris', () => {
    const sources = readSources(fileURLToPath(new URL('../assets/pixel', import.meta.url)));
    for (const age of ['baby', 'child', 'adult-male', 'adult-female']) {
      for (const step of [0, 1]) expect(sources[`sprites/${age}-${String(step)}`]).toBeDefined();
    }
    // Des mini-sprites de 4 à 10 pixels de haut (REN-04).
    for (const [name, grid] of Object.entries(sources)) {
      if (!name.startsWith('sprites/')) continue;
      expect(grid.height).toBeGreaterThanOrEqual(4);
      expect(grid.height).toBeLessThanOrEqual(10);
    }
    expect(sources['icons/group']).toBeDefined();
  });
});
