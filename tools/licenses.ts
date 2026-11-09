/**
 * Vérification des licences des dépendances (PRD, AST-05).
 *
 * Le fichier de verrouillage de npm donne la licence de chaque paquet installé.
 * Tout paquet doit être sous une licence permissive, compatible avec une sortie
 * commerciale. Le drapeau `dev` n'y change rien : il dit seulement que le paquet
 * n'est atteint que par les devDependencies, alors que Vite met dans le bundle tout
 * ce que le code importe, quelle que soit sa section du package.json. Seuls quelques
 * outils de build, nommés un à un et dont le code n'est pas distribué, peuvent
 * relever d'autres licences.
 */

/** Entrée d'un paquet dans le fichier de verrouillage (formats 2 et 3). */
export interface LockfilePackage {
  readonly version?: string;
  readonly license?: string;
  /** Vrai si le paquet n'est atteint que par les devDependencies. */
  readonly dev?: boolean;
  /** Vrai si le paquet n'est atteint que par des dépendances optionnelles. */
  readonly optional?: boolean;
  /** Vrai si le paquet est à la fois de développement et optionnel pour un paquet qui ne l'est pas. */
  readonly devOptional?: boolean;
  /** Vrai pour un lien vers un dossier local. */
  readonly link?: boolean;
}

export interface Lockfile {
  readonly lockfileVersion: number;
  readonly packages: Readonly<Record<string, LockfilePackage>>;
}

/** Outil de build dont le code n'est pas distribué, admis sous d'autres licences. */
export interface ToolException {
  /** Noms des paquets concernés, sans drapeau `g` ni `y`, qui rendraient `test` dépendant de l'état. */
  readonly packages: RegExp;
  readonly licenses: ReadonlySet<string>;
}

export interface LicensePolicy {
  /** Identifiants SPDX admis pour tout paquet. */
  readonly allowed: ReadonlySet<string>;
  /** Exceptions SPDX admises après « WITH » ; toute autre est refusée. */
  readonly allowedExceptions: ReadonlySet<string>;
  /** Outils admis sous d'autres licences, à condition de n'être atteints que par les devDependencies. */
  readonly toolExceptions: readonly ToolException[];
}

/** Licence absente, expression SPDX illisible, ou licence non admise. */
export type LicenseProblem = 'missing' | 'invalid' | 'forbidden';

export interface LicenseIssue {
  readonly name: string;
  readonly version: string;
  readonly license: string | undefined;
  readonly development: boolean;
  readonly problem: LicenseProblem;
}

export const LICENSE_POLICY: LicensePolicy = {
  allowed: new Set([
    '0BSD',
    'Apache-2.0',
    'BlueOak-1.0.0',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'CC0-1.0',
    'ISC',
    'MIT',
    'MIT-0',
    'Unlicense',
    'Zlib',
  ]),
  allowedExceptions: new Set(),
  toolExceptions: [
    {
      // lightningcss transforme le CSS pour Vite : seul ce qu'il produit est distribué.
      // Le motif s'en tient au paquet et à ses binaires natifs : lightningcss-wasm,
      // qui peut s'exécuter dans un navigateur, en est exclu.
      packages: /^lightningcss(-(android|darwin|freebsd|linux|win32)-[a-z0-9-]+)?$/,
      licenses: new Set(['MPL-2.0']),
    },
  ],
};

/** Arbre d'une expression de licence SPDX. */
export type LicenseExpression =
  | { readonly kind: 'license'; readonly id: string; readonly exception?: string }
  | {
      readonly kind: 'and' | 'or';
      readonly left: LicenseExpression;
      readonly right: LicenseExpression;
    };

const OPERATORS: ReadonlySet<string> = new Set(['AND', 'OR', 'WITH']);

/** Identifiant SPDX, éventuellement suivi de « + » (« cette version ou une ultérieure »). */
const LICENSE_ID = /^[A-Za-z0-9.-]+\+?$/;

/** Identifiant d'une exception SPDX, qui n'admet pas de « + ». */
const EXCEPTION_ID = /^[A-Za-z0-9.-]+$/;

/**
 * Lit une expression de licence SPDX, par exemple « (MIT OR Apache-2.0) ».
 * Comme le veut la norme, AND l'emporte sur OR et les opérateurs s'écrivent en
 * majuscules. L'exception introduite par « WITH » reste dans l'arbre : c'est la
 * politique qui dit si elle est admise. Renvoie `undefined` si l'expression est
 * mal formée.
 */
