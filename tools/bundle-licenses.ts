/**
 * Licences et crédits des paquets distribués avec le jeu, contrôlés au build
 * (AST-02, AST-05 ; ADR 0001 et 0008).
 *
 * Le fichier de verrouillage ne dit pas ce qui est distribué. Ces greffons regardent
 * donc les modules réellement regroupés, dans le bundle principal comme dans ceux des
 * workers, et retrouvent le paquet de chacun. Le build échoue si un paquet est sous
 * une licence non admise (les exceptions d'outil n'ont pas cours ici : ce code est
 * distribué) ou s'il manque à CREDITS.md. Le build principal joint enfin au jeu les
 * textes de licence de tous ces paquets, que le code minifié ne contient plus.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin, Rolldown } from 'vite';
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
  /** Page du paquet : son site, à défaut son dépôt. */
  readonly link?: string | undefined;
}

/** Paquet d'un module regroupé, avec son dossier, où se trouve son texte de licence. */
export interface BundledPackage extends PackageInfo {
  readonly directory: string;
}

/** Lit un package.json, ou renvoie `undefined` s'il n'existe pas ou n'a pas de nom. */
export type PackageReader = (file: string) => PackageInfo | undefined;

/** Adresse web du dépôt d'un package.json, sous ses diverses formes. */
export function repositoryLink(repository: unknown): string | undefined {
  const url =
    typeof repository === 'object' && repository !== null && 'url' in repository
      ? repository.url
      : repository;
  if (typeof url !== 'string') return undefined;
  // Raccourcis de GitHub : « owner/repo » ou « github:owner/repo ».
  const github = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(url);
  if (github !== null) return `https://github.com/${github[1]}`;
  return url
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\.git$/, '');
}

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
    link: typeof fields.homepage === 'string' ? fields.homepage : repositoryLink(fields.repository),
  };
};

const NODE_MODULES = '/node_modules/';

/**
 * Paquet auquel appartient un module, s'il vient de node_modules : le dossier qui suit
 * le dernier `node_modules/`, ou les deux qui le suivent pour un paquet à portée
 * (`@scope/nom`). Les package.json des sous-dossiers, comme celui de `preact/hooks`,
 * ne désignent pas des paquets. Un paquet sans package.json lisible garde le nom de
 * son dossier, sans licence connue : le contrôle des licences le refuse.
 */
export function packageOfModule(moduleId: string, read: PackageReader): BundledPackage | undefined {
  // Modules virtuels de Vite et de rolldown, sans fichier.
  if (moduleId.startsWith('\0')) return undefined;
  const file = (moduleId.split('?')[0] ?? moduleId).split(path.sep).join('/');
  const start = file.lastIndexOf(NODE_MODULES);
  if (start === -1) return undefined;
  const segments = file.slice(start + NODE_MODULES.length).split('/');
  const depth = segments[0].startsWith('@') ? 2 : 1;
  // Le module doit se trouver dans le dossier du paquet.
  if (segments.length <= depth) return undefined;
  const name = segments.slice(0, depth).join('/');
  const directory = file.slice(0, start + NODE_MODULES.length) + name;
  const info = read(`${directory}/package.json`) ?? { name, version: '?', license: undefined };
  return { ...info, directory };
}

const packageKey = (info: PackageInfo) => `${info.name}@${info.version}`;

/** Paquets des modules regroupés, une fois chacun par nom et version. */
export function bundledPackages(
  moduleIds: Iterable<string>,
  read: PackageReader,
): BundledPackage[] {
  const packages = new Map<string, BundledPackage>();
  for (const moduleId of moduleIds) {
    const info = packageOfModule(moduleId, read);
    if (info !== undefined && !packages.has(packageKey(info))) {
      packages.set(packageKey(info), info);
    }
  }
  return [...packages.values()];
}

