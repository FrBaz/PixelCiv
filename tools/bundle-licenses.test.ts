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
  stylesheetPackages,
  stylesheetReferences,
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

describe('feuilles de style', () => {
  it('relève les @import et les url(), hors commentaires', () => {
    const css = [
      "@import 'reset.css';",
      '@import url("./base.css") screen;',
      "/* @import 'commente.css'; */",
      ".a { background: url(./img/a.png); font: url( '@fontsource/x/a.woff2' ); }",
      '.b { mask: url(data:image/svg+xml;utf8,<svg/>); }',
    ].join('\n');
    expect(stylesheetReferences(css)).toEqual([
      'reset.css',
      './base.css',
      './img/a.png',
      '@fontsource/x/a.woff2',
      'data:image/svg+xml;utf8,<svg/>',
    ]);
  });

  it('lit aussi image-set() et les chemins entre guillemets qui ont des espaces', () => {
    const css = [
      '.a { background-image: image-set(\'fake-lib/a.png\' 1x, url("b c.png") 2x); }',
      '.b { background-image: -webkit-image-set("fake-lib/b.png" 1x); }',
      "@import url('mes styles.css') layer(base);",
    ].join('\n');
    expect(stylesheetReferences(css)).toEqual([
      'mes styles.css',
      'b c.png',
      'fake-lib/a.png',
      'fake-lib/b.png',
    ]);
  });

  it("résout comme Vite : relatif d'abord, même sans « ./ », puis paquet", () => {
    const dir = folder({
      'src/style.css': '',
      'src/local.css': "@import 'fake-lib/reset.css';",
      'src/img/a.png': '',
      'src/fake-lib/notes.txt': '',
      'node_modules/fake-lib/package.json': JSON.stringify({
        name: 'fake-lib',
        version: '1.0.0',
        license: 'MIT',
      }),
      'node_modules/fake-lib/reset.css': "@import '@scope/deep/base.css';",
      'node_modules/@scope/deep/package.json': JSON.stringify({
        name: '@scope/deep',
        version: '2.0.0',
        license: 'ISC',
      }),
      'node_modules/@scope/deep/base.css': 'html { margin: 0; }',
      'node_modules/normalize.css/package.json': JSON.stringify({
        name: 'normalize.css',
        version: '8.0.1',
        license: 'MIT',
        style: 'normalize.css',
      }),
      'node_modules/normalize.css/normalize.css': 'html { line-height: 1.15; }',
      'node_modules/fonts/package.json': JSON.stringify({
        name: 'fonts',
        version: '3.0.0',
        license: 'MIT',
      }),
    });
    const importer = path.join(dir, 'src/style.css');
    const names = (css: string) =>
      [...new Set(stylesheetPackages(css, importer, dir).map((info) => info.name))].sort();
    // Chemins nus qui désignent des fichiers du projet : aucun paquet.
    expect(names("@import 'img/../img/a.png'; .a { background: url(img/a.png); }")).toEqual([]);
    // Une chaîne d'@import, du projet vers un paquet, puis vers un autre.
    expect(names("@import 'local.css';")).toEqual(['@scope/deep', 'fake-lib']);
    expect(names("@font-face { src: url('~fonts/x.woff2'); }")).toEqual(['fonts']);
    expect(names(".a { background: image-set('fake-lib/a.png' 1x); }")).toEqual(['fake-lib']);
    // Un paquet nommé comme une feuille de style est un dossier : il est relevé, pas lu.
    expect(names("@import 'normalize.css';")).toEqual(['normalize.css']);
    // Sans extension, comme Vite : « local » désigne local.css, « fake-lib/reset » reset.css.
    expect(names("@import 'local';")).toEqual(['@scope/deep', 'fake-lib']);
    expect(names("@import 'fake-lib/reset';")).toEqual(['@scope/deep', 'fake-lib']);
    expect(names('@import url(https://example.org/a.css); .b { mask: url(#m); }')).toEqual([]);
    // Un dossier du projet homonyme d'un paquet ne cache pas le paquet, même nommé seul.
    expect(names("@import 'fake-lib/reset.css';")).toEqual(['@scope/deep', 'fake-lib']);
    expect(names("@import 'fake-lib';")).toEqual(['fake-lib']);
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

  it('contrôle les paquets que tirent les feuilles de style, de proche en proche', async () => {
    const chain = (credits: string, license = 'MIT') => {
      const dir = project({ credits, license });
      writeFileSync(path.join(dir, 'style.css'), "@import 'b.css';\nbody { margin: 0; }\n");
      writeFileSync(path.join(dir, 'b.css'), "@import 'fake-lib/reset.css';\n");
      writeFileSync(path.join(dir, 'node_modules/fake-lib/reset.css'), 'html { color: red; }\n');
      writeFileSync(path.join(dir, 'main.js'), "import './style.css';\n");
      return dir;
    };
    const notice = (await buildProject(chain('| `fake-lib` |\n'))).get('licenses.txt');
    expect(notice).toContain('fake-lib 1.2.3 (MIT)');
    await expect(buildProject(chain(''))).rejects.toThrow(/absents de CREDITS\.md.*fake-lib/);
    await expect(buildProject(chain('| `fake-lib` |\n', 'MPL-2.0'))).rejects.toThrow(
      /fake-lib@1\.2\.3 \(MPL-2\.0\)/,
    );
  });

  it('contrôle aussi les styles de index.html', async () => {
    const dir = project({ credits: '' });
    writeFileSync(path.join(dir, 'node_modules/fake-lib/reset.css'), 'html { color: red; }\n');
    writeFileSync(
      path.join(dir, 'index.html'),
      '<!doctype html><style>@import \'fake-lib/reset.css\';</style><script type="module" src="./main.js"></script>\n',
    );
    writeFileSync(path.join(dir, 'main.js'), 'document.title = "x";\n');
    await expect(buildProject(dir)).rejects.toThrow(/absents de CREDITS\.md.*fake-lib/);
  });

  it('admet les chemins nus vers les fichiers du projet', async () => {
    const dir = project({ credits: '' });
    mkdirSync(path.join(dir, 'img'));
    writeFileSync(path.join(dir, 'img/a.png'), 'png');
    writeFileSync(path.join(dir, 'local.css'), 'p { color: blue; }\n');
    writeFileSync(
      path.join(dir, 'style.css'),
      "@import 'local.css';\nbody { background: url(img/a.png); }\n",
    );
    writeFileSync(path.join(dir, 'main.js'), "import './style.css';\n");
    await expect(buildProject(dir)).resolves.toBeDefined();
  });

  it("voit la feuille de style d'un paquet importée depuis le JS", async () => {
    const dir = project({ credits: '| `fake-lib` |\n' });
    writeFileSync(path.join(dir, 'node_modules/fake-lib/reset.css'), 'html { color: red; }\n');
    writeFileSync(path.join(dir, 'main.js'), "import 'fake-lib/reset.css';\n");
    const notice = (await buildProject(dir)).get('licenses.txt');
    expect(notice).toContain('fake-lib 1.2.3 (MIT)');
    expect(notice).not.toContain('worker-lib');
  });

  it('fait échouer le build sans fichier des crédits', async () => {
    await expect(buildProject(project({ credits: null }))).rejects.toThrow(/crédits introuvable/);
  });
});
