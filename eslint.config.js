// Configuration d'ESLint.
//
// En plus des règles strictes de typescript-eslint, elle traduit en règles
// vérifiables deux consignes impératives de CLAUDE.md : le déterminisme, et
// l'isolement du code qui s'exécute dans le worker.

import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import tseslint from 'typescript-eslint';

/**
 * Code partagé, simulation, génération du monde et générateurs : il doit être
 * déterministe et pouvoir s'exécuter dans le worker.
 */
const workerSafeFiles = [
  'src/core/**/*.ts',
  'src/sim/**/*.ts',
  'src/worldgen/**/*.ts',
  'src/gen/**/*.ts',
];

/** Fonctions de Math que la norme laisse approcher par chaque moteur. */
const approximatedMath = [
  'acos',
  'acosh',
  'asin',
  'asinh',
  'atan',
  'atan2',
  'atanh',
  'cbrt',
  'cos',
  'cosh',
  'exp',
  'expm1',
  'hypot',
  'log',
  'log10',
  'log1p',
  'log2',
  'pow',
  'sin',
  'sinh',
  'tan',
  'tanh',
];

/** Méthodes dont le résultat dépend de la langue de l'appareil. */
const localeMethods = [
  'localeCompare',
  'toLocaleDateString',
  'toLocaleLowerCase',
  'toLocaleString',
  'toLocaleTimeString',
  'toLocaleUpperCase',
];

/** Globales du navigateur, absentes du worker ou de Node. */
const browserGlobals = [
  'document',
  'indexedDB',
  'localStorage',
  'location',
  'navigator',
  'requestAnimationFrame',
  'sessionStorage',
  'window',
];

const PRNG = "Non déterministe : tire les nombres d'un flux du PRNG (src/core/rng.ts).";
const DMATH = 'Résultat variable selon les navigateurs : passe par src/core/dmath.ts.';
const CLOCK = "Non déterministe : ce code ne lit pas l'heure.";
const LOCALE = "Dépend de la langue de l'appareil : réserve-le à l'interface.";
const BROWSER = 'Indisponible dans le worker et sous Node : ce code ne touche pas au DOM.';

export default defineConfig(
  globalIgnores(['dist/', 'coverage/', 'prototypes/', 'assets/']),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      eqeqeq: ['error', 'smart'],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
  {
    // Les fichiers JavaScript (configuration) ne relèvent d'aucun programme TypeScript.
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    name: 'pixelciv/determinisme',
    files: workerSafeFiles,
    // Les tests peuvent comparer les maths déterministes à celles du moteur.
    ignores: ['**/*.test.ts', '**/*.bench.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: PRNG },
        ...approximatedMath.map((property) => ({ object: 'Math', property, message: DMATH })),
        ...localeMethods.map((property) => ({ property, message: LOCALE })),
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "BinaryExpression[operator='**']", message: DMATH },
        { selector: "AssignmentExpression[operator='**=']", message: DMATH },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: CLOCK },
        { name: 'performance', message: CLOCK },
        { name: 'crypto', message: PRNG },
        { name: 'Intl', message: LOCALE },
        ...browserGlobals.map((name) => ({ name, message: BROWSER })),
      ],
    },
  },
  {
    name: 'pixelciv/frontieres',
    files: workerSafeFiles,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['pixi.js', 'pixi.js/*', '@pixi/*', 'preact', 'preact/*', '@preact/*'],
              message:
                "PixiJS et Preact restent dans src/render et src/ui : ce code doit pouvoir s'exécuter dans le worker.",
            },
            {
              regex: String.raw`^\.{1,2}/(.*/)?(app|render|ui)(/|$)`,
              message:
                "Ce code ne dépend ni de l'orchestration (src/app), ni du rendu (src/render), ni de l'interface (src/ui).",
            },
          ],
        },
      ],
    },
  },
  prettier,
);
