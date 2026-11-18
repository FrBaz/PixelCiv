/**
 * Génétique (tâche 2.2 ; IND-05, IND-06, ESP-04 ; ADR 0011).
 *
 * Le génome tient en GENOME_WORDS mots de 32 bits :
 * - mots 0 et 1 : huit locus discrets, un octet chacun ; l'allèle venu de la mère occupe
 *   les 4 bits faibles, celui du père les 4 bits forts. Le plus dominant des deux
 *   s'exprime (hérédité mendélienne) ;
 * - mots 2 et 3 : huit traits continus, un octet chacun, de 0 à 255. L'enfant reçoit la
 *   moyenne de ses parents, plus une variation (hérédité polygénique).
 *
 * De rares mutations remplacent un allèle transmis par un allèle tiré au hasard, parfois
 * le même, ou écartent un trait. Les parts d'ascendance de l'enfant sont la moyenne de
 * celles de ses parents (métissage, ESP-04). Tout aléa vient du flux qu'on leur passe.
 */
import type { Genetics, Subspecies } from '../core/data';
import { cos, log, TAU } from '../core/dmath';
import type { RandomStream } from '../core/rng';
import { ANCESTRY_SLOTS, ANCESTRY_TOTAL, GENOME_WORDS } from './population';

/** Mot et décalage, en bits, de l'octet d'un locus ou d'un trait. */
function locusPlace(locus: number): [number, number] {
  return [locus >> 2, (locus & 3) * 8];
}

function traitPlace(trait: number): [number, number] {
  return [2 + (trait >> 2), (trait & 3) * 8];
}

function readByte(genome: ArrayLike<number>, offset: number, [word, shift]: [number, number]) {
  return ((genome[offset + word] ?? 0) >>> shift) & 0xff;
}

function writeByte(
  genome: Record<number, number>,
  offset: number,
  [word, shift]: [number, number],
  value: number,
): void {
  const current = genome[offset + word] ?? 0;
  genome[offset + word] = ((current & ~(0xff << shift)) | ((value & 0xff) << shift)) >>> 0;
}

/** Allèles d'un locus : celui de la mère, puis celui du père. */
export function alleles(
  genome: ArrayLike<number>,
  offset: number,
  locus: number,
): [number, number] {
  const byte = readByte(genome, offset, locusPlace(locus));
  return [byte & 0x0f, byte >> 4];
}

/**
 * Allèle exprimé d'un locus : le plus dominant des deux ; à rang égal, celui qui vient
 * d'abord dans data/genetics.json.
 */
export function expressed(
  genetics: Genetics,
  genome: ArrayLike<number>,
  offset: number,
  locus: number,
): number {
  const [maternal, paternal] = alleles(genome, offset, locus);
  const list = genetics.loci[locus]?.alleles ?? [];
  const rank = (allele: number) => list[allele]?.dominance ?? -1;
  if (rank(maternal) !== rank(paternal))
    return rank(maternal) > rank(paternal) ? maternal : paternal;
  return Math.min(maternal, paternal);
}

/** Valeur d'un trait continu, de 0 à 1. */
export function trait(genome: ArrayLike<number>, offset: number, index: number): number {
  return readByte(genome, offset, traitPlace(index)) / 255;
}

/** Tirage d'une loi normale centrée réduite (Box et Muller). */
export function gaussian(random: RandomStream): number {
  const u = 1 - random.nextFloat();
  return Math.sqrt(-2 * log(u)) * cos(TAU * random.nextFloat());
}

/** Indice tiré selon des poids positifs, dans l'ordre de la liste. */
function weighted(weights: readonly number[], random: RandomStream): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let target = random.nextFloat() * total;
  for (let index = 0; index < weights.length; index++) {
    target -= weights[index] ?? 0;
    if (target < 0) return index;
  }
  return Math.max(
    0,
    weights.findLastIndex((weight) => weight > 0),
  );
}

const toByte = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255);

/**
 * Génome tiré de l'apparence d'une sous-espèce (ESP-02) : chaque allèle selon sa
 * fréquence, chaque trait selon sa moyenne et son écart type. Écrit dans `out`, à
 * partir de `offset`.
 */
