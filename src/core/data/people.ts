/**
 * Schémas des espèces et de la génétique (tâche 2.2 ; IND-05, IND-06, ESP-01 à ESP-04,
 * ADR 0011) : data/species.json et data/genetics.json.
 *
 * Le génome d'un individu tient en GENOME_WORDS mots de 32 bits : huit locus discrets à
 * deux allèles de 4 bits (dominants ou récessifs), puis huit traits continus de 8 bits
 * (moyenne des parents et variation). Les données ne peuvent donc pas décrire plus de
 * huit locus, de seize allèles chacun, ni plus de huit traits.
 *
 * Le code ne nomme aucun locus, aucun trait ni aucun allèle (D-6, A-10, W-12) : ce que
 * dessinent les portraits et les mini-sprites se désigne dans les données, par le rôle
 * d'un locus ou d'un trait, et chaque allèle d'un rôle porte ce qu'il en faut dessiner,
 * sa couleur ou sa forme.
 */
import { z } from 'zod';
import { DataError } from './catalog';
import { IdSchema, MessageKeySchema, ShareSchema, uniqueIds } from './schemas';

export const MAX_LOCI = 8;
export const MAX_ALLELES = 16;
export const MAX_TRAITS = 8;
/** Sous-espèces d'une espèce, au plus : autant que de parts d'ascendance. */
export const MAX_SUBSPECIES = 4;