/** Écarts de licence des paquets donnés, au regard de la politique. */
export function auditPackages(
  packages: Iterable<PackageInfo>,
  policy: LicensePolicy = LICENSE_POLICY,
): LicenseIssue[] {
  const issues: LicenseIssue[] = [];
  for (const { name, version, license } of packages) {
    const problem = licenseProblem(license, policy);
    if (problem !== undefined) issues.push({ name, version, license, development: false, problem });
  }
  return issues;
}

/** Contrôle les paquets des modules regroupés et renvoie les écarts, une fois par paquet. */
export function auditBundle(
  moduleIds: Iterable<string>,
  read: PackageReader,
  policy: LicensePolicy = LICENSE_POLICY,
): LicenseIssue[] {
  return auditPackages(bundledPackages(moduleIds, read), policy);
}

/** Paquets absents des crédits, où chacun doit être cité entre accents graves. */
export function missingCredits(packages: Iterable<PackageInfo>, credits: string): string[] {
  const names = new Set<string>();
  for (const { name } of packages) {
    if (!credits.includes(`\`${name}\``)) names.add(name);
  }
  return [...names].sort();
}

/** Texte de licence fourni par un paquet (LICENSE, LICENCE, COPYING…), s'il en a un. */
export function licenseText(directory: string): string | undefined {
  let files: string[];
  try {
    files = readdirSync(directory).sort();
  } catch {
    return undefined;
  }
  const file = files.find((name) => /^(licen[cs]e|copying)/i.test(name));
  return file === undefined ? undefined : readFileSync(path.join(directory, file), 'utf8').trim();
}

const RULE = '-'.repeat(72);

/** Avis de licence joint au jeu : chaque paquet distribué, avec son texte de licence. */
export function licenseNotice(
  packages: Iterable<BundledPackage>,
  text: (directory: string) => string | undefined = licenseText,
): string {
  const sorted = [...packages].sort((a, b) => {
    const [first, second] = [packageKey(a), packageKey(b)];
    return first < second ? -1 : first > second ? 1 : 0;
  });
  const sections = sorted.map((info) =>
    [
      RULE,
      `${info.name} ${info.version} (${info.license ?? 'sans licence'})`,
      ...(info.link === undefined ? [] : [info.link]),
      RULE,
      '',
      text(info.directory) ?? 'Ce paquet ne fournit pas de texte de licence.',
      '',
    ].join('\n'),
  );
  return [
    'PixelCiv distribue les bibliothèques suivantes, chacune sous sa propre licence.',
    'Leurs auteurs sont crédités dans CREDITS.md.',
    '',
    ...sections,
  ].join('\n');
}

export interface BundleLicensesOptions {
  readonly policy?: LicensePolicy;
  readonly read?: PackageReader;
  /** Fichier des crédits, relatif à la racine du projet. */
  readonly credits?: string;
  /** Avis de licence émis avec le jeu, relatif au dossier de sortie. */
  readonly notice?: string;
}

/** Feuilles de style du projet : seuls les CSS sont employés, sans préprocesseur. */
const STYLESHEET = /\.(css|pcss|postcss)$/;

