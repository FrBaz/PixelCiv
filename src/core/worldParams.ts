/**
 * Paramètres d'un monde (MON-02, MON-03, MON-14) : graine, taille et réglages de
 * l'écran de création. Leurs bornes viennent de data/worldgen.json ; la même graine et
 * les mêmes paramètres donnent toujours le même monde (NF-09).
 */
import { z } from 'zod';
import { PARAMETER_NAMES, type ParameterName, type Worldgen } from './data/worldgen';
import { WORLD_SIZES, type WorldSizeId } from './world';

export type WorldParams = {
  readonly seed: string;
  readonly size: WorldSizeId;
} & Readonly<Record<ParameterName, number>>;

/** Longueur maximale d'une graine, en caractères. */
export const MAX_SEED_LENGTH = 64;

const SIZE_IDS = Object.keys(WORLD_SIZES) as [WorldSizeId, ...WorldSizeId[]];

/** Schéma des paramètres, bornés par les réglages de data/worldgen.json. */
export function worldParamsSchema(parameters: Worldgen['parameters']): z.ZodType<WorldParams> {
  const bounded = (name: ParameterName) =>
    z.number().min(parameters[name].min).max(parameters[name].max);
  return z
    .object({
      seed: z.string().min(1).max(MAX_SEED_LENGTH),
      size: z.enum(SIZE_IDS),
      landShare: bounded('landShare'),
      seaLevel: bounded('seaLevel'),
      relief: bounded('relief'),
      temperature: bounded('temperature'),
      humidity: bounded('humidity'),
      rivers: bounded('rivers'),
    })
    .strict();
}

/** Paramètres par défaut, pour une graine et une taille. */
export function defaultWorldParams(
  parameters: Worldgen['parameters'],
  seed: string,
  size: WorldSizeId,
): WorldParams {
  const values = Object.fromEntries(
    PARAMETER_NAMES.map((name) => [name, parameters[name].default]),
  ) as Record<ParameterName, number>;
  return { seed, size, ...values };
}
