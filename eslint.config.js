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

/** Toutes les extensions de source que Vite regroupe, JavaScript compris. */
const SOURCES = '{ts,tsx,mts,cts,js,mjs,cjs}';

/**
 * Code partagé, simulation, génération du monde et générateurs : il doit être
 * déterministe (ADR 0003) et pouvoir s'exécuter dans le worker.
 */
const deterministicFiles = ['core', 'sim', 'worldgen', 'gen'].map(
  (directory) => `src/${directory}/**/*.${SOURCES}`,
);

/**
 * Tout le code exécuté dans le worker : le code déterministe, plus l'hôte de la
 * simulation (src/worker), qui lit l'horloge pour cadencer les pas (ADR 0004).
 */
const workerFiles = [...deterministicFiles, `src/worker/**/*.${SOURCES}`];

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
const TEXT = "Texte affiché en dur : passe par t('clé') et ajoute la clé dans src/i18n/fr.json.";

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

/** Objets globaux que le code déterministe n'emploie que devant une propriété : `Math.sqrt`. */
const globalObjects = new Set(['Math', 'globalThis', 'self']);

/**
 * N'admet Math, globalThis et self que comme objet direct d'un accès à une propriété.
 * Un alias (`const M = Math`), un passage en argument ou un détour (`globalThis.self`)
 * échapperaient aux interdictions de propriétés, qui ne lisent que l'accès direct.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
const directGlobals = {
  meta: {
    type: 'problem',
    docs: { description: "N'admet Math, globalThis et self que devant une propriété." },
    schema: [],
    messages: {
      indirect:
        'Écris {{name}}.propriété directement : un alias ou un détour échappe aux règles de déterminisme.',
    },
  },
  create(context) {
    return {
      Program(program) {
        const scope = context.sourceCode.getScope(program);
        // Références aux globales : non résolues, ou résolues vers une globale déclarée.
        const references = [...scope.through];
        for (const name of globalObjects) {
          const variable = scope.set.get(name);
          if (variable !== undefined && variable.defs.length === 0) {
            references.push(...variable.references);
          }
        }
        for (const reference of references) {
          const { identifier } = reference;
          if (!globalObjects.has(identifier.name)) continue;
          // Le type Math (`(m: Math) => …`) ne donne accès à rien.
          if ('isValueReference' in reference && reference.isValueReference === false) continue;
          const parent = /** @type {import('estree').Node & { parent?: import('estree').Node }} */ (
            identifier
          ).parent;
          const direct = parent?.type === 'MemberExpression' && parent.object === identifier;
          // globalThis.self, self.globalThis : l'objet global atteint par un détour.
          const detour =
            direct &&
            parent.property.type === 'Identifier' &&
            !parent.computed &&
            parent.property.name !== 'Math' &&
            globalObjects.has(parent.property.name);
          if (!direct || detour) {
            context.report({
              node: identifier,
              messageId: 'indirect',
              data: { name: identifier.name },
            });
          }
        }
      },
    };
  },
};

/** Attributs dont la valeur s'affiche, ou se lit à voix haute. */
const textAttributes = new Set([
  'alt',
  'aria-description',
  'aria-label',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'label',
  'placeholder',
  'title',
]);

/** Nœuds qui transmettent une chaîne sans la transformer : `a ? 'x' : 'y'`, `a ?? 'x'`… */
const passThrough = new Set([
  'ConditionalExpression',
  'LogicalExpression',
  'TemplateLiteral',
  'TSAsExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
]);

const LETTER = /\p{L}/u;

