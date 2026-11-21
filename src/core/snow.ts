/**
 * Neige et glace à inertie (tâche 2b.7 ; C1, D9 et D13 ; SAI-03 ; ADR 0019, § 1) : une fonction
 * pure du climat de la case et de la date, que la simulation (la pêche), la carte et le décor
 * lisent dans les mêmes octets.
 *
 * Chaque case a, par couverture, un calendrier de CALENDAR_BYTES octets, compté en jours de phase
 * depuis son jour le plus chaud (mi-juillet au nord, mi-janvier au sud) : le début de sa montée et
 * la fin de sa descente, en 255es d'année, la durée de l'une et de l'autre, en jours. Au
 * refroidissement (phase sous COLDEST_PHASE), son niveau est la montée, (p − début) / montée ; au
 * réchauffement, la descente, (fin − p) / descente ; l'un et l'autre bornés à [0, 1]. Le calendrier
 * se tire d'un réservoir, intégré une fois sur une année du climat de la case par pas de `step`
 * jours, vide au jour le plus chaud (hors des glaciers, rien ne survit à l'été : C1, D13) :
 * - neige : l'équivalent en eau de la neige au sol, qui gagne la pluie du jour tombée en neige et
 *   perd sa fonte au-dessus de 0 °C ;
 * - glace : son épaisseur, qui croît sous `freezeBelow`, d'autant moins vite qu'elle est épaisse
 *   (loi de Stefan, approchée), et fond au-dessus.
 * La montée passe par les jours où le réservoir devient visible (`min`) et où il s'emplit (`full`),
 * la descente par ceux où il quitte son plein et disparaît ; un réservoir qui ne s'emplit pas les
 * mène par son sommet, à la hauteur de ce sommet.
 *
 * La part couverte (composeCover) compose ce niveau avec la rampe de l'instant de
 * data/seasons.json, celle que la carte montrait avant 2b.7 : r(p), de part rmin au mois le plus
 * chaud et `most` au plus froid.
 * - Au refroidissement : max(rmin, min(r(p), most × montée)). La couverture n'arrive jamais plus
 *   tôt que la rampe, plus tard là où il neige peu ; la montée est pleine au plus tard au jour le
 *   plus froid, si bien que l'étendue au cœur de l'hiver est celle de la rampe.
 * - Au réchauffement : max(r(p), most × descente). La couverture ne part jamais plus tôt que la
 *   rampe, et reste après le redoux tant que le réservoir tient, d'autant plus qu'il est épais.
 * La part est continue : au jour le plus froid, les deux moitiés valent `most` ; au jour le plus
 * chaud, rmin, le plancher de l'été de la rampe (nul, sauf là où elle couvre encore au mois le plus
 * chaud). La descente finit au plus `maxLag` jours après la rampe, et jamais dans les `summerDays`
 * jours centrés sur le jour le plus chaud : la carte y est celle de la rampe. Montée et descente
 * durent au moins `minTransition` jours.
 *
 * Déterminisme : opérations exactes et cosinus de dmath, tabulés, sur des entrées arrondies à la
 * précision de la texture des saisons (demi-degré, huitième de degré) et la pluie par RAIN_STEP
 * millimètres ; les cases d'un même climat partagent leur calcul ; aucun tirage. Les mêmes octets
 * dans le worker de la simulation, qui les calcule, et partout où ils voyagent.
 */
import type { Biome, IceCover, Seasons, SnowCover } from './data/schemas';
import { cos, TAU } from './dmath';
import { coverShare, latitude, rainSeasonality, WARMEST_MONTH, type CoverRamp } from './seasons';
import { DAYS_PER_MONTH, DAYS_PER_YEAR, MONTHS_PER_YEAR } from './time';
import type { WorldLayers, WorldSize } from './world';

/** Jours d'une année (ADR 0013). */
export const YEAR_DAYS = DAYS_PER_YEAR;

/** Jour de phase le plus froid : le refroidissement le précède, le réchauffement le suit. */
export const COLDEST_PHASE = YEAR_DAYS / 2;

