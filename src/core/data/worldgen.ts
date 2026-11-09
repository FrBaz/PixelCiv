/**
 * Schéma des réglages de la génération du monde (data/worldgen.json, ADR 0009) : les
 * paramètres de l'écran de création, avec leurs bornes, et les seuils des séances de
 * conception (C1), que la phase 1 calibre.
 */
import { z } from 'zod';

/** Réglage d'un paramètre de création : bornes, valeur par défaut, pas du curseur. */
const ParameterSchema = z
  .object({
    min: z.number(),
    max: z.number(),
    default: z.number(),
    step: z.number().positive(),
  })
  .strict()
  .refine((range) => range.min <= range.default && range.default <= range.max, {
    message: 'la valeur par défaut doit rester entre les bornes',
  });

export type Parameter = z.infer<typeof ParameterSchema>;

/** Paramètres de création (MON-03, MON-14), dans l'ordre de l'écran de création. */
export const PARAMETER_NAMES = [
  'landShare',
  'seaLevel',
  'relief',
  'temperature',
  'humidity',
  'rivers',
] as const;

export type ParameterName = (typeof PARAMETER_NAMES)[number];

const Share = z.number().min(0).max(1);
const Positive = z.number().positive();

export const WorldgenSchema = z
  .object({
    parameters: z
      .object({
        landShare: ParameterSchema,
        seaLevel: ParameterSchema,
        relief: ParameterSchema,
        temperature: ParameterSchema,
        humidity: ParameterSchema,
        rivers: ParameterSchema,
      })
      .strict(),
    /** D1 : part minimale de la carte d'une masse d'eau, pour compter comme mer. */
    ocean: z.object({ minShare: Share }).strict(),
    /** D8, D13 : températures, gradient, pluies. */
    climate: z
      .object({
        equatorTemperature: z.number(),
        poleTemperature: z.number(),
        latitudeExponent: Positive,
        lapseRate: z.number().min(0),
        precipitationScale: Positive,
      })
      .strict(),
    /** D2, D3 : lacs et rivières. */
    hydrology: z
      .object({
        lakeMinArea: Positive,
        lakeMinDepth: z.number().min(0),
        infill: z.number().min(0).max(0.99),
        saltFlatRatio: Share,
        saltFlatShare: Share,
        lakeEvaporation: z.object({ perDegree: Positive, minimum: z.number().min(0) }).strict(),
        riverThreshold: Positive,
        riverClasses: z
          .tuple([Positive, Positive])
          .refine(([river, major]) => river > 1 && major > river, {
            message: 'les classes de rivières croissent : ruisseau, rivière, fleuve',
          }),
      })
      .strict(),
  })
  .strict();

export type Worldgen = z.infer<typeof WorldgenSchema>;
