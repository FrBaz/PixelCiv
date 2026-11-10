/**
 * Échantillonnage du bruit sur le cylindre du monde (ADR 0002, tâche 1.1).
 *
 * La longitude devient un angle θ : la case (x, y) lit le bruit 3D au point
 * (r cos θ, r sin θ, z), sur un cylindre dont la circonférence vaut une unité, et dont
 * la hauteur suit la même échelle que la largeur. La colonne x et la colonne x + largeur
 * sont le même point : la carte se referme d'est en ouest sans couture.
 *
 * Les fréquences se comptent en unités de bruit par tour du monde. Elles ne dépendent
 * pas de la taille de la carte : une même graine donne les mêmes continents à toutes les
 * tailles, plus ou moins détaillés. Une octave plus fine que trois cases n'est pas lue :
 * échantillonnée trop grossièrement, elle produirait du repliement (aliasing).
 */
import { cos, sin, TAU } from '../core/dmath';
import { Simplex3 } from '../core/noise';
import type { RandomStream } from '../core/rng';
import type { WorldSize } from '../core/world';

/** Plus petite période lue, en cases : en deçà, l'octave se replierait. */
const MIN_PERIOD = 3;

/** Bruit fractal : une somme d'octaves de plus en plus fines. */
export interface Fractal {
  /** Fréquence de la première octave, en unités de bruit par tour du monde. */
  readonly frequency: number;
  /** Nombre d'octaves, avant la limite de résolution. */
  readonly octaves: number;
  /** Rapport de fréquence entre deux octaves successives. */
  readonly lacunarity?: number;
  /** Rapport d'amplitude entre deux octaves successives. */
  readonly gain?: number;
}

/** Une couche de bruit : sa permutation et son décalage, tirés d'un flux. */
export class NoiseLayer {
  readonly simplex: Simplex3;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly offsetZ: number;

  constructor(random: RandomStream) {
    this.simplex = new Simplex3(random);
    // Le décalage écarte l'axe du cylindre des sommets de la grille du bruit.
    this.offsetX = random.nextFloat() * 256;
    this.offsetY = random.nextFloat() * 256;
    this.offsetZ = random.nextFloat() * 256;
  }
}

/** Grille du monde vue comme un cylindre. */
export class CylinderSampler {
  readonly width: number;
  readonly height: number;
  /** cos θ et sin θ de chaque colonne, multipliés par le rayon 1/(2π). */
  private readonly cosines: Float64Array;
  private readonly sines: Float64Array;

  constructor(size: WorldSize) {
    this.width = size.width;
    this.height = size.height;
    this.cosines = new Float64Array(size.width);
    this.sines = new Float64Array(size.width);
    for (let x = 0; x < size.width; x++) {
      const angle = (TAU * (x + 0.5)) / size.width;
      this.cosines[x] = cos(angle) / TAU;
      this.sines[x] = sin(angle) / TAU;
    }
  }

  /** Hauteur de la case y sur le cylindre, à l'échelle de la circonférence. */
  private z(y: number): number {
    return (y + 0.5) / this.width;
  }

  /** Nombre d'octaves lisibles à cette résolution, sur les `octaves` demandées. */
  octavesFor(fractal: Fractal): number {
    const lacunarity = fractal.lacunarity ?? 2;
    let count = 0;
    let frequency = fractal.frequency;
    // Une unité de bruit couvre largeur / fréquence cases.
    while (count < fractal.octaves && this.width / frequency >= MIN_PERIOD) {
      count++;
      frequency *= lacunarity;
    }
    return Math.max(1, count);
  }

  /**
   * Bruit fractal sur toute la grille, ligne par ligne, normalisé par la somme des
   * amplitudes : ses valeurs restent dans [-1, 1].
   */
  fractal(layer: NoiseLayer, fractal: Fractal): Float32Array {
    return this.fill(layer, fractal, (value) => value);
  }

  /**
   * Bruit de crêtes : chaque octave vaut (1 − |bruit|)², qui culmine en lignes fines là
   * où le bruit s'annule. Valeurs dans [0, 1].
   */
  ridged(layer: NoiseLayer, fractal: Fractal): Float32Array {
    return this.fill(layer, fractal, (value) => {
      const ridge = 1 - Math.abs(value);
      return ridge * ridge;
    });
  }

  /**
   * Bruit fractal d'une seule case, normalisé comme `fractal` : la même valeur, pour qui
   * n'a besoin que de quelques cases.
   */
  fractalAt(layer: NoiseLayer, fractal: Fractal, x: number, y: number): number {
    return this.at(layer, fractal, x, y, (value) => value);
  }

  /** Bruit de crêtes d'une seule case, comme `ridged`. */
  ridgedAt(layer: NoiseLayer, fractal: Fractal, x: number, y: number): number {
    return this.at(layer, fractal, x, y, (value) => {
      const ridge = 1 - Math.abs(value);
      return ridge * ridge;
    });
  }

  private at(
    layer: NoiseLayer,
    fractal: Fractal,
    x: number,
    y: number,
    shape: (value: number) => number,
  ): number {
    const lacunarity = fractal.lacunarity ?? 2;
    const gain = fractal.gain ?? 0.5;
    const octaves = this.octavesFor(fractal);
    const cosine = this.cosines[x] ?? 0;
    const sine = this.sines[x] ?? 0;
    const z = this.z(y);
    let amplitude = 1;
    let total = 0;
    let sum = 0;
    let frequency = fractal.frequency;
    for (let octave = 0; octave < octaves; octave++) {
      sum +=
        amplitude *
        shape(
          layer.simplex.noise(
            cosine * frequency + layer.offsetX + octave * 31.416,
            sine * frequency + layer.offsetY + octave * 17.711,
            z * frequency + layer.offsetZ + octave * 23.025,
          ),
        );
      total += amplitude;
      amplitude *= gain;
      frequency *= lacunarity;
    }
    return sum / total;
  }

  private fill(
    layer: NoiseLayer,
    fractal: Fractal,
    shape: (value: number) => number,
  ): Float32Array {
    const { width, height } = this;
    const lacunarity = fractal.lacunarity ?? 2;
    const gain = fractal.gain ?? 0.5;
    const octaves = this.octavesFor(fractal);
    const result = new Float32Array(width * height);
    const accumulator = new Float64Array(width * height);
    let amplitude = 1;
    let total = 0;
    let frequency = fractal.frequency;
    for (let octave = 0; octave < octaves; octave++) {
      // Chaque octave se décale un peu : leurs grilles ne coïncident jamais.
      const shiftX = layer.offsetX + octave * 31.416;
      const shiftY = layer.offsetY + octave * 17.711;
      const shiftZ = layer.offsetZ + octave * 23.025;
      for (let y = 0; y < height; y++) {
        const pz = this.z(y) * frequency + shiftZ;
        const row = y * width;
        for (let x = 0; x < width; x++) {
          const px = (this.cosines[x] ?? 0) * frequency + shiftX;
          const py = (this.sines[x] ?? 0) * frequency + shiftY;
          accumulator[row + x] =
            (accumulator[row + x] ?? 0) + amplitude * shape(layer.simplex.noise(px, py, pz));
        }
      }
      total += amplitude;
      amplitude *= gain;
      frequency *= lacunarity;
    }
    for (let index = 0; index < result.length; index++) {
      result[index] = (accumulator[index] ?? 0) / total;
    }
    return result;
  }
}
