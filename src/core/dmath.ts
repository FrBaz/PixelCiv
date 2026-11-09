/**
 * Fonctions mathématiques déterministes (ADR 0003).
 *
 * La norme JavaScript laisse chaque moteur approcher Math.sin, Math.exp ou Math.pow à
 * sa façon. Les fonctions de ce module n'emploient que des opérations qu'IEEE 754
 * définit exactement (addition, soustraction, multiplication, division, arrondis) :
 * elles donnent les mêmes bits sur tous les moteurs. Leur précision, de l'ordre de
 * l'ulp, est mesurée par les tests.
 *
 * Les constantes découpées ci-dessous ont été recalculées en rationnels exacts.
 */

export const PI = Math.PI;
export const TAU = 2 * Math.PI;

/**
 * π/2 en trois morceaux de 33 bits, plus le reste : n × morceau reste exact pour
 * |n| < 2^20, et le reste rend la réduction juste près des zéros de sin et de cos.
 */
const PIO2_1 = 1.5707963267341256;
const PIO2_2 = 6.077100506303966e-11;
const PIO2_3 = 2.0222662487111665e-21;
const PIO2_3T = 8.4784276603689e-32;
const INV_PIO2 = 0.6366197723675814;
const PIO4 = 0.7853981633974483;
/** Au-delà de 2^20 × π/2, les produits n × morceau ne seraient plus exacts. */
const REDUCTION_LIMIT = 1647099.3291652855;

/** ln 2 en deux morceaux, le premier sur 32 bits. */
const LN2_HI = 0.6931471803691238;
const LN2_LO = 1.9082149292705877e-10;
const INV_LN2 = 1.4426950408889634;

/** c0 + z(c1 + z(c2 + …)), en partant du dernier coefficient. */
function horner(coefficients: readonly number[], z: number): number {
  let result = 0;
  for (let index = coefficients.length - 1; index >= 0; index--) {
    result = result * z + coefficients[index];
  }
  return result;
}

/** Coefficients de Taylor de sin et de cos : ±1/n!, divisions exactes au chargement. */
const SIN = [
  -1 / 6,
  1 / 120,
  -1 / 5040,
  1 / 362880,
  -1 / 39916800,
  1 / 6227020800,
  -1 / 1307674368000,
  1 / 355687428096000,
];
const COS = [
  -1 / 2,
  1 / 24,
  -1 / 720,
  1 / 40320,
  -1 / 3628800,
  1 / 479001600,
  -1 / 87178291200,
  1 / 20922789888000,
  -1 / 6402373705728000,
];

/** sin r pour |r| ≤ π/4 environ : série de Taylor jusqu'à r^17. */
function sinKernel(r: number): number {
  const z = r * r;
  return r + r * z * horner(SIN, z);
}

/** cos r pour |r| ≤ π/4 environ : série de Taylor jusqu'à r^18. */
function cosKernel(r: number): number {
  const z = r * r;
  return 1 + z * horner(COS, z);
}

/**
 * Réduit x à r = x − n π/2, avec |r| ≤ π/4 environ (méthode de Cody et Waite).
 * Au-delà de REDUCTION_LIMIT, x est d'abord ramené modulo 2π, tel que le représente
 * un double : le reste de `%` est exact, donc déterministe, mais le résultat perd
 * alors sa précision. Le jeu n'emploie pas d'angles si grands.
 */
function reduce(x: number): { readonly n: number; readonly r: number } {
  const bounded = Math.abs(x) < REDUCTION_LIMIT ? x : x % TAU;
  const n = Math.round(bounded * INV_PIO2);
  return { n, r: bounded - n * PIO2_1 - n * PIO2_2 - n * PIO2_3 - n * PIO2_3T };
}

/**
 * Sinus, à 1 ou 2 ulp près sous REDUCTION_LIMIT, zéros compris ; au-delà, toujours
 * déterministe et dans [-1, 1].
 */
export function sin(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  // Garde le signe de zéro : sin(-0) vaut -0.
  if (x === 0) return x;
  if (Math.abs(x) <= PIO4) return sinKernel(x);
  const { n, r } = reduce(x);
  switch (n & 3) {
    case 0:
      return sinKernel(r);
    case 1:
      return cosKernel(r);
    case 2:
      return -sinKernel(r);
    default:
      return -cosKernel(r);
  }
}

