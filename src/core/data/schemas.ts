/**
 * Schémas du contenu du jeu (NF-07, ADR 0006). Le contenu vit dans data/, en JSON ;
 * ces schémas le valident au démarrage et dans les tests, donc dans l'intégration
 * continue. Les textes affichés sont des clés de traduction.
 */
import { z } from 'zod';

/** Identifiant textuel : minuscules et tirets, comme « deep-ocean ». */
export const IdSchema = z
  .string()
  .regex(/^[a-z]+(-[a-z]+)*$/, 'identifiant en minuscules et tirets');

/** Clé de traduction, vérifiée contre le catalogue par les tests. */
export const MessageKeySchema = z.string().regex(/^[a-z]+(\.[a-z0-9-]+)+$/, 'clé de traduction');

/** Couleur au format #rrggbb, en minuscules. */
export const ColorSchema = z.string().regex(/^#[0-9a-f]{6}$/, 'couleur #rrggbb');

/** Proportion dans [0, 1]. */
const ShareSchema = z.number().min(0).max(1);

/** Familles de biomes de la séance C1 (D6). */
export const BIOME_FAMILIES = [
  'water',
  'coast',
  'wetland',
  'cold',
  'mountain',
  'temperate',
  'arid',
  'tropical',
] as const;

/** Biome naturel (MON-08, MON-10, C1). */
export const BiomeSchema = z
  .object({
    id: IdSchema,
    family: z.enum(BIOME_FAMILIES),
    name: MessageKeySchema,
    /** Fertilité, de 0 (stérile) à 1. */
    fertility: ShareSchema,
    /**
     * Multiplicateur du coût de déplacement à pied ; null pour les eaux qu'on ne franchit
     * pas à pied (océans, lacs). Une rivière se franchit, selon sa classe (C1, D3).
     */
    movementCost: z.number().min(1).nullable(),
    /** Côtes (D4) : facilité de débarquement. */
    landing: z.enum(['easy', 'difficult', 'impossible']).optional(),
    /** Milieu propice aux maladies (D4, D5). */
    disease: z.boolean(),
    /** Ressources du milieu ; data/resources.json les définira (tâche 1.6). */
    resources: z.array(IdSchema),
    /** Densités de la flore, de 0 à 1 ; ses types viendront avec la tâche 1.6. */
    flora: z.object({ trees: ShareSchema, shrubs: ShareSchema }).strict(),
    /** Palette par rôles (REN-09) : ombre, base, lumière. */
    palette: z.object({ shadow: ColorSchema, base: ColorSchema, light: ColorSchema }).strict(),
  })
  .strict()
  .superRefine((biome, context) => {
    if (biome.movementCost === null && biome.family !== 'water') {
      context.addIssue({
        code: 'custom',
        message: "seule l'eau peut être infranchissable à pied",
        path: ['movementCost'],
      });
    }
    if ((biome.family === 'coast') !== (biome.landing !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'seules les côtes, et toutes les côtes, ont une facilité de débarquement',
        path: ['landing'],
      });
    }
  });

export type Biome = z.infer<typeof BiomeSchema>;

/** Liste de biomes, aux identifiants uniques. */
export const BiomesSchema = z.array(BiomeSchema).superRefine((biomes, context) => {
  const seen = new Set<string>();
  biomes.forEach((biome, index) => {
    if (seen.has(biome.id)) {
      context.addIssue({
        code: 'custom',
        message: `identifiant en double : ${biome.id}`,
        path: [index, 'id'],
      });
    }
    seen.add(biome.id);
  });
});

/** Familles de niveaux d'altitude (MON-05, C1 D11). */
export const ALTITUDE_FAMILIES = [
  'water',
  'shore',
  'plain',
  'hill',
  'low-mountain',
  'mid-mountain',
  'high-mountain',
  'summit',
] as const;

/** Navigation sur un niveau d'eau, du plus large au plus côtier (C1, D11). */
export const NAVIGATION = ['open-sea', 'offshore', 'near-coast', 'coasting'] as const;

/**
 * Niveau d'altitude (MON-05, MON-06, C1 D11) : ses bornes en mètres, négatives sous la
 * mer, et ses effets, qui multiplient ceux du biome. Un niveau d'eau se navigue ; un
 * niveau sans coût de déplacement est infranchissable à pied (eau, sommets).
 */
export const AltitudeLevelSchema = z
  .object({
    id: IdSchema,
    family: z.enum(ALTITUDE_FAMILIES),
    name: MessageKeySchema,
    /** Borne inférieure, incluse ; null pour le niveau le plus profond. */
    min: z.number().int().nullable(),
    /** Borne supérieure, exclue ; null pour le niveau le plus haut. */
    max: z.number().int().nullable(),
    movement: z.number().min(1).nullable(),
    navigation: z.enum(NAVIGATION).optional(),
    fertility: ShareSchema.nullable(),
    /** Constructions permises ; elles seront reliées aux bâtiments en phase 3. */
    construction: z.array(IdSchema),
  })
  .strict()
  .superRefine((level, context) => {
    const underwater = level.max !== null && level.max <= 0;
    if (underwater !== (level.navigation !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'seuls les niveaux sous la mer, et tous, se naviguent',
        path: ['navigation'],
      });
    }
    if (underwater !== (level.fertility === null)) {
      context.addIssue({
        code: 'custom',
        message: 'seuls les niveaux sous la mer, et tous, sont sans fertilité',
        path: ['fertility'],
      });
    }
  });

export type AltitudeLevel = z.infer<typeof AltitudeLevelSchema>;

/**
 * Liste des niveaux, du plus profond au plus haut : chacun commence où finit le
 * précédent, le premier sans borne inférieure, le dernier sans borne supérieure.
 */
export const AltitudeLevelsSchema = z
  .array(AltitudeLevelSchema)
  .min(1)
  .superRefine((levels, context) => {
    const seen = new Set<string>();
    levels.forEach((level, index) => {
      if (seen.has(level.id)) {
        context.addIssue({
          code: 'custom',
          message: `identifiant en double : ${level.id}`,
          path: [index, 'id'],
        });
      }
      seen.add(level.id);
      // Le premier niveau n'a pas de borne inférieure ; chaque autre commence au précédent.
      const expected = index === 0 ? null : (levels[index - 1]?.max ?? null);
      if (level.min !== expected) {
        context.addIssue({
          code: 'custom',
          message: 'les niveaux doivent se suivre sans trou ni recouvrement',
          path: [index, 'min'],
        });
      }
      if ((level.max === null) !== (index === levels.length - 1)) {
        context.addIssue({
          code: 'custom',
          message: 'seul le dernier niveau est sans borne supérieure',
          path: [index, 'max'],
        });
      }
      if (level.min !== null && level.max !== null && level.max <= level.min) {
        context.addIssue({ code: 'custom', message: 'niveau vide', path: [index, 'max'] });
      }
    });
  });
