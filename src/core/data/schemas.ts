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
