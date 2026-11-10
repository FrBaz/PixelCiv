/**
 * Bruit simplex 3D déterministe (tâche 1.1, ADR 0009).
 *
 * Algorithme de Ken Perlin, dans la forme de Stefan Gustavson (« Simplex noise
 * demystified », 2005, code du domaine public). Il n'emploie que des additions, des
 * multiplications, Math.floor et des tables d'entiers : il donne les mêmes bits sur
 * tous les moteurs. La table de permutation est tirée d'un flux du générateur, donc
 * de la graine du monde.
 *
 * Le noyau de chaque sommet s'annule à la distance √0,5 : avec 0,6, comme dans le
 * texte d'origine, la contribution d'un sommet ne s'annule pas au bord de la maille,
 * et le bruit présente de légères discontinuités.
 */
import type { RandomStream } from './rng';

/** Facteurs de déformation de la grille simpliciale en 3D. */
const F3 = 1 / 3;
const G3 = 1 / 6;

/** Rayon du noyau, au carré : la contribution d'un sommet s'annule au-delà. */
const KERNEL = 0.5;

/**
 * Facteur qui ramène le bruit dans [-1, 1]. Avec un noyau de rayon √0,5, la somme des
 * contributions ne dépasse guère 0,0130 en valeur absolue : mesuré sur deux millions de
 * points, puis par montée locale vers les extrêmes, le bruit reste sous 0,989.
 */
const SCALE = 76;

/** Les 12 gradients : milieux des arêtes d'un cube. */
const GRADIENTS = new Int8Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1,
  0, 1, -1, 0, -1, -1,
]);

/** Bruit simplex 3D, défini par sa table de permutation. */
export class Simplex3 {
  /** Permutation de 0..255, répétée deux fois pour éviter les modulos. */
  private readonly perm = new Uint8Array(512);
  /** Indice du gradient de chaque entrée de la permutation, multiplié par 3. */
  private readonly gradient = new Uint8Array(512);

  /** Tire la permutation du flux `random`. */
  constructor(random: RandomStream) {
    const values = Array.from({ length: 256 }, (_, index) => index);
    random.shuffle(values);
    for (let index = 0; index < 512; index++) {
      const value = values[index & 255] ?? 0;
      this.perm[index] = value;
      this.gradient[index] = (value % 12) * 3;
    }
  }

  /** Valeur du bruit au point (x, y, z), dans [-1, 1]. */
  noise(x: number, y: number, z: number): number {
    const perm = this.perm;
    const gradient = this.gradient;
    // Maille simpliciale du point : on déforme l'espace, puis on prend la partie entière.
    const skew = (x + y + z) * F3;
    const i = Math.floor(x + skew);
    const j = Math.floor(y + skew);
    const k = Math.floor(z + skew);
    const unskew = (i + j + k) * G3;
    const x0 = x - (i - unskew);
    const y0 = y - (j - unskew);
    const z0 = z - (k - unskew);
    // Lequel des six tétraèdres de la maille contient le point.
    let i1: number, j1: number, k1: number, i2: number, j2: number, k2: number;
    if (x0 >= y0) {
      if (y0 >= z0) {
        i1 = 1;
        j1 = 0;
        k1 = 0;
        i2 = 1;
        j2 = 1;
        k2 = 0;
      } else if (x0 >= z0) {
        i1 = 1;
        j1 = 0;
        k1 = 0;
        i2 = 1;
        j2 = 0;
        k2 = 1;
      } else {
        i1 = 0;
        j1 = 0;
        k1 = 1;
        i2 = 1;
        j2 = 0;
        k2 = 1;
      }
    } else if (y0 < z0) {
      i1 = 0;
      j1 = 0;
      k1 = 1;
      i2 = 0;
      j2 = 1;
      k2 = 1;
    } else if (x0 < z0) {
      i1 = 0;
      j1 = 1;
      k1 = 0;
      i2 = 0;
      j2 = 1;
      k2 = 1;
    } else {
      i1 = 0;
      j1 = 1;
      k1 = 0;
      i2 = 1;
      j2 = 1;
      k2 = 0;
    }
    const x1 = x0 - i1 + G3;
    const y1 = y0 - j1 + G3;
    const z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3;
    const y2 = y0 - j2 + 2 * G3;
    const z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3;
    const y3 = y0 - 1 + 3 * G3;
    const z3 = z0 - 1 + 3 * G3;
    // Gradients des quatre sommets, par la permutation.
    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;
    let total = 0;
    let t = KERNEL - x0 * x0 - y0 * y0 - z0 * z0;
    if (t > 0) {
      const g = gradient[ii + (perm[jj + (perm[kk] ?? 0)] ?? 0)] ?? 0;
      t *= t;
      total += t * t * dot(g, x0, y0, z0);
    }
    t = KERNEL - x1 * x1 - y1 * y1 - z1 * z1;
    if (t > 0) {
      const g = gradient[ii + i1 + (perm[jj + j1 + (perm[kk + k1] ?? 0)] ?? 0)] ?? 0;
      t *= t;
      total += t * t * dot(g, x1, y1, z1);
    }
    t = KERNEL - x2 * x2 - y2 * y2 - z2 * z2;
    if (t > 0) {
      const g = gradient[ii + i2 + (perm[jj + j2 + (perm[kk + k2] ?? 0)] ?? 0)] ?? 0;
      t *= t;
      total += t * t * dot(g, x2, y2, z2);
    }
    t = KERNEL - x3 * x3 - y3 * y3 - z3 * z3;
    if (t > 0) {
      const g = gradient[ii + 1 + (perm[jj + 1 + (perm[kk + 1] ?? 0)] ?? 0)] ?? 0;
      t *= t;
      total += t * t * dot(g, x3, y3, z3);
    }
    return SCALE * total;
  }
}

/** Produit scalaire du gradient d'indice `g` (déjà multiplié par 3) et de (x, y, z). */
function dot(g: number, x: number, y: number, z: number): number {
  return (GRADIENTS[g] ?? 0) * x + (GRADIENTS[g + 1] ?? 0) * y + (GRADIENTS[g + 2] ?? 0) * z;
}
