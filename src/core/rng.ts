/**
 * Générateur pseudo-aléatoire déterministe (ADR 0003).
 *
 * xoshiro128** (Blackman et Vigna) : 128 bits d'état, des opérations entières exactes
 * sur 32 bits, donc la même suite sur tous les moteurs. Le générateur se découpe en
 * flux nommés, un par système : chaque flux dérive de la graine du monde et de son
 * nom, et non de l'ordre de création des flux.
 */
import { Fingerprint } from './hash';

/** État d'un flux : quatre entiers non signés sur 32 bits. */
export type StreamState = readonly [number, number, number, number];

const TWO_POW_32 = 4294967296;
const TWO_POW_26 = 67108864;
const TWO_POW_53 = 9007199254740992;

function rotl(value: number, shift: number): number {
  return (value << shift) | (value >>> (32 - shift));
}

/**
 * splitmix32 : suite de Weyl brassée par le finaliseur de MurmurHash3. Elle étale une
 * graine de 32 bits sur les 128 bits d'état d'un flux.
 */
export function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/** État initial du flux `name` pour la graine `seed`. */
export function streamSeed(seed: string, name: string): StreamState {
  const next = splitmix32(new Fingerprint().string(seed).string(name).value());
  const state: [number, number, number, number] = [next(), next(), next(), next()];
  // L'état nul est le seul interdit : xoshiro y resterait bloqué.
  if (state.every((word) => word === 0)) state[0] = 1;
  return state;
}

/** Un flux de nombres pseudo-aléatoires. */
export class RandomStream {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(state: StreamState) {
    [this.s0, this.s1, this.s2, this.s3] = state.map((word) => word >>> 0) as [
      number,
      number,
      number,
      number,
    ];
  }

  /** Entier dans [0, 2^32). */
  nextUint32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9) >>> 0;
    const shifted = this.s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= shifted;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** Nombre dans [0, 1), sur 53 bits : tous les doubles de la forme k / 2^53. */
  nextFloat(): number {
    const high = this.nextUint32() >>> 5;
    const low = this.nextUint32() >>> 6;
    return (high * TWO_POW_26 + low) / TWO_POW_53;
  }

  /** Entier dans [0, max), sans biais ; max est un entier de 1 à 2^32. */
  nextInt(max: number): number {
    if (!Number.isInteger(max) || max < 1 || max > TWO_POW_32) {
      throw new RangeError(`borne invalide : ${max}`);
    }
    // Rejet des tirages de la dernière tranche incomplète, qui biaiserait le modulo.
    const limit = TWO_POW_32 - (TWO_POW_32 % max);
    for (;;) {
      const value = this.nextUint32();
      if (value < limit) return value % max;
    }
  }

  /** Entier dans [min, max). */
  nextRange(min: number, max: number): number {
    return min + this.nextInt(max - min);
  }

  /** Vrai avec la probabilité donnée. */
  nextBool(probability = 0.5): boolean {
    return this.nextFloat() < probability;
  }

  /** Un élément au hasard d'une liste non vide. */
  pick<T>(items: readonly T[]): T {
    const item = items[this.nextInt(items.length)];
    if (item === undefined) throw new RangeError('liste vide');
    return item;
  }

  /** Mélange une liste sur place (Fisher-Yates) et la renvoie. */
  shuffle<T>(items: T[]): T[] {
    for (let index = items.length - 1; index > 0; index--) {
      const other = this.nextInt(index + 1);
      [items[index], items[other]] = [items[other], items[index]];
    }
    return items;
  }

  /** État courant, pour la sauvegarde. */
  state(): StreamState {
    return [this.s0 >>> 0, this.s1 >>> 0, this.s2 >>> 0, this.s3 >>> 0];
  }
}

/** Générateur d'une partie : la graine du monde et ses flux nommés. */
export class Rng {
  readonly seed: string;
  private readonly streams = new Map<string, RandomStream>();

  constructor(seed: string, states: Readonly<Record<string, StreamState>> = {}) {
    this.seed = seed;
    for (const [name, state] of Object.entries(states)) {
      this.streams.set(name, new RandomStream(state));
    }
  }

  /** Le flux `name` : toujours le même objet pour un même nom. */
  stream(name: string): RandomStream {
    let stream = this.streams.get(name);
    if (stream === undefined) {
      stream = new RandomStream(streamSeed(this.seed, name));
      this.streams.set(name, stream);
    }
    return stream;
  }

  /** États des flux déjà créés, par nom trié : de quoi reprendre à l'identique. */
  states(): Record<string, StreamState> {
    const names = [...this.streams.keys()].sort();
    return Object.fromEntries(names.map((name) => [name, this.stream(name).state()]));
  }
}
