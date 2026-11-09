import { describe, expect, it } from 'vitest';
import { Fingerprint } from './hash';
import { Simplex3 } from './noise';
import { RandomStream, streamSeed } from './rng';

function simplex(seed: string): Simplex3 {
  return new Simplex3(new RandomStream(streamSeed(seed, 'noise')));
}

describe('bruit simplex 3D', () => {
  // Référence recoupée par une implémentation indépendante, en Python, de l'algorithme de
  // Gustavson : elle redonne au bit près 2 000 valeurs tirées au hasard.
  it('donne toujours les mêmes valeurs pour une même graine (empreinte de référence)', () => {
    const noise = simplex('pixelciv');
    const fingerprint = new Fingerprint();
    for (let i = 0; i < 40; i++) {
      for (let j = 0; j < 40; j++) {
        for (let k = 0; k < 4; k++) {
          fingerprint.float64(noise.noise(i * 0.173 - 3.1, j * 0.211 + 0.7, k * 0.37 - 1.9));
        }
      }
    }
    expect(fingerprint.hex()).toBe('b3a94c68');
  });

  it('change avec la graine', () => {
    const a = simplex('a');
    const b = simplex('b');
    let differences = 0;
    for (let i = 0; i < 100; i++) {
      if (a.noise(i * 0.37, i * 0.11, 0.5) !== b.noise(i * 0.37, i * 0.11, 0.5)) differences++;
    }
    expect(differences).toBeGreaterThan(90);
  });

  it('reste dans [-1, 1], centré', () => {
    const noise = simplex('plage');
    const random = new RandomStream(streamSeed('plage', 'points'));
    let sum = 0;
    let max = 0;
    const count = 200_000;
    for (let index = 0; index < count; index++) {
      const value = noise.noise(
        random.nextFloat() * 200 - 100,
        random.nextFloat() * 200 - 100,
        random.nextFloat() * 200 - 100,
      );
      sum += value;
      max = Math.max(max, Math.abs(value));
    }
    expect(max).toBeLessThan(1);
    expect(max).toBeGreaterThan(0.8);
    expect(Math.abs(sum / count)).toBeLessThan(0.01);
  });

  it('est continu : aucun saut entre deux points voisins, bords des mailles compris', () => {
    const noise = simplex('continu');
    const random = new RandomStream(streamSeed('continu', 'directions'));
    // Pente maximale du bruit : quelques unités par unité de distance.
    const slope = 12;
    const step = 1e-3;
    for (let line = 0; line < 50; line++) {
      const origin = [random.nextFloat() * 50, random.nextFloat() * 50, random.nextFloat() * 50];
      const direction = [
        random.nextFloat() - 0.5,
        random.nextFloat() - 0.5,
        random.nextFloat() - 0.5,
      ];
      const norm = Math.hypot(...direction);
      const [dx, dy, dz] = direction.map((value) => value / norm) as [number, number, number];
      const [ox, oy, oz] = origin as [number, number, number];
      let previous = noise.noise(ox, oy, oz);
      // 4 000 pas de 0,001 : la ligne traverse des dizaines de mailles.
      for (let index = 1; index <= 4000; index++) {
        const t = index * step;
        const value = noise.noise(ox + dx * t, oy + dy * t, oz + dz * t);
        expect(Math.abs(value - previous)).toBeLessThan(slope * step);
        previous = value;
      }
    }
  });
});
