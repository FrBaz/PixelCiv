/**
 * Schémas du contenu du jeu (NF-07, ADR 0006). Le contenu vit dans data/, en JSON ;
 * ces schémas le valident au démarrage et dans les tests, donc dans l'intégration
 * continue. Les textes affichés sont des clés de traduction.
 */
import { z } from 'zod';
import { FloraLookSchema } from './decor';
import {
  bakedWaterTone,
  CREST_TONES,
  MAX_CREST_LENGTH,
  MAX_CREST_THICKNESS,
  MAX_WAVE_BIOMES,
} from '../waves';

/** Identifiant textuel : minuscules et tirets, comme « deep-ocean ». */
export const IdSchema = z
  .string()
  .regex(/^[a-z]+(-[a-z]+)*$/, 'identifiant en minuscules et tirets');

/** Clé de traduction, vérifiée contre le catalogue par les tests. */
export const MessageKeySchema = z.string().regex(/^[a-z]+(\.[a-z0-9-]+)+$/, 'clé de traduction');

/** Couleur au format #rrggbb, en minuscules. */
export const ColorSchema = z.string().regex(/^#[0-9a-f]{6}$/, 'couleur #rrggbb');

/** Proportion dans [0, 1]. */
export const ShareSchema = z.number().min(0).max(1);

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

/** Motifs des tuiles : herbe, forêt, sable, roche, glace, marais, eau. */
export const TILE_STYLES = ['grass', 'forest', 'sand', 'rock', 'ice', 'marsh', 'water'] as const;

/**
 * Végétation d'un biome, pour le rendu des saisons (C1, D10) : persistante, caduque,
 * herbe, herbe tropicale, toundra, ou aucune.
 */
export const VEGETATION_TYPES = [
  'none',
  'evergreen',
  'deciduous',
  'grass',
  'tropical-grass',
  'tundra',
] as const;

/** Couvertures saisonnières (C1, D9) : neige, glace d'eau douce, banquise côtière. */
export const SEASON_COVERS = ['none', 'snow', 'ice', 'sea-ice'] as const;

/**
 * Mer animée d'un biome d'eau (tâche 2b.4, ADR 0015) : ses crêtes, qui glissent en
 * diagonale, et ses clapots. Les parts sont celles des blocs de 16 × 16 pixels qui en
 * portent ; longueur et épaisseur, en pixels de carte, sont bornées pour qu'une crête tienne
 * dans son bloc (src/core/waves.ts) ; la crête éclaircit jusqu'à la base ou la lumière de la
 * palette, jamais jusqu'à l'ombre, que prend le clapot.
 */
export const WavesSchema = z
  .object({
    crest: z
      .object({
        share: ShareSchema,
        length: z.number().int().min(1).max(MAX_CREST_LENGTH),
        thickness: z.number().int().min(1).max(MAX_CREST_THICKNESS),
        tone: z.enum(CREST_TONES),
      })
      .strict(),
    ripple: z.object({ share: ShareSchema }).strict(),
  })
  .strict();

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
     * pas à pied : océans, lacs, et lit des fleuves, qu'on passe par un pont ou un bac
     * (C1, D3). Ruisseaux et rivières coulent sur les autres biomes.
     */
    movementCost: z.number().min(1).nullable(),
    /** Côtes (D4) : facilité de débarquement. */
    landing: z.enum(['easy', 'difficult', 'impossible']).optional(),
    /** Milieu propice aux maladies (D4, D5). */
    disease: z.boolean(),
    /** Ressources du milieu (data/resources.json). */
    resources: z.array(IdSchema),
    /**
     * Rendement d'une case au sommet de la saison (RES-03, RES-04, FAU-01), en besoins
     * mensuels d'un adulte : cueillette, chasse, pêche.
     */
    forage: z
      .object({ plants: z.number().min(0), game: z.number().min(0), fish: z.number().min(0) })
      .strict(),
    /**
     * Flore : densités d'arbres et de buissons, de 0 à 1, et espèces (data/flora.json). Le décor
     * (ADR 0017) tire l'espèce d'un arbre ou d'un buisson parmi celles de sa sorte, selon leur
     * poids (`weights`, 1 par défaut).
     */
    flora: z
      .object({
        trees: ShareSchema,
        shrubs: ShareSchema,
        species: z.array(IdSchema),
        weights: z.record(IdSchema, z.number().min(0.01).max(100)).optional(),
      })
      .strict()
      .refine(
        (flora) => Object.keys(flora.weights ?? {}).every((id) => flora.species.includes(id)),
        { message: 'un poids pour une espèce du biome', path: ['weights'] },
      ),
    /**
     * Faune (MON-10, FAU-01 ; ADR 0018) : qualité de l'habitat, de 0 à 1, pour chaque espèce de
     * gibier qu'il abrite (data/fauna.json) ; vide là où rien ne vit.
     */
    fauna: z.record(IdSchema, ShareSchema),
    /** Palette par rôles (REN-09) : ombre, base, lumière. */
    palette: z.object({ shadow: ColorSchema, base: ColorSchema, light: ColorSchema }).strict(),
    /** Motif des tuiles de 4 px (REN-01), que la cuisson tire de la palette. */
    tile: z.enum(TILE_STYLES),
    /** Végétation, pour le rendu des saisons (C1, D10). */
    vegetation: z.enum(VEGETATION_TYPES),
    /**
     * Saisons (C1, D9 et D10) : ce qui couvre le biome par grand froid (neige sur les
     * terres, glace sur l'eau douce, banquise sur la mer côtière, rien sinon) et la palette
     * de cette couverture, propre au biome.
     */
    seasons: z
      .object({
        cover: z.enum(SEASON_COVERS),
        palette: z
          .object({ shadow: ColorSchema, base: ColorSchema, light: ColorSchema })
          .strict()
          .optional(),
      })
      .strict()
      .refine((seasons) => (seasons.cover === 'none') === (seasons.palette === undefined), {
        message: 'une couverture saisonnière, et elle seule, a sa palette',
      }),
    /** Mer animée (ADR 0015) : seuls les biomes qui en ont une bougent. */
    waves: WavesSchema.optional(),
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
    if ((biome.family === 'water') !== (biome.tile === 'water')) {
      context.addIssue({
        code: 'custom',
        message: 'les eaux, et elles seules, ont le motif « eau »',
        path: ['tile'],
      });
    }
    const waterCover = biome.seasons.cover === 'ice' || biome.seasons.cover === 'sea-ice';
    if (biome.family !== 'water' && waterCover) {
      context.addIssue({
        code: 'custom',
        message: 'seules les eaux gèlent ; les terres ont de la neige',
        path: ['seasons', 'cover'],
      });
    }
    if (biome.waves !== undefined && biome.family !== 'water') {
      context.addIssue({
        code: 'custom',
        message: 'seules les eaux ont une mer animée',
        path: ['waves'],
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

/**
 * Liste de biomes, aux identifiants uniques. Au plus MAX_WAVE_BIOMES biomes ont une mer
 * animée, et le ton cuit de chacun de leurs pixels d'eau ne se retrouve dans aucune autre eau :
 * le shader reconnaît le biome d'un pixel à ce ton (ADR 0015).
 */
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
  const animated = biomes.filter((biome) => biome.waves !== undefined);
  if (animated.length > MAX_WAVE_BIOMES) {
    context.addIssue({
      code: 'custom',
      message: `${String(animated.length)} biomes ont une mer animée, ${String(MAX_WAVE_BIOMES)} au plus`,
      path: [],
    });
  }
  // Les tons cuits de chaque eau, pour reconnaître une eau animée à son ton.
  const tones = (biome: Biome) => {
    const { shadow, base, light } = biome.palette;
    return new Set([shadow, base, light].map(bakedWaterTone));
  };
  const waters = biomes.flatMap((biome, index) =>
    biome.family === 'water' ? [{ biome, index, tones: tones(biome) }] : [],
  );
  waters.forEach((first, rank) => {
    for (const second of waters.slice(rank + 1)) {
      if (first.biome.waves === undefined && second.biome.waves === undefined) continue;
      const shared = [...first.tones].find((tone) => second.tones.has(tone));
      if (shared === undefined) continue;
      const hex = `#${shared.toString(16).padStart(6, '0')}`;
      context.addIssue({
        code: 'custom',
        message: `${first.biome.id} et ${second.biome.id} partagent le ton cuit ${hex} : le shader de la mer animée ne saurait plus les distinguer`,
        path: [second.index, 'palette'],
      });
    }
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
    /** Couleur du mode de carte « relief ». */
    color: ColorSchema,
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

/** Liste d'entrées aux identifiants uniques. */
export function uniqueIds<T extends { readonly id: string }>(entry: z.ZodType<T>) {
  return z.array(entry).superRefine((entries, context) => {
    const seen = new Set<string>();
    entries.forEach((item, index) => {
      if (seen.has(item.id)) {
        context.addIssue({
          code: 'custom',
          message: `identifiant en double : ${item.id}`,
          path: [index, 'id'],
        });
      }
      seen.add(item.id);
    });
  });
}

/**
 * Gisement d'un minerai (RES-01) : sa fréquence sur les cases qui l'admettent, selon
 * l'étage d'altitude ou le biome, et les provinces où il se regroupe.
 */
export const DepositSchema = z
  .object({
    /** Part des cases admises qui portent un gisement, en moyenne. */
    abundance: ShareSchema,
    /** Familles de niveaux d'altitude où il se trouve (data/altitude-levels.json). */
    altitudes: z.array(z.enum(ALTITUDE_FAMILIES)),
    /** Biomes où il se trouve, à toute altitude. */
    biomes: z.array(IdSchema).optional(),
    /** Fréquence du bruit qui dessine les provinces, et part des terres qu'elles couvrent. */
    provinceFrequency: z.number().positive(),
    provinceShare: z.number().gt(0).max(1),
  })
  .strict();

/** Ressource (RES-01, RES-03 à RES-05) : minerai à gisements, ou ressource vivante du milieu. */
export const ResourceSchema = z
  .object({
    id: IdSchema,
    kind: z.enum(['mineral', 'living']),
    name: MessageKeySchema,
    /** Couleur du mode de carte « ressources ». */
    color: ColorSchema,
    deposit: DepositSchema.optional(),
    /**
     * Ressource du milieu montrée en mode « ressources » sur les biomes qui la portent
     * (data/biomes.json) : celles des milieux humides et salés (RES-05).
     */
    overlay: z.boolean().optional(),
  })
  .strict()
  .refine((resource) => (resource.kind === 'mineral') === (resource.deposit !== undefined), {
    message: 'seuls les minerais, et tous, ont des gisements',
    path: ['deposit'],
  });

export type Resource = z.infer<typeof ResourceSchema>;
export const ResourcesSchema = uniqueIds(ResourceSchema);

/** Espèce de la flore : arbre ou buisson (MON-10), et son apparence dans le décor (ADR 0017). */
export const FloraSchema = z
  .object({
    id: IdSchema,
    kind: z.enum(['tree', 'shrub']),
    name: MessageKeySchema,
    look: FloraLookSchema,
  })
  .strict();

export type Flora = z.infer<typeof FloraSchema>;
export const FlorasSchema = uniqueIds(FloraSchema);
