// Configuration d'ESLint.
//
// En plus des règles strictes de typescript-eslint, elle traduit en règles
// vérifiables deux consignes impératives de CLAUDE.md : le déterminisme, et
// l'isolement du code qui s'exécute dans le worker. Ces règles maison sont
// vérifiées par tools/eslint-config.test.ts.

import path from 'node:path';
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

const PRNG = "Non déterministe : tire les nombres d'un flux du PRNG (src/core/rng.ts).";
const DMATH = 'Résultat variable selon les navigateurs : passe par src/core/dmath.ts.';
const CLOCK = "Non déterministe : ce code ne lit pas l'heure.";
const LOCALE = "Dépend de la langue de l'appareil : réserve-le à l'interface.";
const DOM = 'Absent du worker : ce code ne touche pas au DOM.';
const DEVICE =
  "Dépend de l'appareil, de la page ou de l'affichage : le code déterministe n'y touche pas.";
const GLOBAL_OBJECT = 'Écris Math directement, pour que les règles de déterminisme le voient.';

/** Globales interdites au code déterministe, avec la raison de chaque interdiction. */
const restrictedGlobals = [
  { name: 'Date', message: CLOCK },
  { name: 'performance', message: CLOCK },
  { name: 'crypto', message: PRNG },
  { name: 'Intl', message: LOCALE },
  // Globales du DOM, absentes du worker.
  ...['document', 'localStorage', 'sessionStorage', 'window'].map((name) => ({
    name,
    message: DOM,
  })),
  // Globales présentes dans le worker, mais propres à l'appareil, à la page ou à l'affichage.
  ...['indexedDB', 'location', 'navigator', 'requestAnimationFrame'].map((name) => ({
    name,
    message: DEVICE,
  })),
];

/** Les mêmes globales, atteintes par l'objet global : `globalThis.Date`, `self.performance`… */
const globalObjectProperties = ['globalThis', 'self'].flatMap((object) => [
  { object, property: 'Math', message: GLOBAL_OBJECT },
  ...restrictedGlobals.map(({ name, message }) => ({ object, property: name, message })),
]);

/** Dossiers du fil principal, que le code du worker n'importe pas. */
const mainThreadDirectories = ['app', 'render', 'ui'].map((name) =>
  path.join(import.meta.dirname, 'src', name),
);

/** Paquets du fil principal : le rendu et l'interface. */
const mainThreadPackages = /^(pixi\.js|preact)(\/|$)|^@(pixi|preact)\//;

/**
 * Interdit au code du worker d'importer l'orchestration, le rendu ou l'interface,
 * par un import statique ou dynamique, une réexportation ou un `import.meta.glob`.
 * Les chemins sont résolus : `./ui/x`, dossier interne, reste admis, mais pas `../ui/x`.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
const workerBoundaries = {
  meta: {
    type: 'problem',
    docs: { description: 'Isole le code du worker de celui du fil principal.' },
    schema: [],
    messages: {
      package:
        "PixiJS et Preact restent dans src/render et src/ui : ce code doit pouvoir s'exécuter dans le worker.",
      directory:
        "Ce code ne dépend ni de l'orchestration (src/app), ni du rendu (src/render), ni de l'interface (src/ui).",
    },
  },
  create(context) {
    const directory = path.dirname(context.filename);

    /** @param {import('estree').Node | null | undefined} node */
    function check(node) {
      // Pour un gabarit, seul son début est connu : import(`../ui/${name}`).
      let specifier;
      if (node?.type === 'Literal' && typeof node.value === 'string') specifier = node.value;
      else if (node?.type === 'TemplateLiteral') specifier = node.quasis[0]?.value.cooked;
      if (specifier == null) return;
      if (mainThreadPackages.test(specifier)) {
        context.report({ node, messageId: 'package' });
        return;
      }
      // Vite résout les chemins commençant par « / » depuis la racine du projet.
      let target;
      if (specifier.startsWith('/')) target = path.join(import.meta.dirname, specifier);
      else if (specifier.startsWith('.')) target = path.resolve(directory, specifier);
      else return;
      if (
        mainThreadDirectories.some((dir) => target === dir || target.startsWith(dir + path.sep))
      ) {
        context.report({ node, messageId: 'directory' });
      }
    }

    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      'CallExpression[callee.object.type="MetaProperty"][callee.property.name="glob"]': (node) => {
        const [patterns] = node.arguments;
        const list = patterns?.type === 'ArrayExpression' ? patterns.elements : [patterns];
        for (const pattern of list) check(pattern);
      },
    };
  },
};

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
      // Seul assouplissement de strictTypeChecked : les nombres sont admis dans les
      // gabarits. Des options données ici remplacent celles du préréglage, et la règle
      // complète les absentes par ses valeurs par défaut, permissives : d'où la liste.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        {
          allowAny: false,
          allowBoolean: false,
          allowNever: false,
          allowNullish: false,
          allowNumber: true,
          allowRegExp: false,
        },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
  {
    // Les fichiers JavaScript (configuration) ne relèvent d'aucun programme TypeScript.
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    name: 'pixelciv/determinism',
    files: workerSafeFiles,
    // Les tests peuvent comparer les maths déterministes à celles du moteur.
    ignores: ['**/*.test.ts', '**/*.bench.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: PRNG },
        ...approximatedMath.map((property) => ({ object: 'Math', property, message: DMATH })),
        ...localeMethods.map((property) => ({ property, message: LOCALE })),
        ...globalObjectProperties,
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "BinaryExpression[operator='**']", message: DMATH },
        { selector: "AssignmentExpression[operator='**=']", message: DMATH },
      ],
      'no-restricted-globals': ['error', ...restrictedGlobals],
    },
  },
  {
    name: 'pixelciv/boundaries',
    files: workerSafeFiles,
    plugins: { pixelciv: { rules: { 'worker-boundaries': workerBoundaries } } },
    rules: { 'pixelciv/worker-boundaries': 'error' },
  },
  prettier,
);