const ColorSchema = z.string().regex(/^#[0-9a-f]{6}$/, 'couleur #rrggbb');

/**
 * Rôles d'un locus : la couleur des yeux, celle des cheveux, la forme du visage et celle du
 * nez. Chacun est tenu par un locus, et un seul ; un locus sans rôle se lit dans la fiche,
 * sans se dessiner.
 */
export const LOCUS_ROLES = ['eyes', 'hair', 'face', 'nose'] as const;
export type LocusRole = (typeof LOCUS_ROLES)[number];

/**
 * Rôles d'un trait continu : le teint, qui parcourt la rampe de data/appearance.json, et la
 * taille, entre les deux bouts de `height` de l'espèce. Chacun est tenu par un trait, et un
 * seul.
 */
export const TRAIT_ROLES = ['skin', 'height'] as const;
export type TraitRole = (typeof TRAIT_ROLES)[number];

/**
 * Bornes de la forme du visage. Le portrait d'un adulte y garde ses yeux et sa bouche dans
 * la tête, et tout son dessin dans le canevas (src/gen/portrait.test.ts) : plus étroite, la
 * tête perd le coin des yeux ; plus resserrée, la mâchoire coupe la bouche.
 */
export const FACE_BOUNDS = {
  width: [10, 16],
  height: [10, 20],
  jaw: [0, 0.6],
} as const;

/**
 * Forme du visage d'un allèle du rôle « face », en pixels du portrait de 64 × 64 :
 * demi-largeur et demi-hauteur de la tête adulte ; exposant du contour, 2 pour une ellipse,
 * 4 pour un visage carré ; rétrécissement de la mâchoire vers le menton.
 */
const FaceShapeSchema = z
  .object({
    width: z.number().int().min(FACE_BOUNDS.width[0]).max(FACE_BOUNDS.width[1]),
    height: z.number().int().min(FACE_BOUNDS.height[0]).max(FACE_BOUNDS.height[1]),
    power: z.union([z.literal(2), z.literal(4)]),
    jaw: z.number().min(FACE_BOUNDS.jaw[0]).max(FACE_BOUNDS.jaw[1]),
  })
  .strict();

export type FaceShape = z.infer<typeof FaceShapeSchema>;

/**
 * Bornes de la forme du nez : son arête monte au plus jusqu'aux yeux de l'adulte, à 4
 * pixels du bout du nez, et ses narines restent dans le visage le plus étroit.
 */
export const NOSE_BOUNDS = {
  length: [1, 4],
  wing: [1, 4],
} as const;

/**
 * Forme du nez d'un allèle du rôle « nose », en pixels du portrait : longueur de l'arête
 * au-dessus du bout du nez ; bosse au milieu de l'arête ; demi-largeur des narines ; base
 * pleine, d'une narine à l'autre.
 */
const NoseShapeSchema = z
  .object({
    length: z.number().int().min(NOSE_BOUNDS.length[0]).max(NOSE_BOUNDS.length[1]),
    hump: z.boolean(),
    wing: z.number().int().min(NOSE_BOUNDS.wing[0]).max(NOSE_BOUNDS.wing[1]),
    base: z.boolean(),
  })
  .strict();

export type NoseShape = z.infer<typeof NoseShapeSchema>;

/** Allèle d'un locus discret : le plus dominant des deux s'exprime. */
const AlleleSchema = z
  .object({
    id: IdSchema,
    name: MessageKeySchema,
    /** Rang de dominance : à rang égal, l'allèle qui vient d'abord dans la liste l'emporte. */
    dominance: z.number().int().min(0),
    /** Couleur, pour les rôles « eyes » et « hair ». */
    color: ColorSchema.optional(),
    /** Forme du visage, pour le rôle « face ». */
    face: FaceShapeSchema.optional(),
    /** Forme du nez, pour le rôle « nose ». */
    nose: NoseShapeSchema.optional(),
  })
  .strict();

/** Ce que chaque rôle demande à chacun de ses allèles. */
const ROLE_PARAMETER = {
  eyes: 'color',
  hair: 'color',
  face: 'face',
  nose: 'nose',
} as const satisfies Record<LocusRole, 'color' | 'face' | 'nose'>;

const ALLELE_PARAMETERS = ['color', 'face', 'nose'] as const;

const LocusSchema = z
  .object({
    id: IdSchema,
    name: MessageKeySchema,
    role: z.enum(LOCUS_ROLES).optional(),
    alleles: uniqueIds(AlleleSchema).min(2).max(MAX_ALLELES),
  })
  .strict()
  .superRefine((locus, context) => {
    // Chaque allèle porte ce que demande le rôle de son locus, et rien d'autre : un locus
    // sans rôle ne se dessine pas, ses allèles n'ont ni couleur ni forme.
    const { role } = locus;
    const wanted = role === undefined ? undefined : ROLE_PARAMETER[role];
    locus.alleles.forEach((allele, index) => {
      for (const parameter of ALLELE_PARAMETERS) {
        const present = allele[parameter] !== undefined;
        if (present === (parameter === wanted)) continue;
        context.addIssue({
          code: 'custom',
          message:
            role === undefined
              ? 'sans emploi pour un locus sans rôle'
              : present
                ? `sans emploi pour le rôle ${role}`
                : `demandé par le rôle ${role}`,
          path: ['alleles', index, parameter],
        });
      }
    });
  });

/** Trait continu, de 0 à 1, stocké sur 8 bits. */
const TraitSchema = z
  .object({
    id: IdSchema,
    name: MessageKeySchema,
    role: z.enum(TRAIT_ROLES).optional(),
    /** Écart type de la variation autour de la moyenne des parents. */
    variation: ShareSchema,
  })
  .strict();

/**
 * Relève les rôles que ne tient aucune entrée, ou que plusieurs tiennent ; `kind` nomme les
 * entrées, au singulier puis au pluriel.
 */
function eachRoleOnce(
  roles: readonly string[],
  entries: readonly { readonly role?: string | undefined }[],
  kind: readonly [one: string, many: string],
  context: z.core.$RefinementCtx,
  path: string,
): void {
  for (const role of roles) {
    const holders = entries.filter((entry) => entry.role === role).length;
    if (holders === 1) continue;
    context.addIssue({
      code: 'custom',
      message:
        holders === 0
          ? `aucun ${kind[0]} ne tient le rôle ${role}`
          : `plusieurs ${kind[1]} tiennent le rôle ${role}`,
      path: [path],
    });
  }
}

export const GeneticsSchema = z
  .object({
    loci: uniqueIds(LocusSchema).max(MAX_LOCI),
    traits: uniqueIds(TraitSchema).max(MAX_TRAITS),
    mutation: z
      .object({
        /**
         * Probabilité, par locus et par naissance, qu'un allèle transmis soit remplacé par un
         * allèle tiré au hasard parmi ceux du locus, parfois le même.
         */
        allele: ShareSchema,
        /** Probabilité, par trait et par naissance, d'un écart tiré au sort, et sa largeur. */
        trait: ShareSchema,
        jump: ShareSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((genetics, context) => {
    eachRoleOnce(LOCUS_ROLES, genetics.loci, ['locus', 'locus'], context, 'loci');
    eachRoleOnce(TRAIT_ROLES, genetics.traits, ['trait', 'traits'], context, 'traits');
  });

export type Genetics = z.infer<typeof GeneticsSchema>;
export type Locus = z.infer<typeof LocusSchema>;
export type Allele = Locus['alleles'][number];
export type Trait = z.infer<typeof TraitSchema>;

/**
 * Rang, dans data/genetics.json, du locus et du trait qui tiennent chaque rôle : ce que
 * les portraits, les mini-sprites et les fiches dessinent ou montrent à part.
 */
export interface GeneRoles {
  readonly loci: Readonly<Record<LocusRole, number>>;
  readonly traits: Readonly<Record<TraitRole, number>>;
}

const rolesOf = new WeakMap<object, GeneRoles>();

/**
 * Rôles d'une génétique validée, calculés une fois par objet. Le schéma garantit que chaque
 * rôle est tenu une fois : une génétique qui ne l'a pas traversé et en manque lève une
 * DataError.
 */
export function geneRoles(genetics: {
  readonly loci: readonly { readonly id: string; readonly role?: LocusRole | undefined }[];
  readonly traits: readonly { readonly id: string; readonly role?: TraitRole | undefined }[];
}): GeneRoles {
  let roles = rolesOf.get(genetics);
  if (roles !== undefined) return roles;
  const holder = <R extends string>(
    entries: readonly { readonly role?: R | undefined }[],
    role: R,
  ): number => {
    const index = entries.findIndex((entry) => entry.role === role);
    if (index < 0) throw new DataError(`data/genetics.json : aucun gène ne tient le rôle ${role}`);
    return index;
  };
  roles = {
    loci: {
      eyes: holder(genetics.loci, 'eyes'),
      hair: holder(genetics.loci, 'hair'),
      face: holder(genetics.loci, 'face'),
      nose: holder(genetics.loci, 'nose'),
    },
    traits: {
      skin: holder(genetics.traits, 'skin'),
      height: holder(genetics.traits, 'height'),
    },
  };
  rolesOf.set(genetics, roles);
  return roles;
}

/** Répartition d'un trait continu dans une sous-espèce : moyenne et écart type. */
const DistributionSchema = z.object({ mean: ShareSchema, sd: ShareSchema }).strict();

/** Adaptations d'une sous-espèce (ESP-02), de 0 à 1 : jamais ses capacités mentales. */
const AdaptationSchema = z
  .object({
    /** Résistance au froid et à la chaleur : elle tempère la surmortalité des mois extrêmes. */
    cold: ShareSchema,
    heat: ShareSchema,
    /** Endurance : elle allonge la marche et la recherche de nourriture. */
    endurance: ShareSchema,
  })
  .strict();

const SubspeciesSchema = z
  .object({
    id: IdSchema,
    name: MessageKeySchema,
    adaptation: AdaptationSchema,
    /** Biomes de prédilection, où la cueillette et la chasse rendent davantage. */
    biomes: z.array(IdSchema),
    /** Apparence : fréquence de chaque allèle par locus, répartition de chaque trait. */
    appearance: z
      .object({
        alleles: z.record(IdSchema, z.record(IdSchema, z.number().min(0))),
        traits: z.record(IdSchema, DistributionSchema),
      })
      .strict(),
  })
  .strict();

/**
 * Mortalité de Siler, par an, à l'âge x en années : infant.level × e^(−infant.decay × x)
 * + background + senescence.level × e^(senescence.growth × x).
 */
const MortalitySchema = z
  .object({
    infant: z.object({ level: z.number().min(0), decay: z.number().positive() }).strict(),
    background: z.number().min(0),
    senescence: z.object({ level: z.number().min(0), growth: z.number().positive() }).strict(),
    /** Part de la mortalité de fond due aux maladies ; le reste, aux accidents. */
    diseaseShare: ShareSchema,
    /**
     * Nourrisson orphelin de mère : son risque d'enfance est multiplié par `factor` tant
     * qu'il a moins de `months` mois, l'âge où il ne dépend plus d'elle.
     */
    orphan: z.object({ factor: z.number().min(1), months: z.number().int().min(0) }).strict(),
  })
  .strict();

const FertilitySchema = z
  .object({
    /** Âges de la fécondité féminine, en années : début, sommet, fin. */
    from: z.number().positive(),
    peak: z.number().positive(),
    to: z.number().positive(),
    /**
     * Forme de la fécondité relative : `onset` au premier âge fécond, puis une croissance
     * jusqu'à 1 au sommet ; elle reste entière sur la part `plateau` de la période qui suit
     * le sommet, et décline enfin jusqu'à 0 à la fin de la période féconde.
     */
    onset: ShareSchema,
    plateau: ShareSchema,
    /** Âge au-delà duquel un homme n'a plus d'enfant. */
    maleTo: z.number().positive(),
    /** Probabilité mensuelle de conception au sommet, pour une femme en couple, nourrie. */
    monthly: ShareSchema,
    /** Mois sans conception après un accouchement (allaitement). */
    postpartum: z.number().int().min(0),
    /** Durée de la grossesse, en mois. */
    gestation: z.number().int().positive(),
    /** Probabilité, par accouchement, que la mère en meure. */
    childbirthDeath: ShareSchema,
  })
  .strict()
  .refine((fertility) => fertility.from < fertility.peak && fertility.peak < fertility.to, {
    message: 'la fécondité commence, culmine puis cesse',
  });

/**
 * Âges de la vie et de l'apparence, en années (REN-04, REN-07 ; D-6, A-10, U-12), que
 * lisent les mini-sprites, les fiches et les portraits (src/core/life.ts) : nourrisson
 * jusqu'à `baby` ans, enfant jusqu'à la maturité de l'espèce, adulte, puis aîné dès
 * `elder` ans. Les cheveux grisonnent de `grey[0]` à `grey[1]` ans. Chez un adulte, la
 * barbe paraît à `beard` ans et la calvitie à `bald` ; les rides viennent au front à
 * `wrinkles.forehead`, au coin des yeux à `wrinkles.eyes`, autour de la bouche à
 * `wrinkles.mouth`, et le front se creuse à `wrinkles.deep`.
 */
const AgesSchema = z
  .object({
    baby: z.number().positive(),
    elder: z.number().positive(),
    grey: z.tuple([z.number().min(0), z.number().min(0)]).refine(([from, to]) => from < to, {
      message: 'les cheveux grisonnent de grey[0] à grey[1]',
    }),
    beard: z.number().min(0),
    bald: z.number().min(0),
    wrinkles: z
      .object({
        forehead: z.number().min(0),
        eyes: z.number().min(0),
        mouth: z.number().min(0),
        deep: z.number().min(0),
      })
      .strict(),
  })
  .strict();

export type SpeciesAges = z.infer<typeof AgesSchema>;

export const SpeciesSchema = z
  .object({
    id: IdSchema,
    name: MessageKeySchema,
    /** Âge adulte, en années : couple, travail, besoin entier de nourriture. */
    maturity: z.number().positive(),
    /** Âge au-delà duquel nul ne survit, en années. */
    longevity: z.number().positive(),
    ages: AgesSchema,
    mortality: MortalitySchema,
    fertility: FertilitySchema,
    /** Couple : âge minimal et plus grand écart d'âge, en années. */
    couple: z.object({ minAge: z.number().positive(), maxGap: z.number().positive() }).strict(),
    /** Besoin de nourriture d'un enfant, en part de celui d'un adulte. */
    childNeed: ShareSchema,
    /**
     * Rigueurs (SAI-03), en risque annuel de mort. Le froid et la chaleur sont nuls entre
     * `comfort[0]` et `comfort[1]` °C au mois ; au-delà, ils croissent d'un trait jusqu'à
     * leur plein, `cold` à `extremes[0]` °C et au-dessous, `heat` à `extremes[1]` °C et
     * au-dessus. Une faim complète vaut `famine`. Le froid et la chaleur frappent les plus
     * fragiles, les enfants (avant `frail[0]` ans) et les vieux (dès `frail[1]` ans) ; les
     * autres n'en reçoivent que `adults`. L'adaptation de la sous-espèce tempère le froid et
     * la chaleur ; la faim ne dépend que de la nutrition. C'est aussi dès `frail[1]` ans que
     * la vieillesse tue : avant, les morts de la sénescence comptent parmi les maladies.
     */
    hardship: z
      .object({
        cold: z.number().min(0),
        heat: z.number().min(0),
        comfort: z.tuple([z.number(), z.number()]),
        extremes: z.tuple([z.number(), z.number()]),
        famine: z.number().min(0),
        frail: z.tuple([z.number().min(0), z.number().min(0)]),
        adults: ShareSchema,
      })
      .strict()
      .refine(
        ({ comfort, extremes }) =>
          extremes[0] < comfort[0] && comfort[0] <= comfort[1] && comfort[1] < extremes[1],
        { message: 'le froid extrême, le confort puis la chaleur extrême se suivent' },
      ),
    /** Probabilité mensuelle qu'une femme seule, en âge, trouve un conjoint dans son groupe. */
    pairing: ShareSchema,
    /** Taille adulte, en centimètres, aux deux bouts du trait « taille ». */
    height: z.tuple([z.number().positive(), z.number().positive()]),
    subspecies: uniqueIds(SubspeciesSchema).min(1).max(MAX_SUBSPECIES),
  })
  .strict()
  .refine((species) => species.maturity < species.longevity, {
    message: "l'âge adulte précède la longévité",
  })
  .refine(
    ({ ages, maturity, longevity }) =>
      ages.baby < maturity && maturity < ages.elder && ages.elder < longevity,
    {
      message:
        'les âges de la vie se suivent : nourrisson, enfant jusqu’à la maturité, adulte, puis aîné avant la longévité',
    },
  )
  .refine(
    (species) => {
      const [youngest, eldest] = spawnAdultAges(species);
      return youngest <= eldest;
    },
    { message: "l'âge du couple précède la fin de la fécondité et la dernière année de vie" },
  );

export type Species = z.infer<typeof SpeciesSchema>;
export type Subspecies = z.infer<typeof SubspeciesSchema>;
export const SpeciesListSchema = uniqueIds(SpeciesSchema).min(1).max(255);

/**
 * Âges, en mois entiers, des adultes d'un groupe qui apparaît (CRE-03) : de l'âge du
 * couple à la fin de la fécondité féminine, et au plus tard un an avant la longévité. Le
 * schéma garantit que l'intervalle n'est pas vide.
 */
export function spawnAdultAges(species: {
  readonly couple: { readonly minAge: number };
  readonly fertility: { readonly to: number };
  readonly longevity: number;
}): readonly [youngest: number, eldest: number] {
  return [
    Math.ceil(species.couple.minAge * 12),
    Math.floor(Math.min(species.fertility.to, species.longevity - 1) * 12),
  ];
}

/**
 * Cultures embryonnaires (C2, D4) : fréquence de chaque règle de nommage (IND-08) parmi
 * les cultures qui naissent avec un groupe. Le nom de famille vient du père, de la mère,
 * des deux (celui du père, puis celui de la mère), d'aucun, ou bien chacun reçoit un nom
 * obtenu, un surnom qui lui est propre (`earned`) ; le métier et le lieu attendent la
 * phase 3 (C2, D6).
 */
export const CulturesSchema = z
  .object({
    naming: z
      .object({
        father: ShareSchema,
        mother: ShareSchema,
        both: ShareSchema,
        none: ShareSchema,
        earned: ShareSchema,
      })
      .strict()
      .refine((weights) => Object.values(weights).some((weight) => weight > 0), {
        message: 'une règle de nommage au moins',
      }),
  })
  .strict();

export type Cultures = z.infer<typeof CulturesSchema>;

/**
 * Groupes nomades (C2, D4 et D13 ; tâches 2.4 et 2.5) : marche, scission, aire, recherche
 * de nourriture, réserves et stocks de nourriture des cases.
 */
export const NomadsSchema = z
  .object({
    /** Cases de plaine parcourues à pied en un mois (C2, D13). */
    walk: z.number().positive(),
    /** Taille au-delà de laquelle un groupe se scinde (C2, D4). */
    split: z.number().int().min(4),
    /** Rayon de l'aire d'un groupe autour de son centre, en cases. */
    range: z.number().positive(),
    /**
     * Distance du mariage, en coût de marche, compté comme `walk` en cases de plaine : deux
     * groupes sont voisins quand l'un atteint l'autre à pied pour ce coût au plus, et non à
     * vol d'oiseau ; avec 30, un mois de marche (MON-16 ; C2, D13). Un célibataire y trouve
     * un conjoint, faute d'en trouver dans son groupe : les bandes échangent leurs conjoints.
     */
    marriage: z.number().min(0),
    /**
     * Probabilité mensuelle qu'un célibataire qui ne trouve de conjoint ni dans son groupe
     * ni dans les groupes voisins de sa culture en trouve un dans un groupe voisin d'une
     * autre culture : le métissage (ESP-04).
     */
    intermarriage: ShareSchema,
    /** Un groupe de moins de membres rejoint un groupe voisin, à la distance du mariage. */
    merge: z.number().int().min(0),
    /** Rayon, en cases, où le groupe cherche sa nourriture, et part des stocks qu'il prend. */
    forage: z.object({ radius: z.number().int().min(1).max(8), share: ShareSchema }).strict(),
    /** Réserves pour l'hiver (SAI-03) : en mois de besoin du groupe, et pertes par mois. */
    reserve: z.object({ months: z.number().min(0), spoilage: ShareSchema }).strict(),
    /**
     * Stocks d'une case : leur plafond (`capacity`), en mois de son rendement du moment ;
     * plafond et repousse suivent tous deux la saison.
     */
    stocks: z
      .object({
        plants: z.object({ capacity: z.number().positive() }).strict(),
        game: z
          .object({
            capacity: z.number().positive(),
            /**
             * Le gibier se raréfie dans le froid (SAI-03) : sa part, entière jusqu'à `from`
             * °C au mois, décroît d'un trait jusqu'à `share` à `to` °C, et reste à `share`
             * au-dessous.
             */
            cold: z
              .object({ from: z.number(), to: z.number(), share: ShareSchema })
              .strict()
              .refine((cold) => cold.to < cold.from, {
                message: 'le froid du gibier va de `from` à `to`, plus froid',
              }),
          })
          .strict(),
        fish: z
          .object({
            capacity: z.number().positive(),
            /**
             * Part de la pêche qui reste sous une couverture pleine : glace, banquise ou
             * neige, qui couvrent la case comme sur la carte (core/seasons.ts).
             */
            covered: ShareSchema,
          })
          .strict(),
      })
      .strict(),
    /**
     * Pêche qu'une rivière ajoute à la case de terre qu'elle traverse, par classe (aucune,
     * ruisseau, rivière, fleuve), en besoins mensuels d'un adulte au sommet de la saison,
     * comme `forage.fish` des biomes ; elle gèle comme l'eau douce. Une eau, dont le lit
     * d'un fleuve, ne porte que la pêche de son biome.
     */
    river: z.tuple([z.number().min(0), z.number().min(0), z.number().min(0), z.number().min(0)]),
  })
  .strict();

export type Nomads = z.infer<typeof NomadsSchema>;

/**
 * Couleurs des portraits et des mini-sprites (REN-07, REN-04, REN-09) : rampe des teints,
 * du plus clair au plus foncé, que parcourt le trait du rôle « skin » ; cheveux gris ;
 * contour ; fond des portraits, qui doit se détacher du contour et des cheveux les plus
 * sombres ; blanc des yeux, bouche ; habits des cultures embryonnaires, un par culture, à
 * tour de rôle.
 */
export const AppearanceSchema = z
  .object({
    skin: z.array(ColorSchema).min(2),
    grey: ColorSchema,
    outline: ColorSchema,
    backdrop: ColorSchema,
    white: ColorSchema,
    mouth: ColorSchema,
    clothing: z.array(ColorSchema).min(1),
  })
  .strict();

export type Appearance = z.infer<typeof AppearanceSchema>;
