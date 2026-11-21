/**
 * Activités des individus (tâche 2b.8 ; REN-03, SAI-03, FAU-01 ; ADR 0021) : data/activities.json.
 * Chaque activité dit qui la fait (âge, porté, grossesse, faim, goût de la culture), combien de
 * jours, où (`place`, `reach`), selon quelle saison, à quelle allure on s'y rend, et quel geste la
 * montre à sa place (`gesture`, l'un des `gestures`, composé d'images des planches de
 * data/humans.json, ADR 0022). La simulation ne nomme aucune activité : elle lit leur lieu
 * (`place`). Les règles communes (`rules`) tiennent tous les réglages du choix, des lieux et de la
 * chasse. N'importe que zod.
 */
import { z } from 'zod';

const IdSchema = z.string().regex(/^[a-z]+(-[a-z]+)*$/u, 'identifiant en minuscules et tirets');
const KeySchema = z.string().regex(/^[a-z]+(\.[a-z0-9-]+)+$/u, 'clé de traduction');

/**
 * Activités, au plus : leur rang tient sur les quatre bits de l'octet d'activité, la valeur 15
 * disant « aucune » (protocole 9, core/protocol.ts, ACT_NONE).
 */
export const MAX_ACTIVITIES = 15;

/** Gestes, au plus. */
export const MAX_GESTURES = 32;

/** Portée d'une activité, au plus, en cases : anneaux, rives et gibier se cherchent jusque-là. */
export const MAX_REACH = 16;

/** Jours passés sur place, au plus : une activité, comme la sauvegarde, en compte 60 au plus. */
export const MAX_ACTIVITY_DAYS = 60;

/**
 * Lieux d'une activité : à sa place au camp (`home`) ; autour d'elle, dans l'anneau `reach`
 * (`around`) ; près de la place de son ancre, mère ou père (`near`) ; à l'affût d'un animal du
 * gibier (`prey`) ; au bord d'une eau (`water`) ; vers le camp nouveau de son groupe (`camp`, le
 * suivi du groupe, que seul le plan du mois donne).
 */
export const ACTIVITY_PLACES = ['home', 'around', 'near', 'prey', 'water', 'camp'] as const;
export type ActivityPlace = (typeof ACTIVITY_PLACES)[number];

/**
 * Saison d'une activité : la part de son rendement autour du camp ce mois-ci (plantes, gibier,
 * poisson, src/sim/forage.ts), sur le disque où le groupe se nourrit ; `thaw`, la part de l'eau
 * libre : ni neige sur la case du camp (on la fond plutôt que d'aller à l'eau), ni glace sur la rive.
 */
export const ACTIVITY_SEASONS = ['plants', 'game', 'fish', 'thaw'] as const;
export type ActivitySeason = (typeof ACTIVITY_SEASONS)[number];

/** Paire [bas, haut], bas ≤ haut. */
function pair(low: number, high: number, integer = false) {
  const value = integer ? z.number().int().min(low).max(high) : z.number().min(low).max(high);
  return z.tuple([value, value]).refine(([a, b]) => a <= b, { message: 'bas ≤ haut' });
}

/** Courbe de l'âge : points (années, facteur), âges croissants, linéaire entre eux. */
const AgeCurveSchema = z
  .array(z.tuple([z.number().min(0).max(150), z.number().min(0).max(10)]))
  .min(1)
  .max(12)
  .refine((points) => points.every((point, i) => i === 0 || point[0] > (points[i - 1]?.[0] ?? 0)), {
    message: 'des âges croissants',
  });

export const ActivitySchema = z
  .object({
    id: IdSchema,
    name: KeySchema,
    place: z.enum(ACTIVITY_PLACES),
    /** Distances, en cases : l'anneau autour de la place, ou la portée d'une eau, d'un gibier. */
    reach: pair(0, MAX_REACH),
    /** Poids de l'activité, avant l'âge, la saison et le reste. */
    weight: z.number().min(0).max(100),
    season: z.enum(ACTIVITY_SEASONS).optional(),
    age: AgeCurveSchema,
    /**
     * Jours passés sur place, tirés entre les deux, comptés de l'arrivée ; ceux de la chasse,
     * qui suit son animal, de son choix. Le suivi du groupe n'en a pas : il dure son trajet.
     */
    days: pair(1, MAX_ACTIVITY_DAYS, true).optional(),
    /** Facteurs du poids pour qui porte un nourrisson, pour une femme enceinte, pour qui a faim. */
    carrying: z.number().min(0).max(10).default(1),
    pregnant: z.number().min(0).max(10).default(1),
    weak: z.number().min(0).max(10).default(1),
    /**
     * Goût d'une culture pour l'activité : un facteur tiré entre les deux, une fois pour chaque
     * culture, de la graine et de son identifiant (sans état). [1, 1] : aucun goût (défaut).
     */
    taste: pair(0, 4).default([1, 1]),
    /**
     * Partage des tâches entre les sexes, propre à chaque culture, tiré de même entre les deux :
     * d donne (1 − d) aux femmes et (1 + d) aux hommes. [0, 0] : aucun partage (défaut).
     */
    sex: pair(-1, 1).default([0, 0]),
    /** On s'y rend en courant (jeu) ou en marchant. */
    gait: z.enum(['walk', 'run']).default('walk'),
    /**
     * Les eaux d'une activité au bord de l'eau : biomes de la famille de l'eau (checkContent), et
     * rivières des cases de terre.
     */
    water: z
      .object({ biomes: z.array(IdSchema).max(32), river: z.boolean() })
      .strict()
      .optional(),
    gesture: IdSchema,
    /**
     * Le geste du coup, joué une fois le jour où le chasseur frappe (ACT_STRIKE, protocole 9) :
     * pour la chasse seule.
     */
    strike: IdSchema.optional(),
  })
  .strict()
  .refine((a) => a.strike === undefined || a.place === 'prey', {
    message: 'seule la chasse a un geste du coup',
  })
  .refine((a) => (a.place === 'water') === (a.water !== undefined), {
    message: 'une activité au bord de l’eau, et elle seule, dit ses eaux',
  })
  .refine((a) => (a.place === 'camp') === (a.days === undefined), {
    message: 'chaque activité dit ses jours, sauf le suivi du groupe, qui dure son trajet',
  });

