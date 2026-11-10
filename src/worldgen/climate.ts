/**
 * Climat (tâche 1.3, MON-15, SAI-02 ; C1, D8 et D13).
 *
 * - Température annuelle : 27 °C à l'équateur et −25 °C aux pôles au niveau de la mer,
 *   décalées par le paramètre « température », puis 6,5 °C de moins par 1 000 m.
 * - Continentalité : distance à l'océan, à vol d'oiseau et face au vent dominant.
 * - Demi-amplitude saisonnière (D8) : A = (1 + 15 |lat|^1,3) × (0,75 + 0,5 × continentalité).
 * - Précipitations : bandes de latitude (équateur humide, zone sèche vers 30°, latitudes
 *   moyennes humides, pôles secs) ; vents dominants par bande (alizés d'est, vents
 *   d'ouest, vents d'est polaires) qui se chargent d'humidité au-dessus de la mer et la
 *   perdent au-dessus des terres ; pluie de relief sur les versants au vent, ombre
 *   pluviométrique derrière les montagnes.
 *
 * La latitude va de 0 à l'équateur à 1 aux pôles ; l'hémisphère nord occupe la moitié
 * haute de la carte. Les distances se comptent en fraction du tour du monde : le climat
 * ne dépend pas de la résolution de la carte.
 */
import { exp, pow } from '../core/dmath';
import type { Rng } from '../core/rng';
import { latitude } from '../core/seasons';
import type { WorldSize } from '../core/world';
import { boxBlur, distanceField, neighborTable } from './grid';
import { NoiseLayer, type CylinderSampler, type Fractal } from './sampler';

/** Réglages du climat (data/worldgen.json). */
export interface ClimateConfig {
  /** Température annuelle au niveau de la mer, à l'équateur et aux pôles (°C). */
  readonly equatorTemperature: number;
  readonly poleTemperature: number;
  /** Exposant de la latitude dans la baisse des températures vers les pôles. */
  readonly latitudeExponent: number;
  /** Baisse de la température avec l'altitude (°C par 1 000 m). */
  readonly lapseRate: number;
  /** Précipitations d'une case au maximum de la bande équatoriale (mm par an). */
  readonly precipitationScale: number;
}

export interface ClimateParams {
  /** Décalage de toutes les températures (°C). */
  readonly temperature: number;
  /** Multiplicateur des précipitations. */
  readonly humidity: number;
}

export interface Climate {
  /** Température annuelle moyenne (°C). */
  readonly temperature: Float32Array;
  /** Demi-amplitude saisonnière (°C). */
  readonly amplitude: Float32Array;
  /** Précipitations annuelles (mm). */
  readonly precipitation: Float32Array;
  /** Continentalité, de 0 (au bord de l'océan) à 1. */
  readonly continentality: Float32Array;
}

export { latitude, southern } from '../core/seasons';

/** Variation saisonnière de bruit, petite et lente : le climat n'est pas une simple bande. */
const VARIATION: Fractal = { frequency: 3, octaves: 3 };
/** Amplitude de cette variation : °C pour la température, part pour la pluie. */
const TEMPERATURE_VARIATION = 2;
const PRECIPITATION_VARIATION = 0.3;

/** Part des pluies apportée par les vents dominants ; le reste vient de la mer voisine. */
const ADVECTED_SHARE = 0.75;

/** Distance (fraction du tour du monde) où la continentalité atteint la moitié. */
const CONTINENTAL_DISTANCE = 0.025;

/**
 * Bandes de précipitations : facteur de pluie selon la latitude, de l'ordre de 1 à
 * l'équateur, 0,15 vers 30° et aux pôles, 0,75 vers 55°.
 */
export function rainBand(lat: number): number {
  const equator = lat / 0.13;
  const front = (lat - 0.6) / 0.14;
  return 0.15 + 0.9 * exp(-equator * equator) + 0.6 * exp(-front * front);
}