/** Chemins qu'une feuille de style va chercher : `@import` et `url()`, hors commentaires. */
export function stylesheetReferences(code: string): string[] {
  const text = code.replace(/\/\*[\s\S]*?\*\//g, '');
  const references = new Set<string>();
  for (const match of text.matchAll(/@import\s+(?:url\(\s*)?(['"]?)([^'"\s;)]+)\1/g)) {
    references.add(match[2]);
  }
  for (const match of text.matchAll(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g)) {
    references.add(match[2]);
  }
  return [...references].filter((reference) => reference !== '');
}

/** Le chemin mène-t-il à un paquet : nom nu, `~paquet`, ou chemin qui passe par node_modules ? */
export function isPackageReference(reference: string, importer: string, root: string): boolean {
  if (/^(data:|[a-z]+:\/\/|\/\/|#)/i.test(reference)) return false;
  if (!reference.startsWith('.') && !reference.startsWith('/')) return true;
  const target = reference.startsWith('/')
    ? path.join(root, reference)
    : path.resolve(path.dirname(importer), reference);
  return target.split(path.sep).includes('node_modules');
}

const moduleIdsOf = (bundle: Rolldown.OutputBundle): string[] =>
  Object.values(bundle).flatMap((output) => (output.type === 'chunk' ? output.moduleIds : []));

/**
 * Greffons de build : `worker()` pour chaque bundle de worker, `main` pour le bundle
 * principal. Vite regroupe les workers pendant le build principal, avant que celui-ci
 * n'émette ses fichiers : `main` voit donc aussi les paquets des workers.
 */
export function bundleLicenses(options: BundleLicensesOptions = {}): {
  readonly main: Plugin;
  readonly worker: () => Plugin;
} {
  const {
    policy = LICENSE_POLICY,
    read = readPackage,
    credits = 'CREDITS.md',
    notice = 'licenses.txt',
  } = options;
  /** Paquets distribués, tous bundles confondus. */
  const distributed = new Map<string, BundledPackage>();

  /** Enregistre les paquets d'un bundle ; renvoie l'erreur à lever s'il y en a une. */
  const record = (bundle: Rolldown.OutputBundle): string | undefined => {
    const packages = bundledPackages(moduleIdsOf(bundle), read);
    for (const info of packages) distributed.set(packageKey(info), info);
    const issues = auditPackages(packages, policy);
    if (issues.length === 0) return undefined;
    const list = issues
      .map((issue) => `${issue.name}@${issue.version} (${issue.license ?? 'sans licence'})`)
      .join(', ');
    return `Licences non admises dans le bundle (AST-05) : ${list}`;
  };

  let root = process.cwd();
  const main: Plugin = {
    name: 'pixelciv:bundle-licenses',
    apply: 'build',
    configResolved(config) {
      root = config.root;
    },
    // Une feuille de style du projet qui en tire une d'un paquet, par `@import` ou
    // `url()`, l'insère sans en faire un module : le contrôle ne la verrait pas.
    transform: {
      order: 'pre',
      handler(code, id) {
        const file = id.split('?')[0] ?? id;
        if (!STYLESHEET.test(file) || file.split('/').includes('node_modules')) return null;
        const references = stylesheetReferences(code).filter((reference) =>
          isPackageReference(reference, file, root),
        );
        if (references.length > 0) {
          this.error(
            `${path.relative(root, file)} tire ${references.join(', ')} d'un paquet. ` +
              'Importe cette feuille de style depuis le JS, où le contrôle des licences et des ' +
              'crédits la voit (ADR 0008).',
          );
        }
        return null;
      },
    },
    generateBundle(_options, bundle) {
      const error = record(bundle);
      if (error !== undefined) this.error(error);
      let text: string;
      try {
        text = readFileSync(path.join(root, credits), 'utf8');
      } catch {
        this.error(`Fichier des crédits introuvable (AST-02) : ${credits}`);
      }
      const missing = missingCredits(distributed.values(), text);
      if (missing.length > 0) {
        this.error(
          `Paquets distribués absents de ${credits} (AST-02) : ${missing.join(', ')}. ` +
            'Ajoute pour chacun ses auteurs, sa licence et son lien.',
        );
      }
      this.emitFile({
        type: 'asset',
        fileName: notice,
        // Marque d'ordre des octets : le navigateur lit le fichier en UTF-8, même si le
        // serveur n'en déclare pas l'encodage.
        source: `\uFEFF${licenseNotice(distributed.values())}`,
      });
    },
  };

  const worker = (): Plugin => ({
    name: 'pixelciv:bundle-licenses-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const error = record(bundle);
      if (error !== undefined) this.error(error);
    },
  });

  return { main, worker };
}