/**
 * Refuse le texte affiché en dur dans le JSX (CLAUDE.md, « Textes ») : texte entre
 * les balises, chaîne ou gabarit rendus tels quels, directement ou par une condition
 * (`{a ? 'Oui' : 'Non'}`), et valeur des attributs lus par l'utilisateur. Les chaînes
 * sans lettre (`·`, `alt=""`) et les attributs techniques (`class`, `type`) restent admis.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
const hardcodedText = {
  meta: {
    type: 'problem',
    docs: { description: "Refuse le texte affiché en dur : il passe par t('clé')." },
    schema: [],
    messages: { text: TEXT },
  },
  create(context) {
    /** @param {import('estree').Node} node La chaîne finit-elle à l'écran ? */
    function displayed(node) {
      /** @type {any} */
      let current = node;
      let parent = current.parent;
      while (parent != null && passThrough.has(parent.type)) {
        if (parent.type === 'ConditionalExpression' && parent.test === current) return false;
        current = parent;
        parent = parent.parent;
      }
      if (parent?.type === 'JSXExpressionContainer') {
        current = parent;
        parent = parent.parent;
        if (parent?.type === 'JSXElement' || parent?.type === 'JSXFragment') return true;
      }
      return (
        parent?.type === 'JSXAttribute' &&
        parent.value === current &&
        parent.name.type === 'JSXIdentifier' &&
        textAttributes.has(parent.name.name)
      );
    }

    return {
      JSXText(node) {
        if (LETTER.test(node.value)) context.report({ node, messageId: 'text' });
      },
      Literal(node) {
        if (typeof node.value === 'string' && LETTER.test(node.value) && displayed(node)) {
          context.report({ node, messageId: 'text' });
        }
      },
      TemplateLiteral(node) {
        const text = node.quasis.some((quasi) =>
          LETTER.test(quasi.value.cooked ?? quasi.value.raw),
        );
        if (text && displayed(node)) context.report({ node, messageId: 'text' });
      },
    };
  },
};

/** Racine du projet : Vite y résout les chemins qui commencent par « / ». */
const ROOT = import.meta.dirname;

/** Dossiers du fil principal, que le code du worker n'importe pas. */
const mainThreadDirectories = ['app', 'render', 'ui'].map((name) => path.join(ROOT, 'src', name));

/** Paquets du fil principal : le rendu et l'interface. */
const mainThreadPackages = /^(pixi\.js|preact)(\/|$)|^@(pixi|preact)\//;

/** Débuts possibles de leurs noms, pour un chemin dont seul le début est connu. */
const mainThreadPackagePrefixes = ['pixi.js', 'preact', '@pixi/', '@preact/'];

/** Caractères spéciaux des motifs de glob. */
const GLOB_SYNTAX = /[*?[\]{}()!]/;

/**
 * Début connu d'un chemin d'import, et s'il se prolonge par une partie inconnue :
 * expression d'un gabarit, concaténation ou motif de glob. `undefined` si rien n'en
 * est connu, comme pour `import(name)`.
 *
 * @param {any} node
 * @param {boolean} glob
 * @returns {{ text: string, open: boolean } | undefined}
 */
function specifierOf(node, glob) {
  /** @param {string} text */
  const cut = (text) => {
    const index = glob ? text.search(GLOB_SYNTAX) : -1;
    return index === -1 ? undefined : { text: text.slice(0, index), open: true };
  };
  if (node?.type === 'Literal' && typeof node.value === 'string') {
    return cut(node.value) ?? { text: node.value, open: false };
  }
  if (node?.type === 'TemplateLiteral') {
    /** @type {string} */
    const head = node.quasis[0]?.value.cooked ?? '';
    return cut(head) ?? { text: head, open: node.expressions.length > 0 };
  }
  if (node?.type === 'BinaryExpression' && node.operator === '+') {
    const left = specifierOf(node.left, glob);
    return left === undefined ? undefined : { text: left.text, open: true };
  }
  return undefined;
}

/**
 * Le paquet nommé, ou l'un de ceux qu'un nom commencé pourrait désigner, est-il du
 * fil principal ?
 *
 * @param {string} name
 * @param {boolean} open
 */
