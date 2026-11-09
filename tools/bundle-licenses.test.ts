import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';
import {
  auditBundle,
  bundleLicenses,
  licenseNotice,
  licenseText,
  missingCredits,
  packageOfModule,
  readPackage,
  repositoryLink,
  type PackageInfo,
} from './bundle-licenses';

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
  // Manifeste d'un sous-dossier, comme preact/hooks : il ne désigne pas un paquet.
  '/repo/node_modules/plain/hooks/package.json': {
    name: 'plain-hooks',
    version: '0.1.0',
    license: 'GPL-3.0-only',
  },
};
const read = (file: string): PackageInfo | undefined => packages[file];

const root = mkdtempSync(path.join(tmpdir(), 'pixelciv-licences-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Écrit des fichiers dans un nouveau dossier temporaire et renvoie ce dossier. */
function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(root, 'cas-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

describe('packageOfModule', () => {
  it('rattache un module au dossier de son paquet, à portée ou non', () => {
    expect(packageOfModule('/repo/node_modules/plain/dist/esm/index.js', read)?.name).toBe('plain');
    expect(packageOfModule('/repo/node_modules/@scope/lib/index.js?commonjs', read)?.name).toBe(
      '@scope/lib',
    );
    expect(packageOfModule('/repo/node_modules/plain/node_modules/inner/a.js', read)).toEqual({
      ...packages['/repo/node_modules/plain/node_modules/inner/package.json'],
      directory: '/repo/node_modules/plain/node_modules/inner',
    });
  });

  it('ignore les package.json des sous-dossiers', () => {
    expect(packageOfModule('/repo/node_modules/plain/hooks/dist/hooks.js', read)?.name).toBe(
      'plain',
    );
  });

  it('garde le nom du dossier, sans licence, pour un paquet sans package.json', () => {
    expect(packageOfModule('/repo/node_modules/ghost/index.js', read)).toEqual({
      name: 'ghost',
      version: '?',
      license: undefined,
      directory: '/repo/node_modules/ghost',
    });
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
        '/repo/node_modules/plain/hooks/dist/hooks.js',
        '/repo/node_modules/ghost/index.js',
      ],
      read,
    );
    expect(issues.map((issue) => [issue.name, issue.problem])).toEqual([
      ['lightningcss', 'forbidden'],
      ['inner', 'missing'],
      ['ghost', 'missing'],
    ]);
  });
});

describe('repositoryLink et readPackage', () => {
  it('ramène les formes de package.json à une adresse web', () => {
    expect(repositoryLink('omgovich/colord')).toBe('https://github.com/omgovich/colord');
    expect(repositoryLink('github:preactjs/preact')).toBe('https://github.com/preactjs/preact');
    expect(repositoryLink({ type: 'git', url: 'git+https://github.com/colinhacks/zod.git' })).toBe(
      'https://github.com/colinhacks/zod',
    );
    expect(repositoryLink('git://github.com/mapbox/earcut.git')).toBe(
      'https://github.com/mapbox/earcut',
    );
    expect(repositoryLink('git@github.com:owner/repo.git')).toBe('https://github.com/owner/repo');
    expect(repositoryLink({ type: 'git' })).toBeUndefined();
    expect(repositoryLink(undefined)).toBeUndefined();
  });

  it('préfère le site du paquet à son dépôt', () => {
    const dir = folder({
      'site/package.json': JSON.stringify({
        name: 'site',
        version: '1.0.0',
        license: 'MIT',
        homepage: 'https://example.org',
        repository: 'owner/site',
      }),
      'repo/package.json': JSON.stringify({ name: 'repo', repository: 'owner/repo' }),
      'anonymous/package.json': JSON.stringify({ type: 'module' }),
    });
    expect(readPackage(path.join(dir, 'site/package.json'))).toEqual({
      name: 'site',
      version: '1.0.0',
      license: 'MIT',
      link: 'https://example.org',
    });
    expect(readPackage(path.join(dir, 'repo/package.json'))).toEqual({
      name: 'repo',
      version: '?',
      license: undefined,
      link: 'https://github.com/owner/repo',
    });
    expect(readPackage(path.join(dir, 'anonymous/package.json'))).toBeUndefined();
    expect(readPackage(path.join(dir, 'absent/package.json'))).toBeUndefined();
  });
});

describe('missingCredits', () => {
  it('relève, une fois chacun et triés, les paquets que les crédits ne citent pas', () => {
    const credits = '| `zod` | MIT |\nPixiJS, sans accents graves.';
    const listed = [
      { name: 'zod', version: '4.0.0', license: 'MIT' },
      { name: 'pixi.js', version: '8.0.0', license: 'MIT' },
      { name: 'earcut', version: '3.0.0', license: 'ISC' },
      { name: 'earcut', version: '2.0.0', license: 'ISC' },
    ];
    expect(missingCredits(listed, credits)).toEqual(['earcut', 'pixi.js']);
  });
});

describe('licenseText et licenseNotice', () => {
  it('lit le fichier de licence du paquet, sous ses divers noms', () => {
    const dir = folder({
      'a/LICENSE.md': '  Licence A\n',
      'a/README.md': 'pas une licence',
      'b/licence': 'Licence B',
      'c/COPYING': 'Licence C',
      'd/index.js': '',
    });
    expect(licenseText(path.join(dir, 'a'))).toBe('Licence A');
    expect(licenseText(path.join(dir, 'b'))).toBe('Licence B');
    expect(licenseText(path.join(dir, 'c'))).toBe('Licence C');
    expect(licenseText(path.join(dir, 'd'))).toBeUndefined();
    expect(licenseText(path.join(dir, 'absent'))).toBeUndefined();
  });

  it('liste les paquets dans un ordre stable, avec leur texte ou à défaut leur licence', () => {
    const texts: Record<string, string> = { '/nm/zod': 'MIT License\nCopyright (c) Zod' };
    const notice = licenseNotice(
      [
        {
          name: 'zod',
          version: '4.0.0',
          license: 'MIT',
          link: 'https://zod.dev',
          directory: '/nm/zod',
        },
        { name: '@pixi/colord', version: '2.9.6', license: 'MIT', directory: '/nm/colord' },
      ],
      (directory) => texts[directory],
    );
    expect(notice.indexOf('@pixi/colord 2.9.6 (MIT)')).toBeLessThan(notice.indexOf('zod 4.0.0'));
    expect(notice).toContain('zod 4.0.0 (MIT)\nhttps://zod.dev\n');
    expect(notice).toContain('MIT License\nCopyright (c) Zod');
    expect(notice).toContain('Ce paquet ne fournit pas de texte de licence.');
  });
});

describe('bundleLicenses', () => {
  const MIT_TEXT = 'MIT License\n\nCopyright (c) 2026 Fake Author';

  /**
   * Projet minimal : une page, un module, un paquet, et un worker avec son paquet.
   * `credits: null` omet le fichier des crédits.
   */
  function project(options: { license?: string; credits?: string | null }): string {
    const { license = 'MIT', credits = '| `fake-lib` |\n| `worker-lib` |\n' } = options;
    // De vraies fonctions : une simple constante serait inlinée, sans code du paquet.
    const lib = (name: string) =>
      `export function ${name}(items) {\n  return items.map((item) => item.toUpperCase()).join(", ");\n}\n`;
    return folder({
      'node_modules/fake-lib/package.json': JSON.stringify({
        name: 'fake-lib',
        version: '1.2.3',
        license,
        main: 'index.js',
        repository: 'owner/fake-lib',
      }),
      'node_modules/fake-lib/index.js': lib('shout'),
      'node_modules/fake-lib/LICENSE': MIT_TEXT,
      'node_modules/worker-lib/package.json': JSON.stringify({
        name: 'worker-lib',
        version: '0.1.0',
        license: 'ISC',
        main: 'index.js',
      }),
      'node_modules/worker-lib/index.js': lib('whisper'),
      'index.html': '<!doctype html><script type="module" src="./main.js"></script>\n',
      'main.js':
        "import { shout } from 'fake-lib';\n" +
        "document.title = shout(location.hash.split('#'));\n" +
        "new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });\n",
      'worker.js':
        "import { whisper } from 'worker-lib';\n" +
        'self.onmessage = (event) => self.postMessage(whisper(event.data));\n',
      ...(credits === null ? {} : { 'CREDITS.md': credits }),
    });
  }

  async function buildProject(dir: string): Promise<Map<string, string>> {
    const licenses = bundleLicenses();
    const result = await build({
      root: dir,
      configFile: false,
      logLevel: 'silent',
      build: { write: false },
      plugins: [licenses.main],
      worker: { format: 'es', plugins: () => [licenses.worker()] },
    });
    const outputs = Array.isArray(result) ? result : [result];
    const files = new Map<string, string>();
    for (const output of outputs) {
      if (!('output' in output)) continue;
      for (const file of output.output) {
        if (file.type === 'asset' && typeof file.source === 'string') {
          files.set(file.fileName, file.source);
        }
      }
    }
    return files;
  }

  it('joint au jeu les licences des paquets du bundle principal et du worker', async () => {
    const files = await buildProject(project({}));
    const notice = files.get('licenses.txt');
    expect(notice?.startsWith('\uFEFFPixelCiv distribue')).toBe(true);
    expect(notice).toContain('fake-lib 1.2.3 (MIT)\nhttps://github.com/owner/fake-lib\n');
    expect(notice).toContain(MIT_TEXT);
    expect(notice).toContain('worker-lib 0.1.0 (ISC)');
  });

  it('fait échouer le build pour un paquet distribué sous une autre licence', async () => {
    await expect(buildProject(project({ license: 'MPL-2.0' }))).rejects.toThrow(
      /fake-lib@1\.2\.3 \(MPL-2\.0\)/,
    );
  });

  it('fait échouer le build si les crédits omettent un paquet, fût-il du seul worker', async () => {
    await expect(buildProject(project({ credits: '| `fake-lib` |\n' }))).rejects.toThrow(
      /absents de CREDITS\.md \(AST-02\) : worker-lib\./,
    );
  });

  it('fait échouer le build sans fichier des crédits', async () => {
    await expect(buildProject(project({ credits: null }))).rejects.toThrow(/crédits introuvable/);
  });
});