/** Octets d'un calendrier : début, fin (en 255es d'année), montée, descente (en jours). */
export const CALENDAR_BYTES = 4;

/** Jours d'une unité des octets de début et de fin. */
export const DAYS_PER_UNIT = YEAR_DAYS / 255;

/** Pluie annuelle arrondie, en millimètres, que lisent les calendriers de la neige. */
export const RAIN_STEP = 20;

/**
 * Le calendrier sans inertie : pleine montée dès le jour le plus chaud, aucune descente, si bien
 * que la part est celle de la rampe toute l'année. C'est celui des cases qui ne se couvrent jamais,
 * ou autant l'été que l'hiver, et des eaux qui ne gèlent pas.
 */
export const RAMP_ONLY: readonly [number, number, number, number] = [0, 0, 1, 1];

/** Les trois couvertures à calendrier, et leurs réglages dans data/seasons.json. */
export type CalendarCover = 'snow' | 'ice' | 'sea-ice';

/** Les réglages d'une couverture à calendrier. */
export function coverSettings(seasons: Seasons, cover: CalendarCover): SnowCover | IceCover {
  return cover === 'snow' ? seasons.snow : cover === 'ice' ? seasons.freshIce : seasons.seaIce;
}

/** Rampe de chaque couverture saisonnière ; `none` ne couvre jamais. */
export function coverRamps(seasons: Seasons): Readonly<Record<CalendarCover | 'none', CoverRamp>> {
  return {
    none: NO_COVER,
    snow: seasons.snow.ramp,
    ice: seasons.freshIce.ramp,
    'sea-ice': seasons.seaIce.ramp,
  };
}

/** La rampe d'une case sans couverture. */
export const NO_COVER: CoverRamp = { onset: 0, span: 1, full: 0 };

/** Jour de l'année (0 au début de janvier) où culmine l'été au nord, ou au sud. */
export function warmestDay(south: boolean): number {
  const month = WARMEST_MONTH + (south ? MONTHS_PER_YEAR / 2 : 0);
  return (month * DAYS_PER_MONTH) % YEAR_DAYS;
}

/** Jours depuis le jour le plus chaud de la case, dans [0, YEAR_DAYS), au jour continu `day`. */
export function phaseDay(day: number, south: boolean): number {
  const phase = (day - warmestDay(south)) % YEAR_DAYS;
  return phase < 0 ? phase + YEAR_DAYS : phase;
}

/** Code de la température annuelle (°C), par demi-degré, comme le rouge de la texture des saisons. */
export function encodeTemperature(celsius: number): number {
  return Math.min(255, Math.max(0, Math.round((celsius + 64) * 2)));
}

/** Code de la demi-amplitude (°C), par huitième de degré, comme le vert de la texture des saisons. */
export function encodeAmplitude(celsius: number): number {
  return Math.min(255, Math.max(0, Math.round(celsius * 8)));
}

/** Température annuelle (°C) d'un code (encodeTemperature). */
export function codeTemperature(code: number): number {
  return code / 2 - 64;
}

/** Demi-amplitude (°C) d'un code (encodeAmplitude). */
export function codeAmplitude(code: number): number {
  return code / 8;
}

/** Le climat arrondi d'une case, que lisent ses calendriers. */
export interface CalendarClimate {
  /** Codes de la température annuelle et de la demi-amplitude (texture des saisons). */
  readonly temperature: number;
  readonly amplitude: number;
  /** Pluie annuelle, en RAIN_STEP millimètres. */
  readonly precipitation: number;
  /** Force de la saison des pluies (rainSeasonality), en centièmes. */
  readonly rain: number;
}

/** Le climat arrondi de la case `cell` d'un monde de `height` lignes. */
export function cellClimate(layers: WorldLayers, cell: number, width: number, height: number) {
  const y = Math.floor(cell / width);
  return {
    temperature: encodeTemperature((layers.temperature[cell] ?? 0) / 10),
    amplitude: encodeAmplitude((layers.amplitude[cell] ?? 0) / 10),
    precipitation: Math.round((layers.precipitation[cell] ?? 0) / RAIN_STEP),
    rain: rainHundredths(y, height),
  } satisfies CalendarClimate;
}