/** Humidité que l'air peut porter à la température t (°C), relative. */
function saturation(t: number): number {
  return Math.min(1.2, Math.max(0.05, (t + 15) / 45));
}

/**
 * Taux d'un processus continu sur une distance d'une case : 1 − e^(−taux × pas), où le
 * pas est la largeur d'une case en tours du monde. La même distance donne le même effet
 * à toutes les résolutions.
 */
function perCell(rate: number, width: number): number {
  return 1 - exp(-rate / width);
}

/** Taux par tour du monde : évaporation en mer, pluie sur terre et sur mer, pluie de l'excédent. */
const EVAPORATION_RATE = 40;
const RAIN_RATE = 14;
const OCEAN_RAIN_RATE = 4;
const EXCESS_RATE = 100;
/**
 * Pluie de relief : supplément du taux de pluie par kilomètre de montée, borné à
 * OROGRAPHIC_CAP fois le taux de pluie ordinaire. Sans borne, un versant raide recevait
 * en quelques cases presque toute l'humidité de l'air : 30 à 60 fois la pluie normale.
 */
const OROGRAPHIC_RAIN = 0.5;
const OROGRAPHIC_CAP = 3;
/**
 * Part de la pluie qui retourne à l'air au-dessus des terres (évapotranspiration) : plus
 * forte sous les tropiques humides, plus faible sous les climats secs.
 */
const RECYCLING = { base: 0.35, wet: 0.3 };
/** Diffusion de l'humidité entre lignes voisines, à chaque pas de vent, sur une carte Grand. */
const MIXING = 0.08;
/** Demi-largeur, en latitude, du passage d'un vent dominant à l'autre. */
const WIND_TRANSITION = 0.05;

/**
 * Poids du vent d'ouest à la latitude `lat`, de 0 à 1 : 1 au cœur des latitudes moyennes,
 * 0 sous les alizés et les vents d'est polaires, avec un passage progressif à 30° et 60°.
 */
export function westerlyWeight(lat: number): number {
  const south = smooth((lat - (1 / 3 - WIND_TRANSITION)) / (2 * WIND_TRANSITION));
  const north = smooth((2 / 3 + WIND_TRANSITION - lat) / (2 * WIND_TRANSITION));
  return Math.min(south, north);
}

function smooth(value: number): number {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
}

/**
 * Précipitations relatives (sans unité), par advection de l'humidité le long d'un vent
 * qui souffle dans le sens `direction` sur toute la carte. Le monde est balayé colonne
 * par colonne, deux fois de suite : au second tour, l'humidité ne dépend plus du point
 * de départ.
 *
 * Au-dessus de la mer, l'air se charge jusqu'à la saturation, qui croît avec la
 * température. Au-dessus des terres, il pleut selon la bande de latitude, davantage en
 * montée (pluie de relief), et l'air refroidi par l'altitude perd peu à peu son
 * excédent. Redescendu, l'air réchauffé est loin de la saturation : il ne pleut presque
 * plus, c'est l'ombre pluviométrique.
 */
