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

/**
 * Ce qui trahit un algorithme repris dans le code : son nom, ou ses constantes. Le finaliseur de
 * MurmurHash3 se reconnaît à ses multiplicateurs, même hors de splitmix32.
 */
const SIGNATURES: readonly { readonly algorithm: string; readonly signature: RegExp }[] = [
  {
    algorithm: 'SplitMix et finaliseur de MurmurHash3',
    signature: /\bsplitmix32\(|0x85ebca6b|0xc2b2ae35/i,
  },
  { algorithm: 'FNV-1a', signature: /0x811c9dc5/i },
  { algorithm: 'Algorithme de Dial', signature: /Algorithme de Dial/ },
  { algorithm: 'Mortalité de Siler', signature: /\bSiler\b/ },
  { algorithm: 'Transformation de Box et Muller', signature: /Box et Muller/ },
  { algorithm: 'Tramage ordonné de Bayer', signature: /\bBayer\b/ },
];

/**
 * Algorithmes connus que le jeu ne crédite pas : leur signature ne doit paraître nulle part. Un
 * hachage du décor ou du gibier passe par splitmix32 ou streamSeed, déjà crédités (ADR 0017) ;
 * reprendre l'un de ceux-ci demande sa ligne dans CREDITS.md, et de le passer dans SIGNATURES.
 */
const UNCREDITED: readonly { readonly algorithm: string; readonly signature: RegExp }[] = [
  // Finaliseur « lowbias32 » de Chris Wellons (hash-prospector).
  { algorithm: 'lowbias32', signature: /0x7feb352d|0x846ca68b/i },
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

describe('algorithmes non crédités', () => {
  it('ne paraissent dans aucun fichier du jeu', () => {
    for (const { algorithm, signature } of UNCREDITED) {
      const users = sources.filter((source) => signature.test(source.text)).map((s) => s.name);
      expect(users, `${algorithm} repris sans crédit (CREDITS.md, ADR 0008)`).toEqual([]);
    }
  });

  it('se reconnaissent à leurs constantes', () => {
    const lowbias32 = 'h = Math.imul(h, 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);';
    expect(UNCREDITED.some(({ signature }) => signature.test(lowbias32))).toBe(true);
    const murmur = 'z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);';
    const splitmix = SIGNATURES.find(({ algorithm }) => algorithm.startsWith('SplitMix'));
    expect(splitmix?.signature.test(murmur)).toBe(true);
  });
});

describe('crédits du pack de sprites (AST-02, ADR 0016)', () => {
  it('nomment le pack intégré, son auteur, son lien, et sa licence telle que l’auteur du jeu l’a vérifiée', () => {
    const credits = readFileSync(path.join(root, 'CREDITS.md'), 'utf8');
    const section = credits.split('\n## Pack de sprites\n')[1]?.split('\n## ')[0] ?? '';
    const humans = JSON.parse(readFileSync(path.join(root, 'data/humans.json'), 'utf8')) as {
      credit: { title: string; author: string; url: string };
    };
    expect(section.startsWith('\nIntégré')).toBe(true);
    for (const value of Object.values(humans.credit)) expect(section).toContain(value);
    // La ligne du tableau : titre, auteur, lien, licence vérifiée, emplacement des planches.
    const row = section.split('\n').find((line) => line.startsWith(`| ${humans.credit.title}`));
    expect(row).toBeDefined();
    expect(row).toContain(humans.credit.author);
    expect(row).toContain(humans.credit.url);
    expect(row).toContain('vérifiée par l’auteur du jeu le 15 novembre 2026'.replace('’', "'"));
    expect(row).toContain('`sprites/humans/skin/`');
  });
});