/** Cosinus, mêmes réduction, précision et domaine que sin. */
export function cos(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  if (Math.abs(x) <= PIO4) return cosKernel(x);
  const { n, r } = reduce(x);
  switch (n & 3) {
    case 0:
      return cosKernel(r);
    case 1:
      return -sinKernel(r);
    case 2:
      return -cosKernel(r);
    default:
      return sinKernel(r);
  }
}

const view = new DataView(new ArrayBuffer(8));

/** 2^k exactement, pour k entier dans [-1022, 1023]. */
function powerOfTwo(k: number): number {
  view.setUint32(0, (k + 1023) << 20);
  view.setUint32(4, 0);
  return view.getFloat64(0);
}

/** x × 2^k : chaque produit par une puissance de deux est exact, sauf arrondi sous-normal. */
function scale(x: number, k: number): number {
  let value = x;
  let exponent = k;
  while (exponent > 1023) {
    value *= powerOfTwo(1023);
    exponent -= 1023;
  }
  while (exponent < -1022) {
    value *= powerOfTwo(-1022);
    exponent += 1022;
  }
  return value * powerOfTwo(exponent);
}

/** Coefficients de Taylor de e^r : 1/n!, de n = 1 à 13. */
const EXP = [
  1,
  1 / 2,
  1 / 6,
  1 / 24,
  1 / 120,
  1 / 720,
  1 / 5040,
  1 / 40320,
  1 / 362880,
  1 / 3628800,
  1 / 39916800,
  1 / 479001600,
  1 / 6227020800,
];

/** Exponentielle : x = k ln 2 + r, avec |r| ≤ ln 2 / 2, puis e^r par sa série de Taylor. */
export function exp(x: number): number {
  if (Number.isNaN(x)) return NaN;
  // Au-delà, le résultat dépasse le plus grand double ou s'arrondit à zéro.
  if (x > 710) return Infinity;
  if (x < -746) return 0;
  const k = Math.round(x * INV_LN2);
  const r = x - k * LN2_HI - k * LN2_LO;
  return scale(1 + r * horner(EXP, r), k);
}

/** Série de 2 atanh(s) = s(2 + 2z/3 + 2z²/5 + …), avec z = s², jusqu'à z^11. */
const LOG = [2, 2 / 3, 2 / 5, 2 / 7, 2 / 9, 2 / 11, 2 / 13, 2 / 15, 2 / 17, 2 / 19, 2 / 21, 2 / 23];
const SMALLEST_NORMAL = 2.2250738585072014e-308;
const TWO_POW_54 = 18014398509481984;

/**
 * Logarithme népérien : x = 2^e × m, avec m dans [√2/2, √2], puis
 * ln m = 2 atanh(s), où s = (m − 1)/(m + 1), par sa série.
 */
export function log(x: number): number {
  if (Number.isNaN(x) || x < 0) return NaN;
  if (x === 0) return -Infinity;
  if (x === Infinity) return Infinity;
  let value = x;
  let exponent = 0;
  if (value < SMALLEST_NORMAL) {
    // Nombre sous-normal : on le ramène d'abord parmi les nombres normaux.
    value *= TWO_POW_54;
    exponent = -54;
  }
  view.setFloat64(0, value);
  const high = view.getUint32(0);
  exponent += ((high >>> 20) & 0x7ff) - 1023;
  view.setUint32(0, (high & 0x000fffff) | 0x3ff00000);
  let m = view.getFloat64(0);
  if (m > Math.SQRT2) {
    m /= 2;
    exponent += 1;
  }
  const f = m - 1;
  const s = f / (2 + f);
  const z = s * s;
  const series = s * horner(LOG, z);
  return exponent * LN2_HI + (exponent * LN2_LO + series);
}

function isOddInteger(value: number): boolean {
  return Number.isInteger(value) && Math.abs(value % 2) === 1;
}

/**
 * Au-delà de cet exposant entier, les produits successifs cumulent plus d'erreur que
 * exp(y ln x) : de l'ordre de n × 2^-55 contre (|y ln x| + 2) × 2^-53.
 */