/** Force de la saison des pluies de la ligne y, en centièmes. */
function rainHundredths(y: number, height: number): number {
  return Math.round(rainSeasonality(latitude(y, height)) * 100);
}

/** Cosinus du jour de phase, aux bornes des pas (n + 1 valeurs) et à leur milieu (n valeurs). */
interface PhaseTable {
  readonly edges: Float64Array;
  readonly middles: Float64Array;
}

const tables = new Map<number, PhaseTable>();

function phaseTable(step: number): PhaseTable {
  let table = tables.get(step);
  if (table === undefined) {
    const steps = YEAR_DAYS / step;
    table = {
      edges: Float64Array.from({ length: steps + 1 }, (_, k) => cos((TAU * k * step) / YEAR_DAYS)),
      middles: Float64Array.from({ length: steps }, (_, k) =>
        cos((TAU * (k + 0.5) * step) / YEAR_DAYS),
      ),
    };
    tables.set(step, table);
  }
  return table;
}

/** Les réglages communs des calendriers. */
type Rules = Pick<Seasons, 'step' | 'minTransition' | 'summerDays'>;

/** Réservoir de neige d'une case, jour après jour, aux bornes des pas (vide au jour 0). */
function snowStore(climate: CalendarClimate, snow: SnowCover, step: number, out: Float64Array) {
  const { middles } = phaseTable(step);
  const annual = codeTemperature(climate.temperature);
  const amplitude = codeAmplitude(climate.amplitude);
  const perStep = (climate.precipitation * RAIN_STEP * step) / YEAR_DAYS;
  const rain = climate.rain / 100;
  const span = snow.rainAbove - snow.snowBelow;
  let store = 0;
  out[0] = 0;
  for (let k = 0; k < middles.length; k++) {
    const c = middles[k] ?? 1;
    const temperature = annual + amplitude * c;
    let gain = 0;
    if (temperature < snow.rainAbove) {
      const part = temperature <= snow.snowBelow ? 1 : (snow.rainAbove - temperature) / span;
      gain = perStep * (1 + rain * c) * part;
    }
    const loss = temperature > 0 ? snow.meltRate * temperature * step : 0;
    store = Math.max(0, store + gain - loss);
    out[k + 1] = store;
  }
}

/** Épaisseur de la glace d'une eau, jour après jour, aux bornes des pas (nulle au jour 0). */
function iceStore(climate: CalendarClimate, ice: IceCover, step: number, out: Float64Array) {
  const { middles } = phaseTable(step);
  const annual = codeTemperature(climate.temperature);
  const amplitude = codeAmplitude(climate.amplitude);
  let store = 0;
  out[0] = 0;
  for (let k = 0; k < middles.length; k++) {
    const temperature = annual + amplitude * (middles[k] ?? 1);
    const below = ice.freezeBelow - temperature;
    if (below > 0) store += (ice.growth * below * step * ice.stefan) / (ice.stefan + store);
    else store = Math.max(0, store + ice.thaw * below * step);
    out[k + 1] = store;
  }
}

/**
 * Jour de phase où la rampe cesse de couvrir au réchauffement (sa fin), ou YEAR_DAYS si elle couvre
 * encore au jour le plus chaud : le symétrique du jour où elle commence au refroidissement, que la
 * table des pas encadre et qu'une interpolation de la température situe.
 */
function rampEnd(ramp: CoverRamp, annual: number, amplitude: number, step: number): number {
  const { edges } = phaseTable(step);
  let before = annual + amplitude * edges[0];
  if (before < ramp.onset) return YEAR_DAYS;
  for (let k = 1; k < edges.length; k++) {
    const temperature = annual + amplitude * (edges[k] ?? 1);
    if (temperature < ramp.onset) {
      const begin = (k - 1 + (before - ramp.onset) / (before - temperature)) * step;
      return YEAR_DAYS - begin;
    }
    before = temperature;
  }
  return COLDEST_PHASE;
}

