/**
 * Vérification des licences des dépendances (PRD, AST-05).
 *
 * Le fichier de verrouillage de npm donne la licence de chaque paquet installé.
 * Un paquet distribué avec le jeu doit être sous une licence permissive, compatible
 * avec une sortie commerciale. Un outil de développement, qui n'est pas distribué,
 * peut en plus relever de quelques licences admises à ce seul titre.
 */

/** Entrée d'un paquet dans le fichier de verrouillage (formats 2 et 3). */
export interface LockfilePackage {
  readonly version?: string;
  readonly license?: string;
  /** Vrai si le paquet ne sert qu'au développement. */
  readonly dev?: boolean;
  /** Vrai pour un lien vers un dossier local. */
  readonly link?: boolean;
}

export interface Lockfile {
  readonly lockfileVersion: number;
  readonly packages: Readonly<Record<string, LockfilePackage>>;
}

export interface LicensePolicy {
  /** Identifiants SPDX admis pour tous les paquets, y compris ceux distribués avec le jeu. */
  readonly allowed: ReadonlySet<string>;
  /** Identifiants SPDX admis en plus pour les seuls outils de développement. */
  readonly allowedForDevelopment: ReadonlySet<string>;
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
  allowedForDevelopment: new Set([
    // lightningcss, qui transforme le CSS pour Vite : seul ce qu'il produit est distribué.
    'MPL-2.0',
  ]),
};

/** Arbre d'une expression de licence SPDX. */
export type LicenseExpression =
  | { readonly kind: 'license'; readonly id: string }
  | {
      readonly kind: 'and' | 'or';
      readonly left: LicenseExpression;
      readonly right: LicenseExpression;
    };

const OPERATORS: ReadonlySet<string> = new Set(['AND', 'OR', 'WITH']);

/** Identifiant SPDX, éventuellement suivi de « + » (« cette version ou une ultérieure »). */
const LICENSE_ID = /^[A-Za-z0-9.-]+\+?$/;

/**
 * Lit une expression de licence SPDX, par exemple « (MIT OR Apache-2.0) ».
 * Comme le veut la norme, AND l'emporte sur OR et les opérateurs s'écrivent en
 * majuscules. Une exception (« WITH ») ne fait qu'ajouter des droits : elle est
 * omise de l'arbre. Renvoie `undefined` si l'expression est invalide.
 */
export function parseLicenseExpression(text: string): LicenseExpression | undefined {
  const tokens = text.match(/[()]|[^\s()]+/g) ?? [];
  let position = 0;

  const fail = (): never => {
    throw new SyntaxError(text);
  };
  const next = (): string => tokens.at(position++) ?? fail();
  const isLicenseId = (token: string): boolean => LICENSE_ID.test(token) && !OPERATORS.has(token);

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
    if (!isLicenseId(token)) fail();
    if (tokens.at(position) === 'WITH') {
      position++;
      if (!isLicenseId(next())) fail();
    }
    return { kind: 'license', id: token.endsWith('+') ? token.slice(0, -1) : token };
  }

  try {
    const expression = parseOr();
    return position === tokens.length ? expression : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** Indique si une expression est satisfaite par les licences que `isAllowed` admet. */
export function isSatisfied(
  expression: LicenseExpression,
  isAllowed: (id: string) => boolean,
): boolean {
  switch (expression.kind) {
    case 'license':
      return isAllowed(expression.id);
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

function findProblem(
  license: string | undefined,
  development: boolean,
  policy: LicensePolicy,
): LicenseProblem | undefined {
  if (license === undefined || license.trim() === '') return 'missing';
  const expression = parseLicenseExpression(license);
  if (expression === undefined) return 'invalid';
  const isAllowed = (id: string): boolean =>
    policy.allowed.has(id) || (development && policy.allowedForDevelopment.has(id));
  return isSatisfied(expression, isAllowed) ? undefined : 'forbidden';
}

/** Contrôle la licence de chaque paquet du fichier de verrouillage et renvoie les écarts. */
export function auditLockfile(lockfile: Lockfile, policy: LicensePolicy): LicenseIssue[] {
  const issues: LicenseIssue[] = [];
  for (const [path, entry] of Object.entries(lockfile.packages)) {
    // L'entrée vide décrit le projet lui-même.
    if (path === '' || entry.link === true) continue;
    const development = entry.dev === true;
    const problem = findProblem(entry.license, development, policy);
    if (problem !== undefined) {
      issues.push({
        name: packageName(path),
        version: entry.version ?? '?',
        license: entry.license,
        development,
        problem,
      });
    }
  }
  return issues;
}
