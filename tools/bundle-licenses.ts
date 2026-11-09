/**
 * Contrôle, au build, la licence de chaque paquet que Vite met dans le bundle (AST-05).
 *
 * Le fichier de verrouillage ne dit pas ce qui est distribué. Ce greffon regarde donc
 * les modules réellement regroupés, retrouve le paquet de chacun et fait échouer le
 * build si sa licence n'est pas admise. Les exceptions d'outil n'ont pas cours ici :
 * ce code est distribué avec le jeu.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import {
  LICENSE_POLICY,
  licenseProblem,
  type LicenseIssue,
  type LicensePolicy,
} from './licenses.ts';

/** Champs utiles du package.json d'un paquet. */
export interface PackageInfo {
  readonly name: string;
  readonly version: string;
  readonly license: string | undefined;
}

/** Lit un package.json, ou renvoie `undefined` s'il n'existe pas ou n'a pas de nom. */
export type PackageReader = (file: string) => PackageInfo | undefined;

export const readPackage: PackageReader = (file) => {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null) return undefined;
  const fields = data as Record<string, unknown>;
  if (typeof fields.name !== 'string') return undefined;
  return {
    name: fields.name,
    version: typeof fields.version === 'string' ? fields.version : '?',
    license: typeof fields.license === 'string' ? fields.license : undefined,
  };
};

/**
 * Paquet auquel appartient un module, s'il vient de node_modules : le package.json
 * nommé le plus proche, en remontant depuis le module. Les package.json sans nom,
 * comme ceux qui ne fixent que le type des modules d'un sous-dossier, sont ignorés.
 */
export function packageOfModule(moduleId: string, read: PackageReader): PackageInfo | undefined {
  // Modules virtuels de Vite et de rolldown, sans fichier.
  if (moduleId.startsWith('\0')) return undefined;
  const file = moduleId.split('?')[0] ?? moduleId;
  const normalized = file.split(path.sep).join('/');
  const rootIndex = normalized.lastIndexOf('/node_modules/');
  if (rootIndex === -1) return undefined;
  const root = normalized.slice(0, rootIndex + '/node_modules'.length);
  for (let directory = path.posix.dirname(normalized); directory.length > root.length;) {
    const info = read(`${directory}/package.json`);
    if (info !== undefined) return info;
    directory = path.posix.dirname(directory);
  }
  return undefined;
}

/** Contrôle les paquets des modules regroupés et renvoie les écarts, une fois par paquet. */
export function auditBundle(
  moduleIds: Iterable<string>,
  read: PackageReader,
  policy: LicensePolicy = LICENSE_POLICY,
): LicenseIssue[] {
  const seen = new Set<string>();
  const issues: LicenseIssue[] = [];
  for (const moduleId of moduleIds) {
    const info = packageOfModule(moduleId, read);
    if (info === undefined) continue;
    const key = `${info.name}@${info.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const problem = licenseProblem(info.license, policy);
    if (problem !== undefined) {
      issues.push({ ...info, development: false, problem });
    }
  }
  return issues;
}

/** Greffon de build : refuse tout paquet distribué sous une licence non admise. */
export function bundleLicenses(
  policy: LicensePolicy = LICENSE_POLICY,
  read: PackageReader = readPackage,
): Plugin {
  return {
    name: 'pixelciv:bundle-licenses',
    apply: 'build',
    generateBundle(_options, bundle) {
      const moduleIds = Object.values(bundle).flatMap((output) =>
        output.type === 'chunk' ? output.moduleIds : [],
      );
      const issues = auditBundle(moduleIds, read, policy);
      if (issues.length > 0) {
        const list = issues
          .map((issue) => `${issue.name}@${issue.version} (${issue.license ?? 'sans licence'})`)
          .join(', ');
        this.error(`Licences non admises dans le bundle (AST-05) : ${list}`);
      }
    },
  };
}