/**
 * Le jour où le réservoir, échantillonné aux bornes des pas, atteint `level` en montant, par
 * interpolation entre deux pas ; NaN s'il ne l'atteint jamais. `reach` : il l'atteint en
 * l'égalant (le plein) ; sinon, en le dépassant (le minimum visible).
 */
function rising(samples: Float64Array, level: number, step: number, reach: boolean): number {
  for (let k = 1; k < samples.length; k++) {
    const before = samples[k - 1] ?? 0;
    const after = samples[k] ?? 0;
    if (reach ? before < level && after >= level : before <= level && after > level) {
      return (k - 1 + (level - before) / (after - before)) * step;
    }
  }
  return Number.NaN;
}

/**
 * Le jour où le réservoir, après l'indice `from`, repasse sous `level` (`reach` : sous le plein)
 * ou l'égale (sinon : il n'est plus visible) ; NaN s'il ne le fait pas dans l'année.
 */
function falling(
  samples: Float64Array,
  level: number,
  from: number,
  step: number,
  reach: boolean,
): number {
  for (let k = from + 1; k < samples.length; k++) {
    const before = samples[k - 1] ?? 0;
    const after = samples[k] ?? 0;
    if (reach ? before >= level && after < level : before > level && after <= level) {
      return (k - 1 + (before - level) / (before - after)) * step;
    }
  }
  return Number.NaN;
}

/** Quatre octets en un nombre, le premier en poids faible. */
function pack(start: number, end: number, rise: number, fall: number): number {
  return (start | (end << 8) | (rise << 16) | (fall << 24)) >>> 0;
}

const RAMP_PACKED = pack(...RAMP_ONLY);

/**
 * Le calendrier d'un réservoir intégré sur une année (`samples`, aux bornes des pas, unimodal : il
 * croît tant que le jour gagne plus qu'il ne perd, puis décroît), de seuils `min` et `full`, dont la
 * descente finit au plus tard à `latest`.
 * - La montée finit au plus tard au jour le plus froid : un réservoir lent, ou qui ne devient
 *   jamais visible, s'y emplit en `minTransition` jours au moins.
 * - Un réservoir qui tient encore à `latest` fond pour y finir ; un réservoir jamais visible n'a
 *   pas de descente, et la rampe seule mène le réchauffement.
 */
function encodeStore(
  samples: Float64Array,
  min: number,
  full: number,
  latest: number,
  rules: Rules,
): number {
  const { step, minTransition } = rules;
  const transition = Math.ceil(minTransition);
  const length = (days: number) => Math.min(255, Math.max(transition, Math.round(days)));
  let peak = 0;
  let peakAt = 0;
  for (let k = 0; k < samples.length; k++) {
    const value = samples[k] ?? 0;
    if (value > peak) {
      peak = value;
      peakAt = k;
    }
  }
  const start = rising(samples, min, step, false);
  const visible = !Number.isNaN(start) && start < COLDEST_PHASE;
  const reached = peak >= full;
  const top = reached ? 1 : (peak - min) / (full - min);
  // La montée, pleine au plus tard au jour le plus froid.
  const filled = reached ? rising(samples, full, step, true) : peakAt * step;
  const rise = Math.min(
    visible ? length((filled - start) / top) : transition,
    Math.max(transition, Math.floor(COLDEST_PHASE - (visible ? start : COLDEST_PHASE))),
  );
  const first = Math.min(
    visible ? Math.round(start / DAYS_PER_UNIT) : 255,
    Math.floor((COLDEST_PHASE - rise) / DAYS_PER_UNIT),
  );
  if (Number.isNaN(start)) return pack(first, 0, rise, transition);
  // La descente, finie au plus tard à `latest`.
  const left = reached ? falling(samples, full, peakAt, step, true) : peakAt * step;
  const gone = falling(samples, min, peakAt, step, false);
  const end = Number.isNaN(gone) ? latest : Math.min(gone, latest);
  const melt = Number.isNaN(left) ? end : Math.min(left, end);
  const last = Math.min(Math.round(end / DAYS_PER_UNIT), Math.floor(latest / DAYS_PER_UNIT));
  return pack(first, Math.max(0, last), rise, length((end - melt) / top));
}

