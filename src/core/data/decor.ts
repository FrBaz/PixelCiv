/**
 * Décor en objets (tâche 2b.6 ; MON-10, REN-09, REN-10 ; ADR 0017) : l'apparence des espèces de
 * la flore (data/flora.json, `look`) et les réglages du décor (data/decor.json). N'importe que
 * zod : l'extension de Vite qui range l'atlas du décor (tools/decor-atlas.ts) le charge avec la
 * configuration.
 *
 * Les couleurs sont des rampes de quatre tons, de la lumière à l'ombre profonde, que le rendu
 * pose sur les rôles des motifs (src/render/decor.ts) : aucune couleur n'y est calculée.
 */
import { z } from 'zod';

const ColorSchema = z.string().regex(/^#[0-9a-f]{6}$/u, 'couleur #rrggbb');
/** Identifiant textuel, comme ceux de src/core/data/schemas.ts : minuscules et tirets. */
const IdSchema = z.string().regex(/^[a-z]+(-[a-z]+)*$/u, 'identifiant en minuscules et tirets');
const ShareSchema = z.number().min(0).max(1);
/** Un mois de l'année, de 0 (janvier) à 11 (décembre). */
const MonthSchema = z.number().int().min(0).max(11);
/** Une étendue [plus petit, plus grand] dans une case, en part de son côté. */
const SpanSchema = z
  .tuple([ShareSchema, ShareSchema])
  .refine(([low, high]) => low <= high, { message: 'une étendue [plus petit, plus grand]' });

/** Rampe de quatre tons : lumière, base, ombre, ombre profonde. */
export const DecorRampSchema = z.tuple([ColorSchema, ColorSchema, ColorSchema, ColorSchema]);
export type DecorRamp = z.infer<typeof DecorRampSchema>;

/**
 * Saisons d'une espèce : persistante (toujours feuillée), caduque (automne, puis nue en hiver),
 * ou sèche (ses tons secs pendant la saison sèche des tropiques).
 */
export const PHENOLOGIES = ['evergreen', 'deciduous', 'dry'] as const;
export type Phenology = (typeof PHENOLOGIES)[number];

/** Le fruit d'une espèce (baies, fleurs, noix, massettes) : ses tons, et ses mois au nord. */
export const FruitSchema = z
  .object({
    tones: DecorRampSchema,
    /** Mois où il se montre, au nord ; décalés de six mois au sud. */
    months: z
      .array(MonthSchema)
      .min(1)
      .max(12)
      .refine((months) => new Set(months).size === months.length, {
        message: 'chaque mois une fois',
      }),
  })
  .strict();

/**
 * Apparence d'une espèce de la flore (MON-10, C1 D9) : le nom de ses grilles (`form`), celui de
 * ses grilles nues (`bare`, pour une caduque qui en a), ses saisons et ses tons. Une caduque
 * sans grilles nues garde sa forme en hiver, aux tons de `foliage.bare` (un buisson de
 * brindilles, des roseaux secs).
 */
export const FloraLookSchema = z
  .object({
    form: IdSchema,
    bare: IdSchema.optional(),
    phenology: z.enum(PHENOLOGIES),
    foliage: z
      .object({
        summer: DecorRampSchema,
        autumn: DecorRampSchema.optional(),
        bare: DecorRampSchema.optional(),
        dry: DecorRampSchema.optional(),
      })
      .strict(),
    wood: DecorRampSchema,
    fruit: FruitSchema.optional(),
  })
  .strict()
  .superRefine((look, context) => {
    const issue = (message: string, path: (string | number)[]) => {
      context.addIssue({ code: 'custom', message, path });
    };
    const deciduous = look.phenology === 'deciduous';
    if (deciduous && look.foliage.autumn === undefined) {
      issue("une espèce caduque a ses tons d'automne", ['foliage', 'autumn']);
    }
    if (deciduous && look.bare === undefined && look.foliage.bare === undefined) {
      issue("une espèce caduque a sa forme nue ou ses tons d'hiver", ['bare']);
    }
    if (!deciduous && (look.bare !== undefined || look.foliage.bare !== undefined)) {
      issue("seule une espèce caduque a une forme ou des tons d'hiver", ['bare']);
    }
    if (!deciduous && look.foliage.autumn !== undefined) {
      issue("seule une espèce caduque a des tons d'automne", ['foliage', 'autumn']);
    }
    if ((look.phenology === 'dry') !== (look.foliage.dry !== undefined)) {
      issue('une espèce de saison sèche, et elle seule, a ses tons secs', ['foliage', 'dry']);
    }
  });
export type FloraLook = z.infer<typeof FloraLookSchema>;

/**
 * Méthodes de l'ombre portée (ADR 0017, § 4) : `ground`, le ton d'ombre de la palette de la case
 * sous chaque pixel d'ombre, lu par le shader (fidèle aux palettes, C1 D10) ; `multiply`, un
 * noir translucide qui assombrit le sol ; `dither`, une trame du ton du contour, un pixel sur
 * deux ; `none`, pas d'ombre.
 */
export const SHADOW_METHODS = ['ground', 'multiply', 'dither', 'none'] as const;
export type ShadowMethod = (typeof SHADOW_METHODS)[number];

/** Ce qu'une occupation du sol (C1 D7, phase 3) laisse du décor naturel : une part par sorte. */
export const LandUseSchema = z
  .object({ trees: ShareSchema, shrubs: ShareSchema, rocks: ShareSchema })
  .strict();
export type LandUse = z.infer<typeof LandUseSchema>;

/** Réglages du décor (data/decor.json). */
export const DecorSchema = z
  .object({
    /** Contour des motifs : celui des planches de sprites/ et des humains. */
    outline: ColorSchema,
    /**
     * Ombre portée : sa méthode, l'opacité du noir de `multiply`, et sa projection, en part de la
     * hauteur du pixel au-dessus des pieds (vers l'ouest, vers le sud).
     */
    shadow: z
      .object({
        method: z.enum(SHADOW_METHODS),
        alpha: ShareSchema,
        sx: z.number().min(0).max(1.5),
        sy: z.number().min(0).max(1),
      })
      .strict(),
    /**
     * Neige : la part de neige de la case (celle du shader de la carte) à partir de laquelle un
     * objet s'enneige, et le ton le plus profond de sa neige, sous les trois de la palette de
     * couverture de son biome.
     */
    snow: z.object({ share: ShareSchema, deep: ColorSchema }).strict(),
    /**
     * Feuillage : nu sous `bareBelow` °C (là où le mois le plus froid y descend), en automne sous
     * `autumnBelow` °C quand le mois refroidit, sec quand la pluie du mois tombe sous `dryShare`
     * de la moyenne.
     */
    foliage: z
      .object({
        bareBelow: z.number().min(-30).max(40),
        autumnBelow: z.number().min(-30).max(40),
        dryShare: ShareSchema,
      })
      .strict()
      .refine((foliage) => foliage.bareBelow <= foliage.autumnBelow, {
        message: "l'automne commence avant que les arbres ne soient nus",
      }),
    /**
     * Places dans la case, en part de son côté : l'écart de l'arbre au centre (`jitter`, ses
     * pieds restant dans la case) ; le buisson à côté de l'arbre (`side`) et devant lui
     * (`depth`) ; le rocher du côté opposé à l'arbre (`side`, depuis le centre), à `depth`.
     */
    place: z
      .object({
        jitter: z.number().min(0).max(0.45),
        shrub: z.object({ side: SpanSchema, depth: SpanSchema }).strict(),
        rock: z.object({ side: z.number().min(0).max(0.45), depth: SpanSchema }).strict(),
      })
      .strict(),
    /** Tons de la pierre des rochers. */
    stone: DecorRampSchema,
    /** Rochers épars : la chance d'un rocher par case, par biome. */
    rocks: z.record(IdSchema, ShareSchema),
    /**
     * Aspect du rocher de chaque gisement (data/resources.json) : sa forme, et les tons de son
     * minerai ; sans eux, une roche nue, qui dit où est le gisement mais pas ce qu'il est.
     */
    deposits: z.record(
      IdSchema,
      z.object({ form: IdSchema, ore: DecorRampSchema.optional() }).strict(),
    ),
    /**
     * Occupation du sol (C1 D7) : la part du décor naturel que garde chaque occupation. Seule
     * `none` existe avant la phase 3, qui ajoutera les champs, les coupes, les friches…
     */
    landUse: z
      .record(IdSchema, LandUseSchema)
      .refine((uses) => Object.hasOwn(uses, 'none'), { message: "l'occupation « none » existe" }),
  })
  .strict();
export type Decor = z.infer<typeof DecorSchema>;
