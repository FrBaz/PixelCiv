// Vérifie le catalogue français face au code : aucune clé ne manque, aucune ne traîne
// sans usage (tâche 0.9). Les clés venant des données (data/) comptent comme utilisées.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import fr from '../src/i18n/fr.json';
import { checkCatalog } from '../src/i18n/translate';

const root = fileURLToPath(new URL('..', import.meta.url));

function files(directory: string, extensions: readonly string[]): string[] {
  return readdirSync(path.join(root, directory), { recursive: true, encoding: 'utf8' })
    .filter((file) => extensions.some((extension) => file.endsWith(extension)))
    .map((file) => path.join(root, directory, file));
}

const sources = files('src', ['.ts', '.tsx'])
  .filter((file) => !/\.(test|bench)\.tsx?$/.test(file))
  .map((file) => readFileSync(file, 'utf8'));
const data = files('data', ['.json']).map((file) => readFileSync(file, 'utf8'));
const keys = Object.keys(fr);

describe('catalogue français', () => {
  it('est bien formé', () => {
    expect(checkCatalog(fr)).toEqual([]);
  });

  it('contient toutes les clés passées à t()', () => {
    const used = sources.flatMap((source) =>
      [...source.matchAll(/\bt\(\s*(['"])([^'"]+)\1/g)].map((match) => match[2]),
    );
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((key) => !keys.includes(key))).toEqual([]);
  });

  it("n'a pas de clé inutilisée", () => {
    const quoted = (key: string) => [`'${key}'`, `"${key}"`];
    const unused = keys.filter(
      (key) =>
        !sources.some((source) => quoted(key).some((text) => source.includes(text))) &&
        !data.some((json) => json.includes(`"${key}"`)),
    );
    expect(unused).toEqual([]);
  });
});
