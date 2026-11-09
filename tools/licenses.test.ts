import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  auditLockfile,
  isSatisfied,
  LICENSE_POLICY,
  packageName,
  parseLicenseExpression,
  type LicensePolicy,
  type Lockfile,
} from './licenses';

describe('parseLicenseExpression', () => {
  it('lit un identifiant seul', () => {
    expect(parseLicenseExpression('MIT')).toEqual({ kind: 'license', id: 'MIT' });
  });

  it('lit une alternative entre parenthèses', () => {
    expect(parseLicenseExpression('(MIT OR Apache-2.0)')).toEqual({
      kind: 'or',
      left: { kind: 'license', id: 'MIT' },
      right: { kind: 'license', id: 'Apache-2.0' },
    });
  });

  it('fait passer AND avant OR', () => {
    expect(parseLicenseExpression('MIT OR ISC AND GPL-3.0-only')).toEqual({
      kind: 'or',
      left: { kind: 'license', id: 'MIT' },
      right: {
        kind: 'and',
        left: { kind: 'license', id: 'ISC' },
        right: { kind: 'license', id: 'GPL-3.0-only' },
      },
    });
  });

  it("garde l'exception et omet le suffixe « + »", () => {
    expect(parseLicenseExpression('Apache-2.0 WITH LLVM-exception')).toEqual({
      kind: 'license',
      id: 'Apache-2.0',
      exception: 'LLVM-exception',
    });
    expect(parseLicenseExpression('GPL-2.0+')).toEqual({ kind: 'license', id: 'GPL-2.0' });
  });

  it.each([
    '',
    '()',
    'MIT OR',
    'AND MIT',
    '(MIT',
    '(MIT ISC',
    'MIT)',
    'MIT WITH',
    'MIT WITH OR',
    'MIT WITH (',
    'MIT WITH LLVM-exception+',
    'MIT or ISC',
    'SEE LICENSE IN LICENSE.md',
  ])('rejette « %s »', (text) => {
    expect(parseLicenseExpression(text)).toBeUndefined();
  });
});

describe('isSatisfied', () => {
  const allowed = new Set(['MIT', 'ISC']);
  const check = (text: string): boolean => {
    const expression = parseLicenseExpression(text);
    if (expression === undefined) throw new Error(`expression invalide : ${text}`);
    return isSatisfied(
      expression,
      (id, exception) => allowed.has(id) && exception !== 'Commons-Clause',
    );
  };

  it('admet une licence de la liste et refuse les autres', () => {
    expect(check('MIT')).toBe(true);
    expect(check('GPL-3.0-only')).toBe(false);
  });

  it("demande une seule branche d'une alternative", () => {
    expect(check('GPL-3.0-only OR MIT')).toBe(true);
  });

  it("demande les deux termes d'une conjonction", () => {
    expect(check('MIT AND GPL-3.0-only')).toBe(false);
    expect(check('(GPL-3.0-only OR MIT) AND ISC')).toBe(true);
  });

  it("transmet l'exception à la politique", () => {
    expect(check('MIT WITH Commons-Clause')).toBe(false);
    expect(check('MIT WITH LLVM-exception')).toBe(true);
  });
});

describe('packageName', () => {
  it('extrait le nom, imbriqué ou non, avec ou sans portée', () => {
    expect(packageName('node_modules/vite')).toBe('vite');
    expect(packageName('node_modules/a/node_modules/@scope/b')).toBe('@scope/b');
  });
});

describe('auditLockfile', () => {
  const policy: LicensePolicy = {
    allowed: new Set(['MIT']),
    allowedExceptions: new Set(['LLVM-exception']),
    toolExceptions: [{ packages: /^tool$/, licenses: new Set(['MPL-2.0']) }],
  };
  const lockfile: Lockfile = {
    lockfileVersion: 3,
    packages: {
      '': { version: '0.0.0', license: 'UNLICENSED' },
      'node_modules/shipped': { version: '1.0.0', license: 'MIT' },
      'node_modules/excepted': { version: '1.0.0', license: 'MIT WITH LLVM-exception' },
      'node_modules/tool': { version: '1.0.0', license: 'MPL-2.0', dev: true },
      'node_modules/local': { link: true },
      'node_modules/library': { version: '2.0.0', license: 'MPL-2.0', dev: true },
      'node_modules/dev-gpl': { version: '2.0.0', license: 'GPL-3.0-only', dev: true },
      'node_modules/copyleft': { version: '3.0.0', license: 'MPL-2.0' },
      // Un outil nommé, mais atteint par une dépendance optionnelle du jeu : il peut être distribué.
      'node_modules/a/node_modules/tool': { version: '3.1.0', license: 'MPL-2.0', optional: true },
      'node_modules/b/node_modules/tool': {
        version: '3.2.0',
        license: 'MPL-2.0',
        devOptional: true,
      },
      'node_modules/clause': { version: '4.0.0', license: 'MIT WITH Commons-Clause' },
      'node_modules/tool/node_modules/@scope/unlabelled': { version: '5.0.0', dev: true },
      'node_modules/custom': { version: '6.0.0', license: 'SEE LICENSE IN LICENSE' },
    },
  };
  const issue = (
    name: string,
    version: string,
    license: string | undefined,
    development: boolean,
    problem: string,
  ) => ({ name, version, license, development, problem });

  it('signale les licences absentes, illisibles ou non admises', () => {
    expect(auditLockfile(lockfile, policy)).toEqual([
      issue('library', '2.0.0', 'MPL-2.0', true, 'forbidden'),
      issue('dev-gpl', '2.0.0', 'GPL-3.0-only', true, 'forbidden'),
      issue('copyleft', '3.0.0', 'MPL-2.0', false, 'forbidden'),
      issue('tool', '3.1.0', 'MPL-2.0', false, 'forbidden'),
      issue('tool', '3.2.0', 'MPL-2.0', false, 'forbidden'),
      issue('clause', '4.0.0', 'MIT WITH Commons-Clause', false, 'forbidden'),
      issue('@scope/unlabelled', '5.0.0', undefined, true, 'missing'),
      issue('custom', '6.0.0', 'SEE LICENSE IN LICENSE', false, 'invalid'),
    ]);
  });
});

describe('LICENSE_POLICY', () => {
  it("n'admet MPL-2.0 que pour lightningcss et ses binaires natifs", () => {
    const tools: Lockfile = {
      lockfileVersion: 3,
      packages: {
        'node_modules/lightningcss': { license: 'MPL-2.0', dev: true },
        'node_modules/lightningcss-linux-x64-gnu': { license: 'MPL-2.0', dev: true },
        'node_modules/lightningcss-wasm': { license: 'MPL-2.0', dev: true },
        'node_modules/bitecs': { license: 'MPL-2.0', dev: true },
      },
    };
    expect(auditLockfile(tools, LICENSE_POLICY).map((issue) => issue.name)).toEqual([
      'lightningcss-wasm',
      'bitecs',
    ]);
  });
});

describe('dépendances du projet', () => {
  it('sont toutes sous une licence admise', () => {
    const text = readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8');
    const lockfile = JSON.parse(text) as Lockfile;
    expect(lockfile.lockfileVersion).toBeGreaterThanOrEqual(2);
    expect(auditLockfile(lockfile, LICENSE_POLICY)).toEqual([]);
  });
});