const INTEGER_POWER_LIMIT = 64;

/** base^n par exponentiation rapide, pour n entier positif : exact sur les petits entiers. */
function positivePower(base: number, n: number): number {
  let result = 1;
  let factor = base;
  for (let remaining = n; remaining > 0; remaining = Math.floor(remaining / 2)) {
    if (remaining % 2 === 1) result *= factor;
    factor *= factor;
  }
  return result;
}

/**
 * base^n pour n entier, |n| ≤ INTEGER_POWER_LIMIT. Une puissance négative d'un nombre
 * plus petit que 1 passe par son inverse : les produits croissent, au lieu de perdre
 * leurs chiffres parmi les sous-normaux.
 */
function integerPower(base: number, n: number): number {
  if (n >= 0) return positivePower(base, n);
  return base < 1 ? positivePower(1 / base, -n) : 1 / positivePower(base, -n);
}

/** k si x vaut exactement 2^k, sous-normaux compris ; sinon undefined. */
function powerOfTwoExponent(x: number): number | undefined {
  view.setFloat64(0, x);
  const high = view.getUint32(0);
  const low = view.getUint32(4);
  const field = (high >>> 20) & 0x7ff;
  const mantissa = high & 0x000fffff;
  if (field !== 0) return mantissa === 0 && low === 0 ? field - 1023 : undefined;
  // Sous-normal : un seul bit de mantisse, dont la place donne l'exposant.
  const single = (bits: number) => bits !== 0 && (bits & (bits - 1)) === 0;
  if (low === 0 && single(mantissa)) return -1074 + 32 + (31 - Math.clz32(mantissa));
  if (mantissa === 0 && single(low)) return -1074 + (31 - Math.clz32(low));
  return undefined;
}

/**
 * Puissance x^y. Les cas particuliers suivent la norme ECMAScript
 * (Number::exponentiate). Une puissance entière de deux est exacte, débordement et
 * sous-normaux compris ; une puissance entière modérée passe par les produits, exacts
 * pour les petits entiers ; le reste passe par exp(y ln x), dont l'erreur relative croît
 * avec |y ln x|. Mesurée face à Math : 10^-14 en relatif par les produits, 3 × 10^-14
 * par exp(y ln x) pour un résultat entre 10^-30 et 10^30, 3 × 10^-13 près des
 * débordements, où un résultat voisin de la limite peut passer du mauvais côté.
 */
export function pow(x: number, y: number): number {
  if (Number.isNaN(y)) return NaN;
  if (y === 0) return 1;
  if (Number.isNaN(x)) return NaN;
  const magnitude = Math.abs(x);
  if (y === Infinity) return magnitude > 1 ? Infinity : magnitude === 1 ? NaN : 0;
  if (y === -Infinity) return magnitude > 1 ? 0 : magnitude === 1 ? NaN : Infinity;
  if (x === Infinity) return y > 0 ? Infinity : 0;
  if (x === -Infinity) {
    if (isOddInteger(y)) return y > 0 ? -Infinity : -0;
    return y > 0 ? Infinity : 0;
  }
  if (x === 0) {
    if (Object.is(x, -0) && isOddInteger(y)) return y > 0 ? -0 : -Infinity;
    return y > 0 ? 0 : Infinity;
  }
  if (x < 0 && !Number.isInteger(y)) return NaN;
  const twoExponent = Number.isInteger(y) ? powerOfTwoExponent(magnitude) : undefined;
  let result: number;
  if (twoExponent !== undefined) {
    // 2^(k y) : au-delà de ±1100, le résultat déborde ou s'annule sans calcul.
    const k = twoExponent * y;
    result = k > 1100 ? Infinity : k < -1100 ? 0 : scale(1, k);
  } else if (Number.isInteger(y) && Math.abs(y) <= INTEGER_POWER_LIMIT) {
    result = integerPower(magnitude, y);
    // Un produit qui s'annule a pu perdre un résultat sous-normal encore représentable.
    if (result === 0) result = exp(y * log(magnitude));
  } else {
    result = exp(y * log(magnitude));
  }
  return x < 0 && isOddInteger(y) ? -result : result;
}
