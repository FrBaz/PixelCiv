/**
 * Humains des planches (tâche 2b.5, ADR 0016) : ce que le build lit des planches de
 * sprites/humans/skin/ (data/humans.json : tons de la base, grille des cases, régions du corps,
 * animations, niveaux de motifs, enfants composés, crédit du pack), et les tenues que
 * data/appearance.json pose sur ces régions (pièces et tenues), avec les bornes qu'impose le
 * code d'apparence du rendu (LOOK_BITS).
 *
 * Ce module n'importe que zod : l'extension de Vite qui range l'atlas (tools/human-atlas.ts)
 * le charge avec la configuration, dont le chargeur exige l'extension des imports relatifs.
 * D'où ses propres schémas de couleur et d'identifiant, les mêmes que ceux de schemas.ts.
 */
import { z } from 'zod';

/** Une couleur #rrggbb, en minuscules (comme schemas.ts). */
const ColorSchema = z.string().regex(/^#[0-9a-f]{6}$/u, 'couleur #rrggbb');

/** Un identifiant en minuscules et tirets (comme schemas.ts). */
const IdSchema = z.string().regex(/^[a-z]+(-[a-z]+)*$/u, 'identifiant en minuscules et tirets');

/** Quatre tons, rangés par rang : lumière, base, ombre, ombre profonde. */
export const Ramp4Schema = z.tuple([ColorSchema, ColorSchema, ColorSchema, ColorSchema]);
export type Ramp4 = z.infer<typeof Ramp4Schema>;

/** Trois tons, de la lumière à l'ombre, comme les cheveux du carnet de l'auteur (HAIR). */
export const Ramp3Schema = z.tuple([ColorSchema, ColorSchema, ColorSchema]);
export type Ramp3 = z.infer<typeof Ramp3Schema>;

/**
 * Bits de l'apparence d'un humain sur la carte (render/humans.ts, lookCode) : palette de peau,
 * allèle des cheveux, cran de gris, tenue, sorte de corps. Les données ne peuvent déclarer plus
 * de palettes de peau ni de tenues que ces bits n'en comptent : une de trop prendrait sans bruit
 * l'apparence d'une autre. Le cran de gris suit GREY_LEVELS (core/visual.ts), l'allèle
 * MAX_ALLELES (core/data/people.ts) : 4 crans et 16 allèles, que vérifie checkContent.
 */
export const LOOK_BITS = { skin: 3, hair: 4, grey: 2, outfit: 4, body: 2 } as const;
export const MAX_SKIN_PALETTES = 1 << LOOK_BITS.skin;
export const MAX_OUTFITS = 1 << LOOK_BITS.outfit;

/**
 * Rôle d'un pixel de l'atlas, sur un octet (src/gen/humans.ts) : 0 transparent ; de 1 à
 * MAX_KEPT_TONES, les tons gardés ; à partir de RECOLOR, huit rôles par région (deux sources,
 * quatre rangs). Le rendu range la palette d'une apparence sur PALETTE_ROLES rôles : d'où
 * MAX_REGIONS régions au plus.
 */
export const RECOLOR = 16;
export const MAX_KEPT_TONES = RECOLOR - 1;
export const PALETTE_ROLES = 128;
export const MAX_REGIONS = (PALETTE_ROLES - RECOLOR) / 8;

/** Une région du corps : son identifiant, sa lettre dans les grilles, et ce qu'elle porte. */
const RegionSchema = z
  .object({
    id: IdSchema,
    /** Une majuscule : « o » désigne un ton gardé, « . » le transparent. */
    letter: z.string().regex(/^[A-Z]$/u, 'une majuscule'),
    /** Les cheveux s'y posent : la région du crâne, qui prend leurs tons. */
    hair: z.boolean().optional(),
    /** Elle fait partie de la tête, que les enfants composés réduisent moins que le corps. */
    head: z.boolean().optional(),
  })
  .strict();
export type Region = z.infer<typeof RegionSchema>;

const AnimationSchema = z
  .object({
    id: IdSchema,
    /** Rangée de la planche, comptée de 0, et nombre d'images. */
    row: z.number().int().min(0),
    frames: z.number().int().min(1),
    /**
     * Cadence : `steps` pas par cycle, au rythme d'un pas du rendu (STEP_MS, ADR 0014), ou
     * `frameMs` millisecondes par image, quelle que soit la vitesse.
     */
    steps: z.number().int().min(1).optional(),
    frameMs: z.number().positive().optional(),
    loop: z.boolean().default(true),
    /**
     * Montrée en jeu : rangée dans l'atlas du jeu, à tous les niveaux. Les autres sont lues,
     * vérifiées et habillées par le build et les tests, et attendent 2b.8.
     */
    shown: z.boolean().default(false),
  })
  .strict()
  .refine((a) => (a.steps === undefined) !== (a.frameMs === undefined), {
    message: 'une cadence : steps ou frameMs',
  });

const LevelSchema = z
  .object({
    /** Facteur de réduction de la planche : 1 pour sa taille. */
    factor: z.number().min(1),
    /** Contour des réductions : gardé tel quel, retracé là où la forme est épaisse, ou ôté. */
    outline: z.enum(['keep', 'thick', 'none']),
    /** Variantes de hauteur des adultes, en rangées autour de la réduction : trois au plus. */
    variants: z.array(z.number().int()).min(1).max(3),
    /**
     * Grille de la tête des adultes : celle des pieds, avec le corps, ou la sienne, calée sous
     * les yeux, pour qu'une rangée de visage reste sous la rangée des yeux (src/gen/humans.ts,
     * reduceFigure ; ADR 0016, § 7).
     */
    head: z.enum(['feet', 'eyes']).default('feet'),
  })
  .strict()
  .refine((level) => new Set(level.variants).size === level.variants.length, {
    message: 'des variantes distinctes',
  });

const YoungSchema = z
  .object({
    /** Rangées de la figure et de sa tête, au niveau de la planche à sa taille. */
    rows: z.number().int().min(4),
    head: z.number().int().min(2),
  })
  .strict()
  .refine((y) => y.head < y.rows, { message: 'la tête est plus petite que la figure' });

export const HumansSchema = z
  .object({
    sheets: z.object({ female: z.string(), male: z.string() }).strict(),
    /** Le pack des planches, crédité dans CREDITS.md dès son intégration (AST-02, ADR 0008). */
    credit: z
      .object({
        title: z.string().min(1),
        author: z.string().min(1),
        url: z.url(),
      })
      .strict(),
    cell: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        /** Point des pieds, au milieu du bas de la case. */
        anchor: z.tuple([z.number().int(), z.number().int()]),
      })
      .strict(),
    regions: z.array(RegionSchema).min(1).max(MAX_REGIONS),
    tones: z
      .object({
        /**
         * Tons gardés tels quels, rangés dans cet ordre : les contours, les yeux (que les
         * réductions gardent d'un bloc où ils comptent assez), puis les autres traits.
         */
        outline: z.array(ColorSchema).min(1),
        eye: z.array(ColorSchema).min(1),
        kept: z.array(ColorSchema),
        /** Tons de la peau et du sous-vêtement de la base, par rang. */
        skin: Ramp4Schema,
        under: Ramp4Schema,
        /** Autres tons rattachés à un rang : les joues, le point du haut. */
        skinAlso: z.record(ColorSchema, z.number().int().min(0).max(3)),
        underAlso: z.record(ColorSchema, z.number().int().min(0).max(3)),
      })
      .strict(),
    animations: z.array(AnimationSchema).min(1),
    levels: z.array(LevelSchema).min(1),
    young: z
      .object({
        /** Le corps dont on tire enfants et nourrissons, de l'un ou l'autre sexe. */
        body: z.enum(['female', 'male']),
        child: z.array(YoungSchema).min(1).max(3),
        baby: z.array(YoungSchema).min(1).max(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((h, context) => {
    const issue = (message: string, path: (string | number)[]) => {
      context.addIssue({ code: 'custom', message, path });
    };
    const ids = h.regions.map((region) => region.id);
    const letters = h.regions.map((region) => region.letter);
    if (new Set(ids).size !== ids.length) issue('des régions distinctes', ['regions']);
    if (new Set(letters).size !== letters.length) issue('une lettre par région', ['regions']);
    if (h.regions.filter((region) => region.hair === true).length !== 1) {
      issue('une seule région porte les cheveux', ['regions']);
    }
    if (!h.regions.some((region) => region.head === true)) {
      issue('au moins une région de la tête', ['regions']);
    }
    const { outline, eye, kept, skin, under, skinAlso, underAlso } = h.tones;
    const keptTones = [...outline, ...eye, ...kept];
    if (keptTones.length > MAX_KEPT_TONES) {
      issue(`${String(MAX_KEPT_TONES)} tons gardés au plus`, ['tones']);
    }
    const all = [
      ...keptTones,
      ...skin,
      ...under,
      ...Object.keys(skinAlso),
      ...Object.keys(underAlso),
    ];
    if (new Set(all).size !== all.length) issue('chaque ton une seule fois', ['tones']);
    const animations = h.animations.map((animation) => animation.id);
    if (new Set(animations).size !== animations.length) {
      issue('des animations distinctes', ['animations']);
    }
    for (const id of ['idle', 'walk']) {
      const animation = h.animations.find((entry) => entry.id === id);
      if (animation === undefined) issue(`une animation ${id}`, ['animations']);
      else if (!animation.shown) issue(`l'animation ${id} est montrée`, ['animations']);
    }
    const first = h.levels.at(0);
    if (first?.factor !== 1 || first.variants.join() !== '0') {
      issue('le premier niveau est la planche à sa taille, sans variante', ['levels', 0]);
    }
    for (let index = 1; index < h.levels.length; index++) {
      if (h.levels[index].factor <= h.levels[index - 1].factor) {
        issue('des niveaux de plus en plus réduits', ['levels', index, 'factor']);
      }
    }
  });

export type Humans = z.infer<typeof HumansSchema>;

/** Une pièce d'une tenue : un tissu, et les régions du corps qu'elle couvre. */
export const PieceSchema = z
  .object({ fabric: IdSchema, regions: z.array(IdSchema).min(1) })
  .strict();
export type Piece = z.infer<typeof PieceSchema>;

/**
 * Une tenue, pour chaque corps : femme, homme, enfant, nourrisson. Une pièce plus loin dans la
 * liste recouvre la précédente là où elles se chevauchent. Ses régions sont celles de
 * data/humans.json (core/data/index.ts, checkContent), et elle couvre toutes celles où chaque
 * corps montre le sous-vêtement des planches (le build le vérifie, tools/human-atlas.ts).
 */
export const OutfitSchema = z
  .object({
    id: IdSchema,
    female: z.array(PieceSchema).min(1),
    male: z.array(PieceSchema).min(1),
    child: z.array(PieceSchema).min(1),
    baby: z.array(PieceSchema).min(1),
  })
  .strict();
export type Outfit = z.infer<typeof OutfitSchema>;

/** Les sortes de corps d'une tenue, dans l'ordre de leur code (LOOK_BITS.body). */
export const BODY_KINDS = ['female', 'male', 'child', 'baby'] as const;
export type BodyKind = (typeof BODY_KINDS)[number];
