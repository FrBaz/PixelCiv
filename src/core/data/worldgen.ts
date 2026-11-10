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

/** Identifiant de biome, vérifié contre data/biomes.json au chargement. */
const BiomeId = z.string().regex(/^[a-z]+(-[a-z]+)*$/);

/**
 * Grandeurs d'une case que les règles de classement comparent : températures annuelle,
 * du mois le plus chaud et du plus froid (°C), précipitations (mm), aridité (pluie
 * rapportée au seuil des climats secs), altitude (m), relief côtier et pente (rang de la
 * case parmi les côtes ou les terres, de 0 à 1).
 */
export const CLIMATE_VARIABLES = [
  'temperature',
  'warmest',
  'coldest',
  'precipitation',
  'aridity',
  'altitude',
  'relief',
  'slope',
] as const;

export type ClimateVariable = (typeof CLIMATE_VARIABLES)[number];

/** Intervalle [min, max) ; null pour une borne absente. */
const RangeSchema = z
  .tuple([z.number().nullable(), z.number().nullable()])
  .refine(([min, max]) => min === null || max === null || min < max, {
    message: 'intervalle vide',
  });

/** Règle de classement : le biome, et les conditions qu'une case doit remplir. */
const RuleSchema = z
  .object({
    biome: BiomeId,
    when: z.partialRecord(z.enum(CLIMATE_VARIABLES), RangeSchema).optional(),
  })
  .strict();

export type ClassificationRule = z.infer<typeof RuleSchema>;

/** Liste de règles, essayées dans l'ordre : la dernière, sans condition, reçoit le reste. */
const RulesSchema = z
  .array(RuleSchema)
  .min(1)
  .refine((rules) => rules.at(-1)?.when === undefined, {
    message: 'la dernière règle ne doit avoir aucune condition',
  });

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
    /** Seuil des climats secs (à la Köppen) : base + perDegree × température, au moins minimum. */
    aridity: z.object({ perDegree: Positive, base: z.number(), minimum: Positive }).strict(),
    /** D4 : rayon, en cases, où se mesure le relief côtier. */
    coasts: z.object({ reliefRadius: z.number().int().min(1).max(8) }).strict(),
    /** D5 : où se forment les zones humides. */
    wetlands: z
      .object({
        /** Rang de pente maximal parmi les terres (0,4 : les 40 % les plus plates). */
        maxSlope: Share,
        /** Distance maximale à une eau (mer, lac, rivière), en cases d'une carte Grand. */
        waterDistance: Positive,
        maxAltitude: z.number(),
        minPrecipitation: z.number().min(0),
        /** Fréquence du bruit qui découpe les zones en taches, et seuil de ce bruit (0 à 1). */
        patchFrequency: Positive,
        patchThreshold: Share,
      })
      .strict(),
    /** D4 à D6, D13 : classement des cases en biomes. */
    classification: z
      .object({
        ocean: RulesSchema,
        lakes: z.object({ fresh: BiomeId, salt: BiomeId, saltFlat: BiomeId }).strict(),
        /** Biome des cases d'un fleuve, que son lit couvre. */
        river: BiomeId,
        glacier: RuleSchema,
        coast: RulesSchema,
        wetland: RulesSchema,
        land: RulesSchema,
      })
      .strict(),
  })
  .strict();

export type Worldgen = z.infer<typeof WorldgenSchema>;

/** Tous les biomes que nomment les règles de classement. */
export function classifiedBiomes(classification: Worldgen['classification']): string[] {
  const { ocean, lakes, river, glacier, coast, wetland, land } = classification;
  return [
    ...ocean.map((rule) => rule.biome),
    lakes.fresh,
    lakes.salt,
    lakes.saltFlat,
    river,
    glacier.biome,
    ...coast.map((rule) => rule.biome),
    ...wetland.map((rule) => rule.biome),
    ...land.map((rule) => rule.biome),
  ];
}
