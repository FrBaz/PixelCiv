/**
 * Schémas des commandes de jeu (ADR 0004). Le worker vérifie chaque commande à sa
 * réception, avant de l'accepter : une commande acceptée est donc toujours de celles
 * qu'une sauvegarde sait relire.
 */
import { z } from 'zod';
import type { GameCommand, LoggedCommand } from '../core/protocol';

/** Coordonnée d'une case : un entier sûr, que l'état normalise ensuite (x boucle). */
const cell = z.number().int();

export const GameCommandSchema = z
  .object({
    type: z.literal('paint'),
    x: cell,
    y: cell,
    value: z.number().int().min(0).max(255),
  })
  .strict() satisfies z.ZodType<GameCommand>;

export const LoggedCommandSchema = z
  .object({ tick: z.number().int().nonnegative(), command: GameCommandSchema })
  .strict() satisfies z.ZodType<LoggedCommand>;
