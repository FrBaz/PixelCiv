/**
 * Gibier (tâche 2b.6 ; FAU-01, MON-10, CRE-03 ; ADR 0018) : data/fauna.json, ses espèces et ses
 * règles communes. Chaque biome dit, dans `fauna`, la qualité de son habitat pour chacune
 * (data/biomes.json). N'importe que zod : l'extension de Vite qui range l'atlas du gibier
 * (tools/fauna-atlas.ts) le charge avec la configuration.
 *
 * Les bornes du schéma tiennent le coût du gibier : MAX_DENSITY par espèce, MAX_HERD par harde,
 * et la simulation ramène les cibles d'un monde sous MAX_FAUNA_SHARE de ses cases (src/sim/fauna.ts).
 */
import { z } from 'zod';

const IdSchema = z.string().regex(/^[a-z]+(-[a-z]+)*$/u, 'identifiant en minuscules et tirets');
const KeySchema = z.string().regex(/^[a-z]+(\.[a-z0-9-]+)+$/u, 'clé de traduction');
const ColorSchema = z.string().regex(/^#[0-9a-f]{6}$/u, 'couleur #rrggbb');
/**
 * Clarté perçue d'un ton #rrggbb, de 0 à 255 : sa luma (Rec. 601, sur les valeurs codées), comme
 * celle du décor (src/core/data/decor.ts, que ce module n'importe pas : il ne charge que zod).
 */
function luma(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  return 0.299 * ((value >> 16) & 255) + 0.587 * ((value >> 8) & 255) + 0.114 * (value & 255);
}
/**
 * Rampe de quatre tons, de la lumière à l'ombre profonde, chacun plus sombre que le précédent
 * (REN-09).
 */
const RampSchema = z
  .tuple([ColorSchema, ColorSchema, ColorSchema, ColorSchema])
  .refine(
    (ramp) => ramp.every((tone, rank) => rank === 0 || luma(tone) < luma(ramp[rank - 1] ?? tone)),
    { message: "des tons de plus en plus sombres, de la lumière à l'ombre profonde" },
  );

/**
 * Un animal pour 128 cases du monde, au plus, toutes espèces comprises : le coût du jour du
 * gibier au plafond, mesuré sur un monde Immense (ADR 0018, § 8), le fixe.
 */
export const MAX_FAUNA_SHARE = 1 / 128;
/** Densité d'une espèce, au plus : animaux par case d'habitat parfait. */
export const MAX_DENSITY = 0.05;
/** Taille d'une harde, au plus (le cache des membres et la sauvegarde la bornent). */
export const MAX_HERD = 32;
/** Espèces, au plus : leur rang tient sur les quatre bits de l'image du gibier (protocole 7). */
export const MAX_FAUNA_SPECIES = 16;
/** Côté du plus grand carré de cases que chaque taille de monde contient un nombre entier de fois. */
const WORLD_GRAIN = 128;

/** Paire [bas, haut], bas ≤ haut. */
function pair(low: number, high: number, integer = false) {
  const value = integer ? z.number().int().min(low).max(high) : z.number().min(low).max(high);
  return z.tuple([value, value]).refine(([a, b]) => a <= b, { message: 'bas ≤ haut' });
}

/** Un mois, de 0 (janvier) à 11. */
const MonthSchema = z.number().int().min(0).max(11);

/** Une espèce de gibier. */
export const FaunaSpeciesSchema = z
  .object({
    id: IdSchema,
    /** Nom, au masculin et au féminin (le cerf, la biche). */
    name: KeySchema,
    /** Animaux par case d'habitat parfait (qualité 1), le stock de gibier au plafond. */
    density: z.number().min(0).max(MAX_DENSITY),
    /** Taille d'une harde : [1, 1] pour une espèce solitaire. */
    herd: pair(1, MAX_HERD, true),
    /** Rayon, en cases, des places des membres autour du but de la harde. */
    spread: z.number().min(0).max(4),
    /** Écart, au moins, entre les places de deux membres, en cases. */
    gap: z.number().min(0).max(1),
    /** Retard, au plus, en jours, d'un membre au repos sur le choix du but. */
    lag: z.number().int().min(0).max(10),
    /** Distance d'un nouveau but au précédent, en cases. */
    roam: pair(0.2, 12),
    /** Rayon du domaine de la harde autour de son centre, en cases. */
    range: z.number().min(1).max(32),
    /** Jours de repos entre deux buts. */
    rest: pair(1, 60, true),
    /** Allures, en cases de plaine par jour : au pas et en fuite. */
    pace: z.object({ walk: z.number().min(0.05).max(4), run: z.number().min(0.1).max(4) }).strict(),
    /**
     * Fuite : distance d'alarme, en cases, d'un humain qui marche près d'un membre ; longueur de
     * la fuite, en cases ; jours de calme qui suivent, sans nouvelle alarme.
     */
    flee: z
      .object({
        distance: z.number().min(0).max(6),
        length: z.number().min(0.5).max(12),
        calm: z.number().int().min(1).max(30),
      })
      .strict(),
    /**
     * La chasse (2b.8, ADR 0021, § 5) : la chance qu'un coup porte, et la viande d'une prise, en
     * besoins mensuels d'un adulte, ôtée du stock de gibier des cases autour de l'animal.
     */
    hunt: z.object({ chance: z.number().min(0).max(1), meat: z.number().min(0).max(4) }).strict(),
    /**
     * Naissances : mois de la mise bas au nord (au sud, six mois plus tard), croissance
     * mensuelle au plus, sous la cible, et mois passés jeune.
     */
    birth: z
      .object({
        months: z
          .array(MonthSchema)
          .min(1)
          .max(12)
          .refine((months) => new Set(months).size === months.length, {
            message: 'chaque mois une fois',
          }),
        growth: z.number().min(0).max(2),
        young: z.number().int().min(1).max(36),
      })
      .strict(),
    /** Part de l'excès sur la cible qui meurt chaque mois. */
    cull: z.number().min(0).max(1),
    /** Chance, par mois, qu'un territoire vide où la cible le permet soit recolonisé. */
    colonize: z.number().min(0).max(1),
    /** Longévité, en années. */
    lifespan: z.number().min(1).max(40),
    /** Part des mâles à la naissance. */
    males: z.number().min(0).max(1),
    /** Apparence : formes des grilles (assets/fauna/) et tons de chaque région. */
    look: z
      .object({
        form: IdSchema,
        /** Forme du mâle adulte (les bois du cerf), s'il en a une, et son âge, en années. */
        male: IdSchema.optional(),
        maleFrom: z.number().min(0).max(10).optional(),
        /** Facteur de réduction du jeune, d'après l'adulte. */
        young: z.number().min(1).max(3),
        coat: RampSchema,
        pale: RampSchema,
        dark: RampSchema,
        /** Bois, défenses : les seules formes qui en dessinent les demandent. */
        horn: RampSchema.optional(),
      })
      .strict()
      .refine((look) => (look.male === undefined) === (look.maleFrom === undefined), {
        message: 'une forme du mâle, et elle seule, a son âge',
        path: ['maleFrom'],
      }),
  })
  .strict()
  .refine((species) => species.pace.run >= species.pace.walk, {
    message: 'la fuite va au moins au pas',
    path: ['pace', 'run'],
  })
  .refine((species) => species.herd[1] > 1 || species.spread === 0, {
    message: 'une espèce solitaire se tient sur son but',
    path: ['spread'],
  });
export type FaunaSpecies = z.infer<typeof FaunaSpeciesSchema>;

export const FaunaListSchema = z
  .array(FaunaSpeciesSchema)
  .max(MAX_FAUNA_SPECIES)
  .superRefine((list, context) => {
    const seen = new Set<string>();
    for (const [index, entry] of list.entries()) {
      if (seen.has(entry.id)) {
        context.addIssue({
          code: 'custom',
          message: `identifiant en double : ${entry.id}`,
          path: [index, 'id'],
        });
      }
      seen.add(entry.id);
    }
  });

/**
 * Règles communes du gibier, que l'auteur peut vouloir changer (ADR 0018) : la simulation
 * (territoires, tirages, camps, allures, virages de la fuite, recolonisation) et le rendu
 * (cycle du repos, cadence des images).
 */
export const FaunaRulesSchema = z
  .object({
    /**
     * Côté d'un territoire, en cases : il divise 128, donc chaque taille de monde, si bien que
     * les territoires sont entiers, couture comprise.
     */
    territory: z
      .number()
      .int()
      .min(8)
      .max(WORLD_GRAIN)
      .refine((side) => WORLD_GRAIN % side === 0, { message: 'un diviseur de 128' }),
    /**
     * Tirages : buts essayés à chaque nouveau but, places essayées par membre, cases essayées pour
     * poser une harde (semis, recolonisation).
     */
    draws: z
      .object({
        goal: z.number().int().min(1).max(8),
        place: z.number().int().min(1).max(16),
        cell: z.number().int().min(1).max(32),
      })
      .strict(),
    /** Un but se tient à plus de `camps` × flee.distance de tout humain, au repos ou en marche. */
    camps: z.number().min(0).max(6),
    /** Allure propre d'un animal : pace × (1 − jitter + 2 × jitter × u), u tiré de son identifiant. */
    jitter: z.number().min(0).max(0.5),
    /** Virages essayés par la fuite, en degrés, quand la direction opposée est barrée, dans l'ordre. */
    turns: z.array(z.number().min(-180).max(180)).max(8),
    /** Rayon du voisinage d'où vient une harde qui recolonise un territoire vide, en territoires. */
    neighbors: z.number().int().min(1).max(4),
    /**
     * Rendu : cycle du repos, en millisecondes de l'horloge de la marche, déphasé par l'identifiant
     * (debout jusqu'à `flick`, un coup d'oreille ou de queue jusqu'à `graze`, l'animal broute jusqu'à
     * `rise`, tête levée et baissée tous les `chew`, puis debout) ; cadence des images de la marche
     * et de la course, en images par pas du rendu (STEP_MS).
     */
    idle: z
      .object({
        period: z.number().int().min(1000).max(60_000),
        flick: z.number().int().min(0),
        graze: z.number().int().min(0),
        rise: z.number().int().min(0),
        chew: z.number().int().min(100).max(5000),
      })
      .strict()
      .refine(
        (idle) => idle.flick <= idle.graze && idle.graze <= idle.rise && idle.rise <= idle.period,
        {
          message: 'flick ≤ graze ≤ rise ≤ period',
        },
      ),
    cadence: z
      .object({ walk: z.number().min(0.5).max(8), run: z.number().min(0.5).max(16) })
      .strict(),
    /**
     * Rendu : un animal mort entre deux images du gibier tombe là où il était, en millisecondes de
     * l'horloge de la marche : il trébuche jusqu'à `stumble`, il est couché jusqu'à `lie`, puis il
     * disparaît.
     */
    fall: z
      .object({
        stumble: z.number().int().min(0).max(5000),
        lie: z.number().int().min(0).max(10_000),
      })
      .strict()
      .refine((fall) => fall.stumble <= fall.lie, { message: 'stumble ≤ lie' }),
    /** Le contour des motifs, celui des planches de sprites/ et du décor. */
    outline: ColorSchema,
    /**
     * Le contour des motifs réduits (adulte et jeune, à chaque niveau au-delà du premier) : retracé
     * sur tout le bord de la silhouette (« silhouette »), ou là seulement où la forme a trois pixels
     * d'épaisseur (« thick », comme les humains des niveaux moyens). La consigne veut au gibier un
     * contour sombre : il en garde un même aux niveaux où les humains n'en ont plus.
     */
    retrace: z.enum(['silhouette', 'thick']),
  })
  .strict();
export type FaunaRules = z.infer<typeof FaunaRulesSchema>;

/**
 * Le fichier data/fauna.json : les règles communes, puis les espèces. Le contour borde chaque
 * rampe d'un ton plus sombre que sa lumière, sa base et son ombre (consigne : un contour sombre) ;
 * l'ombre profonde, celle de l'œil, peut l'égaler.
 */
export const FaunaFileSchema = z
  .object({ rules: FaunaRulesSchema, species: FaunaListSchema })
  .strict()
  .superRefine((file, context) => {
    const outline = luma(file.rules.outline);
    file.species.forEach((entry, index) => {
      for (const region of ['coat', 'pale', 'dark', 'horn'] as const) {
        const ramp = entry.look[region];
        if (ramp === undefined || ramp.slice(0, 3).every((tone) => outline < luma(tone))) continue;
        context.addIssue({
          code: 'custom',
          message: 'le contour (rules.outline) plus sombre que la lumière, la base et l’ombre',
          path: ['species', index, 'look', region],
        });
      }
    });
  });