function advect(
  size: WorldSize,
  elevation: Float32Array,
  ocean: Uint8Array,
  temperature: Float32Array,
  direction: -1 | 1,
): Float32Array {
  const { width, height } = size;
  const rain = new Float32Array(width * height);
  const evaporation = perCell(EVAPORATION_RATE, width);
  const rainRate = perCell(RAIN_RATE, width);
  const oceanRain = perCell(OCEAN_RAIN_RATE, width);
  const excessRate = perCell(EXCESS_RATE, width);
  // Le mélange entre lignes s'étend sur une même fraction du monde à toutes les résolutions.
  const mixing = Math.min(0.45, (MIXING * width) / 1024);
  const bandFactor = Float32Array.from({ length: height }, (_, y) => rainBand(latitude(y, height)));
  const moisture = new Float32Array(height).fill(1);
  const mixed = new Float32Array(height);
  for (let step = 0; step < 2 * width; step++) {
    const x = direction > 0 ? step % width : width - 1 - (step % width);
    const previousX = (x - direction + width) % width;
    const record = step >= width;
    for (let y = 0; y < height; y++) {
      const index = y * width + x;
      const capacity = saturation(temperature[index] ?? 0);
      const factor = bandFactor[y] ?? 0;
      let m = moisture[y] ?? 0;
      let fallen: number;
      if (ocean[index]) {
        m += (capacity - m) * evaporation;
        fallen = m * oceanRain * factor;
        m -= fallen;
      } else {
        const here = Math.max(0, elevation[index] ?? 0);
        const before = Math.max(0, elevation[y * width + previousX] ?? 0);
        const climb = Math.max(0, here - before) / 1000;
        // L'air refroidi au-delà de sa saturation pleut peu à peu son excédent.
        const excess = Math.max(0, m - capacity) * excessRate;
        m -= excess;
        const relativeHumidity = Math.min(1, m / capacity);
        const orographic = Math.min(OROGRAPHIC_CAP * rainRate, OROGRAPHIC_RAIN * climb);
        const rate = Math.min(1, rainRate * factor + orographic) * relativeHumidity;
        fallen = excess + m * rate;
        const recycling = RECYCLING.base + RECYCLING.wet * Math.min(1, factor);
        m += recycling * fallen - m * rate;
      }
      moisture[y] = m;
      if (record) rain[index] = fallen;
    }
    // Un peu d'humidité passe d'une ligne à ses voisines.
    for (let y = 0; y < height; y++) {
      const above = moisture[Math.max(0, y - 1)] ?? 0;
      const below = moisture[Math.min(height - 1, y + 1)] ?? 0;
      const here = moisture[y] ?? 0;
      mixed[y] = here + mixing * ((above + below) / 2 - here);
    }
    moisture.set(mixed);
  }
  return rain;
}

/**
 * Précipitations relatives sous les vents dominants : un balayage par sens de vent, puis
 * un mélange selon la latitude, sans cassure entre les bandes.
 */
function prevailingRain(
  size: WorldSize,
  elevation: Float32Array,
  ocean: Uint8Array,
  temperature: Float32Array,
): Float32Array {
  const { width, height } = size;
  const eastward = advect(size, elevation, ocean, temperature, 1);
  const westward = advect(size, elevation, ocean, temperature, -1);
  const rain = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const weight = westerlyWeight(latitude(y, height));
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      rain[index] = weight * (eastward[index] ?? 0) + (1 - weight) * (westward[index] ?? 0);
    }
  }
  return rain;
}