function isMainThreadPackage(name, open) {
  if (mainThreadPackages.test(name)) return true;
  return open && mainThreadPackagePrefixes.some((prefix) => prefix.startsWith(name));
}

/**
 * Le chemin, ou l'un de ceux qu'un chemin commencé pourrait désigner, mène-t-il au code
 * du fil principal, dans src ou dans node_modules ?
 *
 * @param {string} target chemin absolu
 * @param {boolean} open
 */
function reachesMainThread(target, open) {
  const inside = (/** @type {string} */ directory) =>
    target === directory || target.startsWith(directory + path.sep);
  if (
    mainThreadDirectories.some(
      (directory) => inside(directory) || (open && directory.startsWith(target)),
    )
  ) {
    return true;
  }
  const modules = path.join(ROOT, 'node_modules') + path.sep;
  if (target.startsWith(modules)) {
    return isMainThreadPackage(target.slice(modules.length).split(path.sep).join('/'), open);
  }
  return open && modules.startsWith(target + path.sep);
}

/**
 * Interdit au code du worker d'importer l'orchestration, le rendu ou l'interface,
 * par un import statique ou dynamique, une réexportation ou un `import.meta.glob`.
 * Les chemins sont résolus : `./ui/x`, dossier interne, reste admis, mais pas `../ui/x`.
 * Pour un chemin dont seul le début est connu (gabarit, concaténation, glob), tout ce
 * qu'il pourrait désigner compte ; un import dynamique au chemin inconnu est refusé.
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
      opaque:
        "Chemin d'import inconnu : écris-le en clair, pour que la frontière du worker puisse être vérifiée.",
    },
  },
  create(context) {
    const directory = path.dirname(context.filename);

    /**
     * @param {any} node
     * @param {boolean} [glob]
     */
    function check(node, glob = false) {
      // Un motif négatif de glob retire des fichiers, il n'en ajoute pas.
      if (glob && node?.type === 'Literal' && String(node.value).startsWith('!')) return;
      const specifier = specifierOf(node, glob);
      if (specifier === undefined) {
        context.report({ node, messageId: 'opaque' });
        return;
      }
      const { text, open } = specifier;
      if (text.startsWith('/') || text.startsWith('.')) {
        const target = text.startsWith('/') ? path.join(ROOT, text) : path.resolve(directory, text);
        if (reachesMainThread(target, open)) context.report({ node, messageId: 'directory' });
      } else if (isMainThreadPackage(text, open)) {
        context.report({ node, messageId: 'package' });
      }
    }

    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => {
        if (node.source != null) check(node.source);
      },
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      'CallExpression[callee.object.type="MetaProperty"][callee.property.name="glob"]': (node) => {
        const [patterns] = node.arguments;
        const list = patterns?.type === 'ArrayExpression' ? patterns.elements : [patterns];
        for (const pattern of list) check(pattern, true);
      },
    };
  },
};

/** Règles maison, déclarées une seule fois pour tous les blocs qui s'en servent. */
const pixelciv = {
  rules: {
    'direct-globals': directGlobals,
    'no-hardcoded-text': hardcodedText,
    'worker-boundaries': workerBoundaries,
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
    files: deterministicFiles,
    // Les tests peuvent comparer les maths déterministes à celles du moteur.
    ignores: ['**/*.test.*', '**/*.bench.*'],
    plugins: { pixelciv },
    rules: {
      'pixelciv/direct-globals': 'error',
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
    // Aucun texte affiché en dur dans l'interface (CLAUDE.md, « Textes »).
    name: 'pixelciv/texts',
    files: ['src/**/*.{tsx,jsx}'],
    plugins: { pixelciv },
    rules: { 'pixelciv/no-hardcoded-text': 'error' },
  },
  {
    name: 'pixelciv/boundaries',
    files: workerFiles,
    plugins: { pixelciv },
    rules: { 'pixelciv/worker-boundaries': 'error' },
  },
  prettier,
);
