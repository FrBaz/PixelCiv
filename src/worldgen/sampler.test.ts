import { describe, expect, it } from 'vitest';
import { Fingerprint } from '../core/hash';
import { Rng } from '../core/rng';
import { CylinderSampler, NoiseLayer } from './sampler';

const FRACTAL = { frequency: 4, octaves: 6 };

function field(seed: string, width: number, ridged = false): Float32Array {
  const sampler = new CylinderSampler({ width, height: width / 2 });
  const layer = new NoiseLayer(new Rng(seed).stream('test.noise'));
  return ridged ? sampler.ridged(layer, FRACTAL) : sampler.fractal(layer, FRACTAL);
}

describe('échantillonnage sur le cylindre', () => {
  it('donne le même champ pour la même graine', () => {
    const fingerprint = new Fingerprint().typedArray(field('pixelciv', 128));
    expect(fingerprint.hex()).toBe(new Fingerprint().typedArray(field('pixelciv', 128)).hex());
    expect(new Fingerprint().typedArray(field('autre', 128)).hex()).not.toBe(fingerprint.hex());
  });

  it('reste dans [-1, 1], et dans [0, 1] pour les crêtes', () => {
    for (const value of field('plage', 128)) expect(Math.abs(value)).toBeLessThanOrEqual(1);
    for (const value of field('plage', 128, true)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('se referme sans couture : la couture sépare deux colonnes comme les autres', () => {
    for (const ridged of [false, true]) {
      const width = 256;
      const height = width / 2;
      const values = field('couture', width, ridged);
      let interior = 0;
      let seam = 0;
      for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 0; x + 1 < width; x++) {
          interior += Math.abs((values[row + x + 1] ?? 0) - (values[row + x] ?? 0));
        }
        seam += Math.abs((values[row] ?? 0) - (values[row + width - 1] ?? 0));
      }
      // Écart moyen entre deux colonnes voisines, à la couture et ailleurs.
      const ratio = seam / height / (interior / (height * (width - 1)));
      expect(ratio).toBeGreaterThan(0.75);
      expect(ratio).toBeLessThan(1.33);
    }
  });

  it('donne les mêmes formes à toutes les résolutions', () => {
    const coarse = field('formes', 128);
    const fine = field('formes', 256);
    // Moyenne des quatre cases fines de chaque case grossière, puis corrélation.
    const pairs: [number, number][] = [];
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 128; x++) {
        let sum = 0;
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ] as const) {
          sum += fine[(2 * y + dy) * 256 + 2 * x + dx] ?? 0;
        }
        pairs.push([coarse[y * 128 + x] ?? 0, sum / 4]);
      }
    }
    const mean = (index: 0 | 1) =>
      pairs.reduce((total, pair) => total + pair[index], 0) / pairs.length;
    const [ma, mb] = [mean(0), mean(1)];
    let covariance = 0;
    let va = 0;
    let vb = 0;
    for (const [a, b] of pairs) {
      covariance += (a - ma) * (b - mb);
      va += (a - ma) ** 2;
      vb += (b - mb) ** 2;
    }
    expect(covariance / Math.sqrt(va * vb)).toBeGreaterThan(0.95);
  });

  it("ne lit pas d'octave plus fine que trois cases", () => {
    const sampler = new CylinderSampler({ width: 256, height: 128 });
    // Fréquences 4, 8, 16, 32, 64 : 256 / 64 = 4 cases ; 128 donnerait 2 cases.
    expect(sampler.octavesFor({ frequency: 4, octaves: 10 })).toBe(5);
    expect(sampler.octavesFor({ frequency: 4, octaves: 3 })).toBe(3);
    expect(sampler.octavesFor({ frequency: 1000, octaves: 3 })).toBe(1);
  });
});
