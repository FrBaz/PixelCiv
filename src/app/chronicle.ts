/**
 * Faits de la chronique que garde le fil principal (CHR-01 ; tâche 2.10), en deux listes :
 * - les faits récents, les CHRONICLE_RECENT derniers, que l'instantané apporte et que
 *   chaque delta prolonge ;
 * - les faits affichés : les récents, tant que le joueur ne remonte pas la chronique. Au
 *   premier appui sur « Faits plus anciens », la liste affichée se fige. Les pages demandées
 *   s'y ajoutent devant, et les faits nouveaux ne s'y ajoutent plus, mais se comptent
 *   (`newFacts`). Le joueur revient aux derniers faits d'un appui sur « N faits nouveaux »,
 *   en fermant la chronique, ou à un instantané (`latestFacts`).
 *
 * La liste affichée reste ainsi bornée par les gestes du joueur, et non par la durée de sa
 * lecture : CHRONICLE_RECENT faits, plus CHRONICLE_PAGE par page demandée. Toute la
 * chronique reste consultable, jusqu'au premier fait. Les faits se rangent par rang, du
 * plus ancien au plus récent, sans trou ni doublon.
 */
import { CHRONICLE_RECENT, type ChronicleView } from '../core/protocol';

export interface KeptFacts {
  /** Les CHRONICLE_RECENT derniers faits reçus. */
  readonly recent: readonly ChronicleView[];
  /** Les faits affichés : les récents, ou la liste figée et ses pages plus anciennes. */
  readonly shown: readonly ChronicleView[];
  /** La liste affichée est figée : le joueur lit des pages plus anciennes. */
  readonly frozen: boolean;
}

/**
 * Prolonge les faits récents de ceux d'un delta : seuls restent les CHRONICLE_RECENT
 * derniers. Un fait déjà reçu ne se compte pas deux fois.
 */
function appendFacts(
  facts: readonly ChronicleView[],
  fresh: readonly ChronicleView[],
): readonly ChronicleView[] {
  const last = facts.at(-1)?.index ?? -1;
  const added = fresh.filter((fact) => fact.index > last);
  if (added.length === 0) return facts;
  const all = [...facts, ...added];
  return all.length <= CHRONICLE_RECENT ? all : all.slice(-CHRONICLE_RECENT);
}

/** Faits d'un instantané : les derniers de la partie, affichés tels quels. */
export function snapshotFacts(facts: readonly ChronicleView[]): KeptFacts {
  const recent = appendFacts([], facts);
  return { recent, shown: recent, frozen: false };
}

/**
 * Faits nouveaux d'un delta : ils prolongent les récents, et la liste affichée tant qu'elle
 * n'est pas figée.
 */
export function receiveFacts(kept: KeptFacts, fresh: readonly ChronicleView[]): KeptFacts {
  const recent = appendFacts(kept.recent, fresh);
  if (recent === kept.recent) return kept;
  return { recent, shown: kept.frozen ? kept.shown : recent, frozen: kept.frozen };
}

/** Le joueur demande une page plus ancienne : la liste affichée se fige. */
export function freezeFacts(kept: KeptFacts): KeptFacts {
  return kept.frozen ? kept : { ...kept, frozen: true };
}

/**
 * Ajoute devant les faits affichés une page de faits plus anciens. Une page qui ne les
 * rejoint pas, parce qu'ils ont changé depuis la demande, laisserait un trou : elle est
 * oubliée, comme celle qui arrive après le retour aux derniers faits.
 */
export function receivePage(kept: KeptFacts, page: readonly ChronicleView[]): KeptFacts {
  const first = kept.shown.at(0)?.index;
  if (!kept.frozen || first === undefined) return kept;
  const older = page.filter((fact) => fact.index < first);
  if (older.at(-1)?.index !== first - 1) return kept;
  return { ...kept, shown: [...older, ...kept.shown] };
}

/** Retour aux derniers faits : la liste affichée n'est plus figée. */
export function latestFacts(kept: KeptFacts): KeptFacts {
  return kept.frozen ? { recent: kept.recent, shown: kept.recent, frozen: false } : kept;
}

/**
 * Faits arrivés depuis que la liste affichée est figée, 0 si elle ne l'est pas : les rangs
 * se suivent, si bien qu'ils sont l'écart entre le dernier fait reçu et le dernier affiché.
 */
export function newFacts(kept: KeptFacts): number {
  if (!kept.frozen) return 0;
  return (kept.recent.at(-1)?.index ?? -1) - (kept.shown.at(-1)?.index ?? -1);
}

/** Rang avant lequel demander la page suivante, ou undefined s'il n'y a rien avant. */
export function olderThan(kept: KeptFacts): number | undefined {
  const first = kept.shown.at(0)?.index;
  return first === undefined || first === 0 ? undefined : first;
}
