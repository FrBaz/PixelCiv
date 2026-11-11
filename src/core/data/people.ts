/**
 * Schémas des espèces et de la génétique (tâche 2.2 ; IND-05, IND-06, ESP-01 à ESP-04,
 * ADR 0011) : data/species.json et data/genetics.json.
 *
 * Le génome d'un individu tient en GENOME_WORDS mots de 32 bits : huit locus discrets à
 * deux allèles de 4 bits (dominants ou récessifs), puis huit traits continus de 8 bits
 * (moyenne des parents et variation). Les données ne peuvent donc pas décrire plus de
 * huit locus, de seize allèles chacun, ni plus de huit traits.
 */
import { z } from 'zod';
import { IdSchema, MessageKeySchema, ShareSchema, uniqueIds } from './schemas';

export const MAX_LOCI = 8;
export const MAX_ALLELES = 16;
export const MAX_TRAITS = 8;
/** Sous-espèces d'une espèce, au plus : autant que de parts d'ascendance. */
export const MAX_SUBSPECIES = 4;

const ColorSchema = z.string().regex(/^#[0-9a-f]{6}$/, 'couleur #rrggbb');

/** Allèle d'un locus discret : le plus dominant des deux s'exprime. */
const AlleleSchema = z
  .object({
    id: IdSchema,
    name: MessageKeySchema,
    /** Rang de dominance : à rang égal, l'allèle qui vient d'abord dans la liste l'emporte. */
    dominance: z.number().int().min(0),
    /** Couleur qu'il donne, pour les yeux et les cheveux ; aucune pour les formes. */
    color: ColorSchema.optional(),
  })
  .strict();

const LocusSchema = z
  .object({
    id: IdSchema,
    name: MessageKeySchema,
    alleles: uniqueIds(AlleleSchema).min(2).max(MAX_ALLELES),
  })
  .strict();

/** Trait continu, de 0 à 1, stocké sur 8 bits. */
const TraitSchema = z
  .object({
    id: IdSchema,
    name: MessageKeySchema,
    /** Écart type de la variation autour de la moyenne des parents. */
    variation: ShareSchema,
  })
  .strict();

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
  .strict();

export type Genetics = z.infer<typeof GeneticsSchema>;
export type Locus = z.infer<typeof LocusSchema>;
export type Trait = z.infer<typeof TraitSchema>;

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

export const SpeciesSchema = z
  .object({
    id: IdSchema,
    name: MessageKeySchema,
    /** Âge adulte, en années : couple, travail, besoin entier de nourriture. */
    maturity: z.number().positive(),
    /** Âge au-delà duquel nul ne survit, en années. */
    longevity: z.number().positive(),
    mortality: MortalitySchema,
    fertility: FertilitySchema,
    /** Couple : âge minimal et plus grand écart d'âge, en années. */
    couple: z.object({ minAge: z.number().positive(), maxGap: z.number().positive() }).strict(),
    /** Besoin de nourriture d'un enfant, en part de celui d'un adulte. */
    childNeed: ShareSchema,
    /**
     * Rigueurs (SAI-03), en risque annuel de mort : un froid de 20 °C sous zéro, une
     * chaleur de 10 °C au-delà de 30 °C, une faim complète. Le froid et la chaleur frappent
     * les plus fragiles, les enfants (avant `frail[0]` ans) et les vieux (dès `frail[1]`
     * ans) ; les autres n'en reçoivent que `adults`. L'adaptation de la sous-espèce tempère
     * le froid et la chaleur ; la faim ne dépend que de la nutrition. C'est aussi dès
     * `frail[1]` ans que la vieillesse tue : avant, les morts de la sénescence comptent
     * parmi les maladies.
     */
    hardship: z
      .object({
        cold: z.number().min(0),
        heat: z.number().min(0),
        famine: z.number().min(0),
        frail: z.tuple([z.number().min(0), z.number().min(0)]),
        adults: ShareSchema,
      })
      .strict(),
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
     * Distance, en cases, à laquelle un célibataire trouve un conjoint dans un autre groupe
     * de sa culture, faute d'en trouver dans le sien : les bandes échangent leurs conjoints.
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
 * du plus clair au plus foncé, que le trait « skin » parcourt ; cheveux gris ; contour ;
 * fond des portraits, qui doit se détacher du contour et des cheveux les plus sombres ;
 * blanc des yeux, bouche ; habits des cultures embryonnaires, un par culture, à tour de rôle.
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