export function parseLicenseExpression(text: string): LicenseExpression | undefined {
  const tokens = text.match(/[()]|[^\s()]+/g) ?? [];
  let position = 0;

  const fail = (): never => {
    throw new SyntaxError(text);
  };
  const next = (): string => tokens.at(position++) ?? fail();
  const isOperand = (token: string, pattern: RegExp): boolean =>
    pattern.test(token) && !OPERATORS.has(token);

  function parseOr(): LicenseExpression {
    let left = parseAnd();
    while (tokens.at(position) === 'OR') {
      position++;
      left = { kind: 'or', left, right: parseAnd() };
    }
    return left;
  }

  function parseAnd(): LicenseExpression {
    let left = parseAtom();
    while (tokens.at(position) === 'AND') {
      position++;
      left = { kind: 'and', left, right: parseAtom() };
    }
    return left;
  }

  function parseAtom(): LicenseExpression {
    const token = next();
    if (token === '(') {
      const inner = parseOr();
      if (next() !== ')') fail();
      return inner;
    }
    if (!isOperand(token, LICENSE_ID)) fail();
    const id = token.endsWith('+') ? token.slice(0, -1) : token;
    if (tokens.at(position) !== 'WITH') return { kind: 'license', id };
    position++;
    const exception = next();
    if (!isOperand(exception, EXCEPTION_ID)) fail();
    return { kind: 'license', id, exception };
  }

  try {
    const expression = parseOr();
    return position === tokens.length ? expression : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/**
 * Indique si une expression est satisfaite par les licences que `isAllowed` admet.
 * `isAllowed` reçoit aussi l'exception qui accompagne la licence, s'il y en a une.
 */
export function isSatisfied(
  expression: LicenseExpression,
  isAllowed: (id: string, exception: string | undefined) => boolean,
): boolean {
  switch (expression.kind) {
    case 'license':
      return isAllowed(expression.id, expression.exception);
    case 'and':
      return isSatisfied(expression.left, isAllowed) && isSatisfied(expression.right, isAllowed);
    case 'or':
      return isSatisfied(expression.left, isAllowed) || isSatisfied(expression.right, isAllowed);
  }
}

/** Nom d'un paquet d'après son chemin, par exemple `node_modules/a/node_modules/@b/c` donne `@b/c`. */
export function packageName(path: string): string {
  const marker = 'node_modules/';
  const index = path.lastIndexOf(marker);
  return index === -1 ? path : path.slice(index + marker.length);
}

/**
 * Problème posé par la licence d'un paquet, ou `undefined` si elle est admise.
 * `tools` donne les exceptions d'outil applicables à ce paquet ; il n'y en a aucune
 * pour du code distribué avec le jeu.
 */
export function licenseProblem(
  license: string | undefined,
  policy: LicensePolicy,
  tools: readonly ToolException[] = [],
): LicenseProblem | undefined {
  if (license === undefined || license.trim() === '') return 'missing';
  const expression = parseLicenseExpression(license);
  if (expression === undefined) return 'invalid';
  const isAllowed = (id: string, exception: string | undefined): boolean =>
    (exception === undefined || policy.allowedExceptions.has(exception)) &&
    (policy.allowed.has(id) || tools.some((tool) => tool.licenses.has(id)));
  return isSatisfied(expression, isAllowed) ? undefined : 'forbidden';
}

function findProblem(
  entry: LockfilePackage,
  name: string,
  policy: LicensePolicy,
): LicenseProblem | undefined {
  const tools =
    entry.dev === true ? policy.toolExceptions.filter((tool) => tool.packages.test(name)) : [];
  return licenseProblem(entry.license, policy, tools);
}

/** Contrôle la licence de chaque paquet du fichier de verrouillage et renvoie les écarts. */
export function auditLockfile(lockfile: Lockfile, policy: LicensePolicy): LicenseIssue[] {
  const issues: LicenseIssue[] = [];
  for (const [path, entry] of Object.entries(lockfile.packages)) {
    // L'entrée vide décrit le projet lui-même.
    if (path === '' || entry.link === true) continue;
    const name = packageName(path);
    const problem = findProblem(entry, name, policy);
    if (problem !== undefined) {
      issues.push({
        name,
        version: entry.version ?? '?',
        license: entry.license,
        development: entry.dev === true,
        problem,
      });
    }
  }
  return issues;
}
