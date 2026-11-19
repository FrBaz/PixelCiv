import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import {
  MODULE,
  packAtlas,
  parseGrid,
  pixelAtlas,
  readSources,
  variantGrid,
  variantName,
} from './pixel-atlas';

describe("pipeline d'assets (AST-04)", () => {
  it('lit une grille de rôles, et nomme la source et la ligne en défaut', () => {
    const grid = parseGrid('essai', '# commentaire\n.s\nhc\n');
    expect(grid).toEqual({ width: 2, height: 2, roles: [0, 3, 6, 9] });
    expect(() => parseGrid('essai', '..\n.')).toThrow(/essai, ligne 2/);
    expect(() => parseGrid('essai', '.q')).toThrow(/rôle inconnu « q »/);
    expect(() => parseGrid('essai', '# rien')).toThrow(/vide/);
  });

  it('numérote les lignes comme le fichier, commentaires et lignes vides compris (A-7)', () => {
    // Les sources du jeu commencent toutes par un commentaire.
    expect(() => parseGrid('essai', '# c\n..\n...')).toThrow(/essai, ligne 3 : 3 pixels/);
    expect(() => parseGrid('essai', '# c\n\n..\r\n\r\n# d\n.q')).toThrow(
      /essai, ligne 6 : rôle inconnu « q »/,
    );
  });

  it('ignore une marque d’ordre des octets en tête de source (A-7)', () => {
    expect(parseGrid('essai', '\uFEFF# commentaire\n.s\n')).toEqual({
      width: 2,
      height: 1,
      roles: [0, 3],
    });
    expect(parseGrid('essai', '\uFEFF.s\n')).toEqual({ width: 2, height: 1, roles: [0, 3] });
  });

  it('fait les variantes de hauteur qu’une source demande, en doublant ou en ôtant une rangée (ADR 0014)', () => {
    const grid = parseGrid('essai', '# motif\n# variantes 2 à 4, rangée 2\nss\nhc\noo\n');
    expect(grid.variants).toEqual({ min: 2, max: 4, row: 2 });
    expect(variantGrid(grid, 2).roles).toEqual([3, 3, 1, 1]);
    expect(variantGrid(grid, 3).roles).toEqual(grid.roles);
    expect(variantGrid(grid, 4)).toEqual({ width: 2, height: 4, roles: [3, 3, 6, 9, 6, 9, 1, 1] });
    expect(() => variantGrid(grid, 5)).toThrow(/non demandée/);
    expect(() => variantGrid(parseGrid('essai', 'ss'), 1)).toThrow(/non demandée/);
    // Une rangée de plus ou de moins au plus, la hauteur de la source comprise, une rangée du
    // motif, une seule demande, et une forme exacte.
    expect(() => parseGrid('essai', '# variantes 1 à 4, rangée 2\nss\nhc\noo')).toThrow(
      /essai, ligne 1 : de 2 à 4 rangées/,
    );
    expect(() => parseGrid('essai', '# variantes 4 à 4, rangée 2\nss\nhc\noo')).toThrow(
      /rangées au plus/,
    );
    expect(() => parseGrid('essai', '# variantes 2 à 4, rangée 4\nss\nhc\noo')).toThrow(
      /rangée hors du motif/,
    );
    expect(() => parseGrid('essai', '# variantes 2 à 4\nss\nhc\noo')).toThrow(/attendu/);
    expect(() =>
      parseGrid('essai', '# variantes 2 à 4, rangée 1\n# variantes 2 à 3, rangée 1\nss\nhc\noo'),
    ).toThrow(/essai, ligne 2 : variantes déjà demandées/);
    expect(variantName('sprites/adult-male-0', 10)).toBe('sprites/adult-male-0@10');
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

  it('lit toutes les sources du jeu : les bannières, les seuls motifs pixel art de la carte (ADR 0016)', () => {
    const sources = readSources(fileURLToPath(new URL('../assets/pixel', import.meta.url)));
    // Les mini-sprites de 2.9 ont cédé la place aux humains des planches (tâche 2b.5).
    expect(Object.keys(sources).filter((name) => name.startsWith('sprites/'))).toEqual([]);
    for (const name of ['icons/group', 'icons/group-16', 'icons/group-24', 'icons/group-36']) {
      expect(sources[name], name).toBeDefined();
    }
  });

  it('refait l’atlas et recharge la page quand une source est ajoutée, modifiée ou supprimée (A-4)', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pixelciv-atlas-'));
    const root = join(directory, 'pixel');
    const source = (name: string) => join(root, 'sprites', `${name}.txt`);
    mkdirSync(join(root, 'sprites'), { recursive: true });
    writeFileSync(source('a'), '# a\nss\n');
    // Un vrai serveur de développement, sans observateur de fichiers : les événements de
    // l'observateur sont émis à la main, à coup sûr et sans attendre le système.
    const server = await createServer({
      root: directory,
      configFile: false,
      logLevel: 'silent',
      server: { watch: null },
      plugins: [pixelAtlas(root)],
    });
    try {
      const client = server.environments.client;
      const send = vi.spyOn(client.hot, 'send');
      // Les appels de send ont deux formes : un message, ou un événement et ses données.
      const reloads = () =>
        send.mock.calls.filter((call) => {
          const payload: unknown = call[0];
          return (
            typeof payload === 'object' &&
            payload !== null &&
            'type' in payload &&
            payload.type === 'full-reload'
          );
        }).length;
      const names = async () => {
        const code = (await client.transformRequest(MODULE))?.code ?? '';
        return [...code.matchAll(/"(sprites\/[a-z]+)":\{/g)].map((match) => match[1]).sort();
      };
      // Le serveur a déjà servi l'atlas à la page.
      expect(await names()).toEqual(['sprites/a']);
      const event = async (kind: 'add' | 'change' | 'unlink', file: string, count: number) => {
        server.watcher.emit(kind, file);
        await vi.waitFor(() => {
          expect(reloads()).toBe(count);
        });
      };
      writeFileSync(source('b'), '# b\nhh\n');
      await event('add', source('b'), 1);
      expect(await names()).toEqual(['sprites/a', 'sprites/b']);
      writeFileSync(source('a'), '# a\nss\nss\n');
      await event('change', source('a'), 2);
      expect(code(await client.transformRequest(MODULE))).toContain('"height":2');
      unlinkSync(source('b'));
      await event('unlink', source('b'), 3);
      expect(await names()).toEqual(['sprites/a']);
      // Un fichier hors des sources ne recharge rien.
      writeFileSync(join(directory, 'autre.txt'), 'rien');
      server.watcher.emit('add', join(directory, 'autre.txt'));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(reloads()).toBe(3);
    } finally {
      await server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

/** Code d'un module transformé par le serveur de développement. */
function code(result: { code: string } | null): string {
  return result?.code ?? '';
}