export function randomGenome(
  genetics: Genetics,
  subspecies: Subspecies,
  random: RandomStream,
  out: Record<number, number>,
  offset = 0,
): void {
  for (let word = 0; word < GENOME_WORDS; word++) out[offset + word] = 0;
  genetics.loci.forEach((locus, index) => {
    const frequencies = subspecies.appearance.alleles[locus.id] ?? {};
    const weights = locus.alleles.map((allele) => frequencies[allele.id] ?? 0);
    const maternal = weighted(weights, random);
    const paternal = weighted(weights, random);
    writeByte(out, offset, locusPlace(index), maternal | (paternal << 4));
  });
  genetics.traits.forEach((entry, index) => {
    const distribution = subspecies.appearance.traits[entry.id] ?? { mean: 0.5, sd: 0 };
    const value = distribution.mean + distribution.sd * gaussian(random);
    writeByte(out, offset, traitPlace(index), toByte(value));
  });
}

/**
 * Génome d'un enfant : pour chaque locus, un allèle de chaque parent tiré à pile ou face,
 * qui mute rarement ; pour chaque trait, la moyenne des parents plus une variation, et
 * rarement un écart.
 */
export function inheritGenome(
  genetics: Genetics,
  mother: ArrayLike<number>,
  motherOffset: number,
  father: ArrayLike<number>,
  fatherOffset: number,
  random: RandomStream,
  out: Record<number, number>,
  offset = 0,
): void {
  const { mutation } = genetics;
  const child = new Uint32Array(GENOME_WORDS);
  genetics.loci.forEach((locus, index) => {
    const transmit = (genome: ArrayLike<number>, at: number) => {
      const pair = alleles(genome, at, index);
      let allele = pair[random.nextInt(2)] ?? 0;
      if (random.nextFloat() < mutation.allele) allele = random.nextInt(locus.alleles.length);
      return allele;
    };
    const maternal = transmit(mother, motherOffset);
    const paternal = transmit(father, fatherOffset);
    writeByte(child, 0, locusPlace(index), maternal | (paternal << 4));
  });
  genetics.traits.forEach((entry, index) => {
    const mean = (trait(mother, motherOffset, index) + trait(father, fatherOffset, index)) / 2;
    let value = mean + entry.variation * gaussian(random);
    if (random.nextFloat() < mutation.trait) value += (random.nextFloat() * 2 - 1) * mutation.jump;
    writeByte(child, 0, traitPlace(index), toByte(value));
  });
  for (let word = 0; word < GENOME_WORDS; word++) out[offset + word] = child[word] ?? 0;
}

/**
 * Ascendance d'un enfant : la moyenne de celles de ses parents, ramenée à un total de
 * ANCESTRY_TOTAL par la méthode du plus fort reste. Chaque part prend la partie entière de
 * sa moyenne ; les unités qui manquent vont aux demi-parts, d'abord à la plus grande part,
 * puis, à égalité, à celle de la mère. Une trace d'une sous-espèce que l'on ne croise plus
 * finit donc par disparaître, et le métis de deux sous-espèces pures tient un peu plus de
 * sa mère, quel que soit leur ordre dans les données.
 */
export function mixAncestry(
  mother: ArrayLike<number>,
  motherOffset: number,
  father: ArrayLike<number>,
  fatherOffset: number,
  out: Record<number, number>,
  offset = 0,
): void {
  const shares: number[] = [];
  // Parts dont la moyenne tombe sur une demie.
  const halves: number[] = [];
  let total = 0;
  for (let index = 0; index < ANCESTRY_SLOTS; index++) {
    const sum = (mother[motherOffset + index] ?? 0) + (father[fatherOffset + index] ?? 0);
    const share = Math.floor(sum / 2);
    shares.push(share);
    total += share;
    if (sum % 2 === 1) halves.push(index);
  }
  const maternal = (index: number) => mother[motherOffset + index] ?? 0;
  halves.sort((a, b) => (shares[b] ?? 0) - (shares[a] ?? 0) || maternal(b) - maternal(a) || a - b);
  for (const index of halves) {
    if (total >= ANCESTRY_TOTAL) break;
    shares[index] = (shares[index] ?? 0) + 1;
    total++;
  }
  // Des parents dont les parts ne font pas le total (données abîmées) : l'écart va à la
  // plus grande part.
  if (total !== ANCESTRY_TOTAL) {
    let largest = 0;
    shares.forEach((share, index) => {
      if (share > (shares[largest] ?? 0)) largest = index;
    });
    shares[largest] = Math.max(0, (shares[largest] ?? 0) + ANCESTRY_TOTAL - total);
  }
  for (let index = 0; index < ANCESTRY_SLOTS; index++) out[offset + index] = shares[index] ?? 0;
}

/** Ascendance pure d'une sous-espèce, d'indice `subspecies` dans son espèce. */
export function pureAncestry(subspecies: number): number[] {
  return Array.from({ length: ANCESTRY_SLOTS }, (_, index) =>
    index === subspecies ? ANCESTRY_TOTAL : 0,
  );
}