/** Les réservoirs d'une intégration, réutilisés d'un calendrier à l'autre. */
let samples = new Float64Array(0);

function samplesFor(step: number): Float64Array {
  const length = YEAR_DAYS / step + 1;
  if (samples.length !== length) samples = new Float64Array(length);
  return samples;
}

/**
 * La borne de la fin d'un calendrier de rampe `ramp`, de retard `maxLag`, ou NaN si la couverture
 * ne varie pas avec la saison (aucun calendrier) : la rampe ne couvre jamais, ou autant l'été que
 * l'hiver.
 */
function latestEnd(
  ramp: CoverRamp,
  climate: CalendarClimate,
  maxLag: number,
  rules: Rules,
): number {
  const annual = codeTemperature(climate.temperature);
  const amplitude = codeAmplitude(climate.amplitude);
  const most = coverShare(ramp, annual - amplitude);
  if (most <= 0 || coverShare(ramp, annual + amplitude) >= most) return Number.NaN;
  const end = rampEnd(ramp, annual, amplitude, rules.step);
  return Math.min(end + maxLag, YEAR_DAYS - rules.summerDays / 2);
}

/** Calendrier de la neige d'une case, ses quatre octets en un nombre (le premier en poids faible). */
export function snowCalendar(climate: CalendarClimate, seasons: Seasons): number {
  const { snow } = seasons;
  const latest = latestEnd(snow.ramp, climate, snow.maxLag, seasons);
  if (Number.isNaN(latest)) return RAMP_PACKED;
  const out = samplesFor(seasons.step);
  snowStore(climate, snow, seasons.step, out);
  return encodeStore(out, snow.min, snow.full, latest, seasons);
}

/** Calendrier de la glace d'une eau, glace d'eau douce ou banquise. */
export function iceCalendar(climate: CalendarClimate, sea: boolean, seasons: Seasons): number {
  const ice = sea ? seasons.seaIce : seasons.freshIce;
  const latest = latestEnd(ice.ramp, climate, ice.maxLag, seasons);
  if (Number.isNaN(latest)) return RAMP_PACKED;
  const out = samplesFor(seasons.step);
  iceStore(climate, ice, seasons.step, out);
  return encodeStore(out, ice.min, ice.full, latest, seasons);
}

/** Les quatre octets d'un calendrier (snowCalendar, iceCalendar). */
export function calendarBytes(packed: number): [number, number, number, number] {
  return [packed & 255, (packed >>> 8) & 255, (packed >>> 16) & 255, packed >>> 24];
}

/**
 * Niveau du calendrier rangé aux octets [at, at + CALENDAR_BYTES) de `bytes`, au jour de phase
 * `phase`, de 0 à 1 : sa montée au refroidissement, sa descente au réchauffement. Le shader de la
 * carte calcule le même (mapShader.ts, COVER_GLSL).
 */
export function calendarLevel(bytes: ArrayLike<number>, at: number, phase: number): number {
  const level =
    phase < COLDEST_PHASE
      ? (phase - (bytes[at] ?? 0) * DAYS_PER_UNIT) / (bytes[at + 2] ?? 1)
      : ((bytes[at + 1] ?? 0) * DAYS_PER_UNIT - phase) / (bytes[at + 3] ?? 1);
  return Math.min(1, Math.max(0, level));
}

/**
 * La part couverte d'une case de rampe `ramp`, de température annuelle `annual` et de
 * demi-amplitude `amplitude` (°C), au jour de phase `phase`, de température `daily`, au niveau
 * `level` de son calendrier (calendarLevel) : la composition de l'en-tête, que le shader de la
 * carte calcule aussi.
 */
