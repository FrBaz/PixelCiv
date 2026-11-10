/**
 * Schémas des commandes de jeu (ADR 0004). Le worker vérifie chaque commande à sa
 * réception, avant de l'accepter : une commande acceptée est donc toujours de celles
 * qu'une sauvegarde sait relire.
 */
import { z } from 'zod';
import type { GameCommand, LoggedCommand } from '../core/protocol';

/** Coordonnée d'une case : un entier sûr, que l'état normalise ensuite (x boucle). */
const cell = z.number().int();

const id = z.string().regex(/^[a-z]+(-[a-z]+)*$/);

/** Taille d'un groupe qu'on fait apparaître : de deux à une cinquantaine d'individus. */
export const SPAWN_COUNT = { min: 2, max: 50 } as const;

export const GameCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('paintBiome'), x: cell, y: cell, biome: id }).strict(),
  z
    .object({
      type: z.literal('spawnGroup'),
      x: cell,
      y: cell,
      species: id,
      subspecies: id,
      count: z.number().int().min(SPAWN_COUNT.min).max(SPAWN_COUNT.max),
    })
    .strict(),
]) satisfies z.ZodType<GameCommand>;

export const LoggedCommandSchema = z
  .object({ tick: z.number().int().nonnegative(), command: GameCommandSchema })
  .strict() satisfies z.ZodType<LoggedCommand>;