/** Un segment d'un geste : des images d'une animation des planches, à une cadence, répétées. */
const SegmentSchema = z
  .object({
    animation: IdSchema,
    /** Rangs des images, dans l'ordre ; toutes, sans eux (checkContent : des images qu'elle a). */
    frames: z.array(z.number().int().min(0).max(31)).min(1).max(16).optional(),
    /** Millisecondes par image ; sans elles, la cadence de l'animation (data/humans.json). */
    frameMs: z.number().min(40).max(4000).optional(),
    repeat: z.number().int().min(1).max(20).default(1),
  })
  .strict();

export const GestureSchema = z
  .object({ id: IdSchema, segments: z.array(SegmentSchema).min(1).max(8) })
  .strict();

/** Règles communes des activités : toutes les valeurs du choix, des lieux et de la chasse. */
export const ActivityRulesSchema = z
  .object({
    /** Nutrition (0 à 1) sous laquelle on a faim, et le facteur `weak` s'applique. */
    weak: z.number().min(0).max(1),
    /** Allure de la course, en multiple de la marche. */
    run: z.number().min(1).max(3),
    /** Tirages d'un lieu, au plus, avant de renoncer (et de se reposer). */
    draws: z.number().int().min(1).max(16),
    /**
     * La grégarité dans les activités (ADR 0021, § 3) : anneaux et portées multipliés par
     * reach[0] + reach[1] × (1 − g'), g' la grégarité effective (2b.3) ; le poids du repos par
     * 1 + rest × g' ; celui de l'activité de son ancre, si ce n'est pas le repos, par 1 + kin × g',
     * et, la même, le lieu près du sien, à la chance g'.
     */
    gregarious: z
      .object({
        reach: z.tuple([z.number().min(0).max(2), z.number().min(0).max(4)]),
        rest: z.number().min(0).max(4),
        kin: z.number().min(0).max(10),
      })
      .strict(),
    /**
     * La chasse : l'affût et la portée du coup, en distances de fuite de l'animal visé ; les jours
     * de la charge qui suit un coup manqué ; la marge, en cases au-delà de la portée de la chasse,
     * où l'animal peut s'éloigner de sa place au camp avant que le chasseur renonce ; ce que
     * l'animal doit s'être déplacé, en cases, pour que l'affût se revise.
     */
    hunt: z
      .object({
        stalk: z.number().min(1).max(4),
        strike: z.number().min(1).max(5),
        charge: z.number().int().min(1).max(10),
        leash: z.number().min(0).max(8),
        revise: z.number().min(0).max(4),
      })
      .strict()
      .refine((h) => h.strike >= h.stalk, { message: 'le coup porte au moins de l’affût' }),
    /**
     * Les rives : à `inset` case du bord d'une eau, dans la case de terre voisine ; tirées le long
     * de ce bord, sur `spread` case autour de son milieu ; parmi les `choices` plus proches qui
     * sont libres. Les bornes les gardent dans la moitié centrale de la case de terre, à un quart
     * de case au moins de ses voisines, comme tout lieu (src/sim/activities.ts, clearAt).
     */
    shore: z
      .object({
        inset: z.number().min(0.25).max(0.5),
        spread: z.number().min(0).max(0.5),
        choices: z.number().int().min(1).max(16),
      })
      .strict(),
  })
  .strict();

export const ActivitiesFileSchema = z
  .object({
    activities: z.array(ActivitySchema).min(1).max(MAX_ACTIVITIES),
    gestures: z.array(GestureSchema).min(1).max(MAX_GESTURES),
    rules: ActivityRulesSchema,
  })
  .strict()
  .superRefine((file, context) => {
    const issue = (message: string, path: (string | number)[]) => {
      context.addIssue({ code: 'custom', message, path });
    };
    const ids = file.activities.map((a) => a.id);
    if (new Set(ids).size !== ids.length) issue('des activités distinctes', ['activities']);
    const gestures = new Set(file.gestures.map((g) => g.id));
    if (gestures.size !== file.gestures.length) issue('des gestes distincts', ['gestures']);
    file.activities.forEach((a, index) => {
      if (!gestures.has(a.gesture)) issue(`geste inconnu : ${a.gesture}`, ['activities', index]);
      if (a.strike !== undefined && !gestures.has(a.strike)) {
        issue(`geste du coup inconnu : ${a.strike}`, ['activities', index]);
      }
    });
    for (const place of ['home', 'camp'] as const) {
      if (file.activities.filter((a) => a.place === place).length !== 1) {
        issue(`une activité, et une seule, au lieu « ${place} »`, ['activities']);
      }
    }
  });

export type Activity = z.infer<typeof ActivitySchema>;
export type Gesture = z.infer<typeof GestureSchema>;
export type ActivitiesFile = z.infer<typeof ActivitiesFileSchema>;
export type ActivityRules = ActivitiesFile['rules'];