/** Climat complet d'un monde. */
export function generateClimate(
  sampler: CylinderSampler,
  rng: Rng,
  elevation: Float32Array,
  ocean: Uint8Array,
  config: ClimateConfig,
  params: ClimateParams,
): Climate {
  const size = { width: sampler.width, height: sampler.height };
  const { width, height } = size;
  const count = width * height;
  const neighbors = neighborTable(size);
  const temperatureNoise = sampler.fractal(
    new NoiseLayer(rng.stream('worldgen.climate.temperature')),
    VARIATION,
  );
  const rainNoise = sampler.fractal(new NoiseLayer(rng.stream('worldgen.climate.rain')), VARIATION);

  // Températures annuelles.
  const temperature = new Float32Array(count);
  const span = config.equatorTemperature - config.poleTemperature;
  for (let y = 0; y < height; y++) {
    const lat = latitude(y, height);
    const seaLevel = config.equatorTemperature - span * pow(lat, config.latitudeExponent);
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const altitude = ocean[index] ? 0 : Math.max(0, elevation[index] ?? 0);
      temperature[index] =
        seaLevel +
        params.temperature +
        TEMPERATURE_VARIATION * (temperatureNoise[index] ?? 0) -
        (config.lapseRate * altitude) / 1000;
    }
  }

  // Continentalité : distance à l'océan, à vol d'oiseau et face au vent. Les deux sens
  // du vent se mêlent selon la latitude, sans cassure à 30° et 60°, comme pour la pluie.
  const distance = distanceField(ocean, size, neighbors);
  const half = CONTINENTAL_DISTANCE * width;
  const eastward = upwindRuns(size, ocean, 1);
  const westward = upwindRuns(size, ocean, -1);
  const continentality = new Float32Array(count);
  for (let index = 0; index < count; index++) {
    if (ocean[index]) continue;
    const y = Math.floor(index / width);
    const weight = westerlyWeight(latitude(y, height));
    const near = distance[index] ?? 0;
    const exposure = (run: number) => {
      const wind = Math.min(run, 4 * width);
      return wind / (wind + 2 * half);
    };
    const wind =
      weight * exposure(eastward[index] ?? 0) + (1 - weight) * exposure(westward[index] ?? 0);
    continentality[index] = 0.5 * (near / (near + half)) + 0.5 * wind;
  }

  // Demi-amplitude saisonnière (D8).
  const amplitude = new Float32Array(count);
  for (let y = 0; y < height; y++) {
    const polar = 1 + 15 * pow(latitude(y, height), 1.3);
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      amplitude[index] = polar * (0.75 + 0.5 * (continentality[index] ?? 0));
    }
  }

  // Précipitations : advection, lissage léger, variation, mise à l'échelle.
  const relative = boxBlur(
    prevailingRain(size, elevation, ocean, temperature),
    size,
    Math.max(1, Math.round(width / 512)),
  );
  // Référence : la pluie moyenne de la mer sous l'équateur, qui ne dépend que des vents
  // et de la température, et non de la forme des continents.
  let reference = 0;
  let samples = 0;
  // Sur une carte basse, les lignes les plus proches de l'équateur en tiennent lieu.
  const band = Math.max(0.05, 1.5 / height);
  for (let y = 0; y < height; y++) {
    if (latitude(y, height) >= band) continue;
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (ocean[index]) {
        reference += relative[index] ?? 0;
        samples++;
      }
    }
  }
  reference = samples > 0 ? reference / samples : 1;
  // Pluie finale : celle des vents dominants, plus une part qui vient de la mer voisine
  // par tous les vents (brises, moussons), décroissante vers l'intérieur des terres.
  const equatorBand = rainBand(0);
  const precipitation = new Float32Array(count);
  for (let index = 0; index < count; index++) {
    const y = Math.floor(index / width);
    const near = distance[index] ?? 0;
    const maritime = ocean[index] ? 1 : 1 - near / (near + half);
    const diffuse = (rainBand(latitude(y, height)) / equatorBand) * maritime;
    const advected = (relative[index] ?? 0) / reference;
    const variation = 1 + PRECIPITATION_VARIATION * (rainNoise[index] ?? 0);
    precipitation[index] = Math.max(
      0,
      (ADVECTED_SHARE * advected + (1 - ADVECTED_SHARE) * diffuse) *
        config.precipitationScale *
        variation *
        params.humidity,
    );
  }
  return { temperature, amplitude, precipitation, continentality };
}

/**
 * Distance au vent, en cases, de la dernière case d'océan d'un vent qui souffle dans le
 * sens `direction` ; le monde est balayé deux fois, pour boucler à la couture.
 */
function upwindRuns(size: WorldSize, ocean: Uint8Array, direction: -1 | 1): Float32Array {
  const { width, height } = size;
  const runs = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    let run = Number.POSITIVE_INFINITY;
    for (let step = 0; step < 2 * width; step++) {
      const x = direction > 0 ? step % width : width - 1 - (step % width);
      const index = y * width + x;
      run = ocean[index] ? 0 : run + 1;
      if (step >= width) runs[index] = run;
    }
  }
  return runs;
}

export { extremeMonths, monthlyTemperature } from '../core/seasons';
