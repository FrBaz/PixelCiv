/**
 * Groupes nomades, cultures, langues et chronique (tâches 2.1, 2.5, 2.10 ; C2, D1, D4 et
 * D11 ; ADR 0011).
 *
 * Ils se comptent par centaines ou par milliers, et non par dizaines de milliers comme
 * les individus : ce sont des objets. Un groupe nomade naît avec une culture et une
 * langue embryonnaires (C2, D4). Une langue n'est qu'une graine, d'où se tirent ses sons
 * et ses noms (src/gen/names.ts), à l'identique dans le worker et sur le fil principal.
 */

/**
 * Règle de nommage d'une culture (IND-08 ; C2, D6) : d'où l'enfant tient son nom de
 * famille. Il hérite de celui de son père, de sa mère, ou des deux (celui du père, puis,
 * à l'affichage, celui de la mère) ; ou il n'en a pas ; ou il reçoit à la naissance un nom
 * obtenu, un surnom propre à lui, tiré dans la langue de sa culture, qu'il ne tient de
 * personne (« earned » ; le métier et le lieu attendent la phase 3).
 */
export const NAMING_RULES = ['father', 'mother', 'both', 'none', 'earned'] as const;
export type NamingRule = (typeof NAMING_RULES)[number];

export interface Language {
  readonly id: number;
  /** Graine de la phonologie et des noms. */
  readonly seed: number;
}

export interface Culture {
  readonly id: number;
  readonly language: number;
  readonly naming: NamingRule;
  /** Pas de son apparition. */
  readonly founded: number;
}

export interface Group {
  readonly id: number;
  readonly culture: number;
  /** Pas de sa formation, et groupe dont il s'est détaché (NONE pour le premier). */
  readonly founded: number;
  readonly parent: number;
  /**
   * Meneur : l'aîné des adultes à sa formation. Le groupe porte son nom (« le groupe
   * d'Ataru »), même après sa mort : une bande n'a pas d'autre nom avant la fondation.
   */
  readonly leader: number;
  /** Case du groupe : x boucle, y reste dans le monde. */
  x: number;
  y: number;
  /** Centre de son aire, où il revient au fil des saisons. */
  homeX: number;
  homeY: number;
  /** Destination du moment, -1 sans destination. */
  targetX: number;
  targetY: number;
  /** Réserve de nourriture, en mois de besoin d'un adulte. */
  food: number;
}

/**
 * Faits de la chronique de base (CHR-01), dans l'ordre de leur code dans la sauvegarde :
 * un genre nouveau s'ajoute à la fin. Chaque groupe formé a le sien, apparition ou
 * scission : la relecture en déduit le prochain identifiant de groupe (populationSave.ts),
 * et la chronique ne s'abrège donc pas sans revoir ce contrôle.
 */
export const CHRONICLE_KINDS = [
  /** Un groupe apparaît, par l'outil du Créateur (CRE-03). */
  'groupAppeared',
  /** Un groupe se scinde : `other` est le nouveau groupe. */
  'groupSplit',
  /** Le dernier membre d'un groupe meurt. */
  'groupExtinct',
  /** Une famine emporte `count` membres d'un groupe en un mois. */
  'famine',
  /** Un groupe trop petit rejoint `other`, avec ses `count` membres. */
  'groupMerged',
] as const;
export type ChronicleKind = (typeof CHRONICLE_KINDS)[number];

export interface ChronicleEntry {
  readonly tick: number;
  readonly kind: ChronicleKind;
  /** Lieu : case du groupe au moment des faits. */
  readonly x: number;
  readonly y: number;
  readonly group: number;
  /** Autre groupe en cause (scission, réunion), NONE sinon. */
  readonly other: number;
  /** Meneurs des deux groupes, qui leur donnent leur nom, même disparus ; NONE sinon. */
  readonly leader: number;
  readonly otherLeader: number;
  /** Nombre de personnes en cause. */
  readonly count: number;
}

/** Ce qui vit au-dessus des individus : groupes, cultures, langues, chronique. */
export interface Society {
  /** Groupes vivants, par identifiant ; l'ordre d'insertion est celui de leur formation. */
  readonly groups: Map<number, Group>;
  /** Cultures et langues, rangées par identifiant : celui de l'entrée i vaut i + 1. */
  readonly cultures: Culture[];
  readonly languages: Language[];
  readonly chronicle: ChronicleEntry[];
  /** Prochain identifiant de groupe ; 0 ne désigne aucun groupe. */
  nextGroupId: number;
}

export function emptySociety(): Society {
  return { groups: new Map(), cultures: [], languages: [], chronicle: [], nextGroupId: 1 };
}

/** Culture d'identifiant `id`, ou undefined. */
export function cultureOf(society: Society, id: number): Culture | undefined {
  return id >= 1 ? society.cultures[id - 1] : undefined;
}

/** Langue d'identifiant `id`, ou undefined. */
export function languageOf(society: Society, id: number): Language | undefined {
  return id >= 1 ? society.languages[id - 1] : undefined;
}
