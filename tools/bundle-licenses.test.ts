import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';
import { auditBundle, bundleLicenses, packageOfModule, type PackageInfo } from './bundle-licenses';

const packages: Record<string, PackageInfo> = {
  '/repo/node_modules/plain/package.json': { name: 'plain', version: '1.0.0', license: 'MIT' },
  '/repo/node_modules/@scope/lib/package.json': {
    name: '@scope/lib',
    version: '2.0.0',
    license: 'Apache-2.0',
  },
  '/repo/node_modules/lightningcss/package.json': {
    name: 'lightningcss',
    version: '1.0.0',
    license: 'MPL-2.0',
  },
  '/repo/node_modules/plain/node_modules/inner/package.json': {
    name: 'inner',
    version: '3.0.0',
    license: undefined,
  },
};
const read = (file: string): PackageInfo | undefined => packages[file];

describe('packageOfModule', () => {
  it('remonte au package.json nommé le plus proche', () => {
    expect(packageOfModule('/repo/node_modules/plain/dist/esm/index.js', read)?.name).toBe('plain');
    expect(packageOfModule('/repo/node_modules/@scope/lib/index.js?commonjs', read)?.name).toBe(
      '@scope/lib',
    );
    expect(packageOfModule('/repo/node_modules/plain/node_modules/inner/a.js', read)?.name).toBe(
      'inner',
    );
  });

  it('ignore le code du projet et les modules virtuels', () => {
    expect(packageOfModule('/repo/src/app/main.ts', read)).toBeUndefined();
    expect(packageOfModule('\0vite/modulepreload-polyfill.js', read)).toBeUndefined();
  });
});

describe('auditBundle', () => {
  it("refuse les licences non admises, sans exception d'outil, une fois par paquet", () => {
    const issues = auditBundle(
      [
        '/repo/node_modules/plain/index.js',
        '/repo/node_modules/@scope/lib/index.js',
        '/repo/node_modules/lightningcss/index.js',
        '/repo/node_modules/lightningcss/other.js',
        '/repo/node_modules/plain/node_modules/inner/a.js',
      ],
      read,
    );
    expect(issues.map((issue) => [issue.name, issue.problem])).toEqual([
      ['lightningcss', 'forbidden'],
      ['inner', 'missing'],
    ]);
  });
});

describe('bundleLicenses', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pixelciv-licences-'));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function fixture(license: string): string {
    const dir = mkdtempSync(path.join(root, 'cas-'));
    const pkg = path.join(dir, 'node_modules', 'fake-lib');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({ name: 'fake-lib', version: '1.2.3', license, main: 'index.js' }),
    );
    // Une vraie fonction : une simple constante serait inlinée, sans code du paquet.
    writeFileSync(
      path.join(pkg, 'index.js'),
      'export function shout(items) {\n  return items.map((item) => item.toUpperCase()).join(", ");\n}\n',
    );
    writeFileSync(
      path.join(dir, 'index.html'),
      '<!doctype html><script type="module" src="./main.js"></script>\n',
    );
    writeFileSync(
      path.join(dir, 'main.js'),
      "import { shout } from 'fake-lib';\ndocument.title = shout(location.hash.split('#'));\n",
    );
    return dir;
  }

  const buildFixture = (dir: string) =>
    build({
      root: dir,
      configFile: false,
      logLevel: 'silent',
      build: { write: false },
      plugins: [bundleLicenses()],
    });

  it('laisse passer un paquet sous licence admise', async () => {
    await expect(buildFixture(fixture('MIT'))).resolves.toBeDefined();
  });

  it('fait échouer le build pour un paquet distribué sous une autre licence', async () => {
    await expect(buildFixture(fixture('MPL-2.0'))).rejects.toThrow(/fake-lib@1\.2\.3 \(MPL-2\.0\)/);
  });
});
