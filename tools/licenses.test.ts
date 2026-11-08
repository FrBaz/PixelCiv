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

  it('omet les exceptions et le suffixe « + »', () => {
    expect(parseLicenseExpression('Apache-2.0 WITH LLVM-exception')).toEqual({
      kind: 'license',
      id: 'Apache-2.0',
    });
    expect(parseLicenseExpression('GPL-2.0+')).toEqual({ kind: 'license', id: 'GPL-2.0' });
  });

  it.each([
    '',
    '()',
    'MIT OR',
    'AND MIT',
    '(MIT',
    'MIT)',
    'MIT WITH',
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
    return isSatisfied(expression, (id) => allowed.has(id));
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
    allowedForDevelopment: new Set(['MPL-2.0']),
  };
  const lockfile: Lockfile = {
    lockfileVersion: 3,
    packages: {
      '': { version: '0.0.0', license: 'UNLICENSED' },
      'node_modules/shipped': { version: '1.0.0', license: 'MIT' },
      'node_modules/tool': { version: '1.0.0', license: 'MPL-2.0', dev: true },
      'node_modules/copyleft': { version: '2.0.0', license: 'MPL-2.0' },
      'node_modules/tool/node_modules/@scope/unlabelled': { version: '3.0.0', dev: true },
      'node_modules/custom': { version: '4.0.0', license: 'SEE LICENSE IN LICENSE' },
      'node_modules/local': { link: true },
    },
  };

  it('signale les licences absentes, illisibles ou non admises', () => {
    expect(auditLockfile(lockfile, policy)).toEqual([
      {
        name: 'copyleft',
        version: '2.0.0',
        license: 'MPL-2.0',
        development: false,
        problem: 'forbidden',
      },
      {
        name: '@scope/unlabelled',
        version: '3.0.0',
        license: undefined,
        development: true,
        problem: 'missing',
      },
      {
        name: 'custom',
        version: '4.0.0',
        license: 'SEE LICENSE IN LICENSE',
        development: false,
        problem: 'invalid',
      },
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
