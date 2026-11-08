// Vérifie les règles maison d'eslint.config.js : déterminisme et frontières du worker.
//
// En configuration plate, une règle redéclarée dans un bloc ultérieur remplace la
// précédente, options comprises : ces tests signalent toute interdiction perdue.
import { fileURLToPath } from 'node:url';
import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

const cwd = fileURLToPath(new URL('..', import.meta.url));

// Les règles maison se passent des types : le code est lu sans fichier sur disque.
const untyped = new ESLint({ cwd, overrideConfig: tseslint.configs.disableTypeChecked });

async function ruleIds(code: string, filePath: string, eslint = untyped): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.map((message) => message.ruleId ?? `fatal: ${message.message}`);
}

const workerFiles = [
  'src/core/probe.ts',
  'src/sim/probe.ts',
  'src/worldgen/probe.ts',
  'src/gen/probe.ts',
];

describe('déterminisme', () => {
  it.each([
    ['Math.random();', 'no-restricted-properties'],
    ['Math.sin(1);', 'no-restricted-properties'],
    ['Math.pow(2, 3);', 'no-restricted-properties'],
    ["'a'.localeCompare('b');", 'no-restricted-properties'],
    ['globalThis.Math.random();', 'no-restricted-properties'],
    ['globalThis.Date.now();', 'no-restricted-properties'],
    ['self.performance.now();', 'no-restricted-properties'],
    ['const { crypto: c } = self; c.randomUUID();', 'no-restricted-properties'],
    ['export const a = 2 ** 10;', 'no-restricted-syntax'],
    ['let a = 2; a **= 2; export { a };', 'no-restricted-syntax'],
    ['Date.now();', 'no-restricted-globals'],
    ['export const d = new Date();', 'no-restricted-globals'],
    ['performance.now();', 'no-restricted-globals'],
    ['crypto.getRandomValues(new Uint8Array(4));', 'no-restricted-globals'],
    ['export const f = new Intl.NumberFormat();', 'no-restricted-globals'],
    ['export const t = document.title;', 'no-restricted-globals'],
    ['export const l = navigator.language;', 'no-restricted-globals'],
  ])('signale %s', async (code, ruleId) => {
    for (const filePath of workerFiles) {
      expect(await ruleIds(code, filePath), filePath).toEqual([ruleId]);
    }
  });

  it('admet les opérations exactes de Math et les échanges du worker', async () => {
    const code = [
      'export const r = Math.sqrt(2) + Math.floor(1.5) + Math.abs(-1) + Math.round(0.5);',
      'export const m = Math.min(1, 2) + Math.max(1, 2) + Math.imul(2, 3) + Math.fround(0.1);',
      'self.postMessage(r + m);',
    ].join('\n');
    expect(await ruleIds(code, 'src/sim/probe.ts')).toEqual([]);
  });

  it('exempte les tests', async () => {
    const code = 'Math.random(); export const a = 2 ** 10;';
    expect(await ruleIds(code, 'src/sim/probe.test.ts')).toEqual([]);
  });
});

describe('frontières du worker', () => {
  it.each([
    "import 'pixi.js';",
    "import '@pixi/sound';",
    "import 'preact/hooks';",
    "import '@preact/signals';",
    "import '../ui/panel';",
    "import '../render/map';",
    "import '../app/main';",
    "import './../render/map';",
    "import '../core/../ui/panel';",
    "import '/src/ui/panel';",
    "import type { Panel } from '../ui/panel'; export type { Panel };",
    "export * from '../ui/panel';",
    "export { map } from '../render/map';",
    "export const p = import('pixi.js');",
    "export const p = import('../ui/panel');",
    'export const p = (name: string) => import(`../ui/${name}`);',
    "export const p = import.meta.glob('../ui/*.ts');",
    "export const p = import.meta.glob(['./local/*.ts', '../render/*.ts']);",
  ])('signale %s', async (code) => {
    for (const filePath of [...workerFiles, 'src/sim/probe.test.ts']) {
      expect(await ruleIds(code, filePath), filePath).toEqual(['pixelciv/worker-boundaries']);
    }
  });

  it.each([
    "import './ui/panel';",
    "import './rendering';",
    "import '../core/app-state';",
    "import '../gen/portrait/render';",
    "import 'pixi-sans-rapport';",
    "export const p = import('./local');",
  ])('admet %s', async (code) => {
    expect(await ruleIds(code, 'src/sim/probe.ts')).toEqual([]);
  });

  it('signale les sous-dossiers selon leur profondeur', async () => {
    expect(await ruleIds("import '../../ui/panel';", 'src/sim/sub/probe.ts')).toEqual([
      'pixelciv/worker-boundaries',
    ]);
    expect(await ruleIds("import '../ui/panel';", 'src/sim/sub/probe.ts')).toEqual([]);
  });
});

it("ne restreint ni l'interface ni le rendu", async () => {
  const code = "import 'pixi.js'; Math.random(); export const a = 2 ** 10;";
  expect(await ruleIds(code, 'src/ui/probe.ts')).toEqual([]);
  expect(await ruleIds(code, 'src/render/probe.ts')).toEqual([]);
});

describe('réglages généraux', () => {
  const typed = new ESLint({ cwd });

  it('garde strictes les options de restrict-template-expressions', async () => {
    const config = (await typed.calculateConfigForFile('src/ui/probe.ts')) as Linter.Config;
    expect(config.rules?.['@typescript-eslint/restrict-template-expressions']).toEqual([
      2,
      {
        allowAny: false,
        allowBoolean: false,
        allowNever: false,
        allowNullish: false,
        allowNumber: true,
        allowRegExp: false,
      },
    ]);
  });

  it.each(['probe.config.js', 'probe.config.mjs', 'tools/probe.cjs'])(
    "lit %s sans l'analyse typée",
    async (filePath) => {
      expect(await ruleIds('export const value = 1;\n', filePath, typed)).toEqual([]);
    },
  );
});