export function composeCover(
  ramp: CoverRamp,
  annual: number,
  amplitude: number,
  daily: number,
  phase: number,
  level: number,
): number {
  const most = coverShare(ramp, annual - amplitude);
  if (most <= 0) return 0;
  const now = coverShare(ramp, daily);
  if (phase >= COLDEST_PHASE) return Math.max(now, most * level);
  return Math.max(coverShare(ramp, annual + amplitude), Math.min(now, most * level));
}

/** Sorte de glace d'une case : aucune, eau douce (et rivières des terres), banquise. */
const ICE_KIND = { none: 0, fresh: 1, sea: 2 } as const;

/** La sorte de glace d'un biome : la couverture d'une eau, la glace des rivières d'une terre. */
function iceKind(biome: Biome): number {
  if (biome.family !== 'water') return ICE_KIND.fresh;
  if (biome.seasons.cover === 'sea-ice') return ICE_KIND.sea;
  return biome.seasons.cover === 'ice' ? ICE_KIND.fresh : ICE_KIND.none;
}

/**
 * Les calendriers d'un monde, CALENDAR_BYTES octets par case et par couverture : la neige de
 * toutes les cases, puis leur glace (snowAt, iceAt). La neige ne dépend que du climat, qu'aucune
 * commande ne change ; la glace, du climat et de la sorte d'eau, que le pinceau ne change pas, lui
 * qui ne peint ni n'efface l'eau : un coup de pinceau ne change aucun calendrier.
 */
export function worldCalendars(
  size: WorldSize,
  layers: WorldLayers,
  biomes: readonly Biome[],
  seasons: Seasons,
): Uint8Array<ArrayBuffer> {
  const { width, height } = size;
  const count = width * height;
  const bytes = new Uint8Array(count * 2 * CALENDAR_BYTES);
  const view = new DataView(bytes.buffer);
  const kinds = biomes.map(iceKind);
  const snows = new Map<number, number>();
  const ices = new Map<number, number>();
  for (let y = 0; y < height; y++) {
    const rain = rainHundredths(y, height);
    for (let x = 0; x < width; x++) {
      const cell = y * width + x;
      const climate: CalendarClimate = {
        temperature: encodeTemperature((layers.temperature[cell] ?? 0) / 10),
        amplitude: encodeAmplitude((layers.amplitude[cell] ?? 0) / 10),
        precipitation: Math.round((layers.precipitation[cell] ?? 0) / RAIN_STEP),
        rain,
      };
      const climateKey = climate.temperature * 256 + climate.amplitude;
      const snowKey = (climateKey * 4096 + climate.precipitation) * 128 + rain;
      let snow = snows.get(snowKey);
      if (snow === undefined) {
        snow = snowCalendar(climate, seasons);
        snows.set(snowKey, snow);
      }
      view.setUint32(cell * CALENDAR_BYTES, snow, true);
      const kind = kinds[layers.biome[cell] ?? 0] ?? ICE_KIND.none;
      if (kind === ICE_KIND.none) {
        view.setUint32((count + cell) * CALENDAR_BYTES, RAMP_PACKED, true);
        continue;
      }
      const iceKey = climateKey * 4 + kind;
      let ice = ices.get(iceKey);
      if (ice === undefined) {
        ice = iceCalendar(climate, kind === ICE_KIND.sea, seasons);
        ices.set(iceKey, ice);
      }
      view.setUint32((count + cell) * CALENDAR_BYTES, ice, true);
    }
  }
  return bytes;
}

/** Indice, dans les calendriers d'un monde de `count` cases, du calendrier de neige de `cell`. */
export function snowAt(cell: number): number {
  return cell * CALENDAR_BYTES;
}

/** Indice, dans les calendriers d'un monde de `count` cases, du calendrier de glace de `cell`. */
export function iceAt(cell: number, count: number): number {
  return (count + cell) * CALENDAR_BYTES;
}
