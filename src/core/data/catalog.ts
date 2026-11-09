/**
 * Chargement du contenu (ADR 0006) : validation par le schéma, puis conversion des
 * identifiants textuels en indices entiers, que la simulation stocke dans ses
 * tableaux typés.
 */
import { z } from 'zod';

export interface Catalog<T extends { readonly id: string }> {
  /** Entrées, dans l'ordre du fichier : l'indice d'une entrée est sa position. */
  readonly entries: readonly T[];
  /** Indice d'un identifiant, ou undefined s'il est inconnu. */
  indexOf(id: string): number | undefined;
}

/** Erreur de contenu : le fichier, puis chaque problème avec son chemin. */
export class DataError extends Error {
  override readonly name = 'DataError';
}

export function loadCatalog<T extends { readonly id: string }>(
  file: string,
  schema: z.ZodType<T[]>,
  raw: unknown,
): Catalog<T> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join('.')} : ${issue.message}`,
    );
    throw new DataError(`${file} invalide\n${problems.join('\n')}`);
  }
  const entries = result.data;
  const indices = new Map(entries.map((entry, index) => [entry.id, index]));
  return { entries, indexOf: (id) => indices.get(id) };
}
