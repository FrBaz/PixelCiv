/**
 * Faits de la chronique que garde le fil principal (CHR-01 ; tâche 2.10) : les
 * CHRONICLE_RECENT derniers, que l'instantané apporte et que chaque delta prolonge, plus
 * les pages plus anciennes que le joueur demande en remontant la chronique : elle reste
 * ainsi consultable en entier. Les faits se rangent par rang, du plus ancien au plus
 * récent, sans trou ni doublon.
 */
import { CHRONICLE_RECENT, type ChronicleView } from '../core/protocol';

/**
 * Ajoute les faits nouveaux d'un delta. Sans pages plus anciennes à garder (`keepOlder`),
 * seuls restent les CHRONICLE_RECENT derniers.
 */
export function appendFacts(
  facts: readonly ChronicleView[],
  fresh: readonly ChronicleView[],
  keepOlder: boolean,
): readonly ChronicleView[] {
  const last = facts.at(-1)?.index ?? -1;
  const added = fresh.filter((fact) => fact.index > last);
  const all = added.length === 0 ? facts : [...facts, ...added];
  return keepOlder || all.length <= CHRONICLE_RECENT ? all : all.slice(-CHRONICLE_RECENT);
}

/**
 * Ajoute devant les faits gardés une page de faits plus anciens. Une page qui ne les
 * rejoint pas, parce qu'ils ont changé depuis la demande, laisserait un trou : elle est
 * oubliée.
 */
export function prependPage(
  facts: readonly ChronicleView[],
  page: readonly ChronicleView[],
): readonly ChronicleView[] {
  const first = facts.at(0)?.index;
  if (first === undefined) return facts;
  const older = page.filter((fact) => fact.index < first);
  if (older.at(-1)?.index !== first - 1) return facts;
  return [...older, ...facts];
}

/** Rang avant lequel demander la page suivante, ou undefined s'il n'y a rien avant. */
export function olderThan(facts: readonly ChronicleView[]): number | undefined {
  const first = facts.at(0)?.index;
  return first === undefined || first === 0 ? undefined : first;
}
