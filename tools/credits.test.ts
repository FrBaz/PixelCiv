// Crédits des algorithmes repris (CREDITS.md, ADR 0008 ; D-9). Chaque fichier que cite le
// tableau des algorithmes existe ; chaque algorithme que l'on sait reconnaître dans le
// code, à son nom ou à ses constantes, a sa ligne, et elle cite tous les fichiers où il
// sert. Un algorithme repris s'ajoute à SIGNATURES en même temps qu'à CREDITS.md.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Lignes du tableau des algorithmes de CREDITS.md : le nom, et les fichiers cités. */
function algorithmRows(): Map<string, string[]> {
  const credits = readFileSync(path.join(root, 'CREDITS.md'), 'utf8');
  const section = credits.split('\n## Algorithmes\n')[1]?.split('\n## ')[0] ?? '';
  const rows = new Map<string, string[]>();
  for (const line of section.split('\n')) {
    // | Algorithme | Usage | Auteurs | Référence |
    const cells = line.split('|').map((cell) => cell.trim());
    const name = cells[1] ?? '';
    if (cells.length !== 6 || name === 'Algorithme' || name.startsWith('---')) continue;
    rows.set(
      name,
      [...line.matchAll(/`((?:src|data|tools)\/[^`]+)`/g)].map((match) => match[1]),
    );
  }
  return rows;
}

/** Sources du jeu, hors tests et bancs d'essai, par chemin depuis la racine du dépôt. */
const sources = readdirSync(path.join(root, 'src'), { recursive: true, encoding: 'utf8' })
  .filter((file) => /\.tsx?$/.test(file) && !/\.(test|bench)\.tsx?$/.test(file))
  .map((file) => {
    const name = path.posix.join('src', file.split(path.sep).join('/'));
    return { name, text: readFileSync(path.join(root, name), 'utf8') };
  });

/** Ce qui trahit un algorithme repris dans le code : son nom, ou ses constantes. */
const SIGNATURES: readonly { readonly algorithm: string; readonly signature: RegExp }[] = [
  { algorithm: 'SplitMix et finaliseur de MurmurHash3', signature: /\bsplitmix32\(/ },
  { algorithm: 'FNV-1a', signature: /0x811c9dc5/i },
  { algorithm: 'Algorithme de Dial', signature: /Algorithme de Dial/ },
  { algorithm: 'Mortalité de Siler', signature: /\bSiler\b/ },
  { algorithm: 'Transformation de Box et Muller', signature: /Box et Muller/ },
  { algorithm: 'Tramage ordonné de Bayer', signature: /\bBayer\b/ },
  { algorithm: 'Spirale de Vogel', signature: /\bGOLDEN_ANGLE\b/ },
];

describe('crédits des algorithmes', () => {
  it('ne citent que des fichiers du dépôt', () => {
    const rows = algorithmRows();
    expect(rows.size).toBeGreaterThan(10);
    const cited = [...rows.values()].flat();
    expect(cited.filter((file) => !existsSync(path.join(root, file)))).toEqual([]);
  });

  it('nomment chaque algorithme repris et chaque fichier où il sert (D-9)', () => {
    const rows = algorithmRows();
    for (const { algorithm, signature } of SIGNATURES) {
      const users = sources.filter((source) => signature.test(source.text)).map((s) => s.name);
      expect(users, algorithm).not.toEqual([]);
      const cited = rows.get(algorithm);
      expect(cited, `${algorithm} manque à CREDITS.md`).toBeDefined();
      expect(
        users.filter((file) => !cited?.includes(file)),
        `fichiers de ${algorithm} absents de CREDITS.md`,
      ).toEqual([]);
    }
  });
});
