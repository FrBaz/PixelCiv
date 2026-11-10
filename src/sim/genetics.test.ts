import { describe, expect, it } from 'vitest';
import { loadGameData } from '../core/data';
import { RandomStream, streamSeed } from '../core/rng';
import {
  alleles,
  expressed,
  gaussian,
  inheritGenome,
  mixAncestry,
  pureAncestry,
  randomGenome,
  trait,
} from './genetics';
import { ANCESTRY_TOTAL, GENOME_WORDS } from './population';

const { genetics, species } = loadGameData();
const human = species.entries.at(0);
const subspecies = (id: string) => {
  const found = human?.subspecies.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`sous-espèce inconnue : ${id}`);
  return found;
};
const locus = (id: string) => genetics.loci.findIndex((entry) => entry.id === id);
const allele = (locusId: string, id: string) =>
  genetics.loci[locus(locusId)]?.alleles.findIndex((entry) => entry.id === id) ?? -1;
const traitIndex = (id: string) => genetics.traits.findIndex((entry) => entry.id === id);

function stream(name: string): RandomStream {
  return new RandomStream(streamSeed('génétique', name));
}

/** Génome d'un individu dont le locus `id` porte les allèles (mère, père) donnés. */
function genomeWith(random: RandomStream, id: string, pair: [string, string]): Uint32Array {
  const genome = new Uint32Array(GENOME_WORDS);
  randomGenome(genetics, subspecies('plains'), random, genome);
  const index = locus(id);
  const word = index >> 2;
  const shift = (index & 3) * 8;
  const byte = allele(id, pair[0]) | (allele(id, pair[1]) << 4);
  genome[word] = (((genome[word] ?? 0) & ~(0xff << shift)) | (byte << shift)) >>> 0;
  return genome;
}

describe('génétique', () => {
  it('suit les proportions de Mendel : un croisement de deux hétérozygotes donne 3 pour 1', () => {
    const random = stream('mendel');
    const mother = genomeWith(random, 'eyes', ['brown', 'blue']);
    const father = genomeWith(random, 'eyes', ['blue', 'brown']);
    const child = new Uint32Array(GENOME_WORDS);
    let blue = 0;
    const count = 20_000;
    for (let birth = 0; birth < count; birth++) {
      inheritGenome(genetics, mother, 0, father, 0, random, child);
      if (expressed(genetics, child, 0, locus('eyes')) === allele('eyes', 'blue')) blue++;
    }
    expect(blue / count).toBeGreaterThan(0.235);
    expect(blue / count).toBeLessThan(0.265);
  });

  it("n'exprime un allèle récessif que s'il est en double", () => {
    const random = stream('récessif');
    const blueEyed = genomeWith(random, 'eyes', ['blue', 'blue']);
    const carrier = genomeWith(random, 'eyes', ['blue', 'brown']);
    expect(expressed(genetics, blueEyed, 0, locus('eyes'))).toBe(allele('eyes', 'blue'));
    expect(expressed(genetics, carrier, 0, locus('eyes'))).toBe(allele('eyes', 'brown'));
    // Deux parents aux yeux bleus n'ont que des enfants aux yeux bleus, mutations à part.
    const child = new Uint32Array(GENOME_WORDS);
    let other = 0;
    for (let birth = 0; birth < 5000; birth++) {
      inheritGenome(genetics, blueEyed, 0, blueEyed, 0, random, child);
      if (expressed(genetics, child, 0, locus('eyes')) !== allele('eyes', 'blue')) other++;
    }
    expect(other / 5000).toBeLessThan(4 * genetics.mutation.allele);
  });

  it('donne aux traits continus la moyenne des parents, plus une variation', () => {
    const random = stream('polygénique');
    const nordic = new Uint32Array(GENOME_WORDS);
    const sands = new Uint32Array(GENOME_WORDS);
    randomGenome(genetics, subspecies('nordic'), random, nordic);
    randomGenome(genetics, subspecies('sands'), random, sands);
    const skin = traitIndex('skin');
    const middle = (trait(nordic, 0, skin) + trait(sands, 0, skin)) / 2;
    const child = new Uint32Array(GENOME_WORDS);
    let sum = 0;
    let squares = 0;
    const count = 10_000;
    for (let birth = 0; birth < count; birth++) {
      inheritGenome(genetics, nordic, 0, sands, 0, random, child);
      const value = trait(child, 0, skin);
      sum += value;
      squares += value * value;
    }
    const mean = sum / count;
    const sd = Math.sqrt(squares / count - mean * mean);
    expect(mean).toBeCloseTo(middle, 2);
    const variation = genetics.traits[skin]?.variation ?? 0;
    expect(sd).toBeGreaterThan(variation * 0.85);
    expect(sd).toBeLessThan(variation * 1.25);
  });

  it('fait rarement muter un allèle, au taux des données', () => {
    const random = stream('mutations');
    const parent = genomeWith(random, 'hair', ['red', 'red']);
    const child = new Uint32Array(GENOME_WORDS);
    let changed = 0;
    const count = 50_000;
    for (let birth = 0; birth < count; birth++) {
      inheritGenome(genetics, parent, 0, parent, 0, random, child);
      const pair = alleles(child, 0, locus('hair'));
      if (pair[0] !== allele('hair', 'red')) changed++;
      if (pair[1] !== allele('hair', 'red')) changed++;
    }
    // Un allèle muté sur quatre redevient roux par hasard.
    const expected = 2 * count * genetics.mutation.allele * 0.75;
    expect(changed).toBeGreaterThan(expected * 0.7);
    expect(changed).toBeLessThan(expected * 1.3);
  });

  it('tire chaque sous-espèce de son apparence (ESP-02)', () => {
    const random = stream('apparence');
    const genome = new Uint32Array(GENOME_WORDS);
    const skin = (id: string) => {
      let sum = 0;
      let blond = 0;
      for (let draw = 0; draw < 4000; draw++) {
        randomGenome(genetics, subspecies(id), random, genome);
        sum += trait(genome, 0, traitIndex('skin'));
        if (expressed(genetics, genome, 0, locus('hair')) === allele('hair', 'blond')) blond++;
      }
      return { skin: sum / 4000, blond: blond / 4000 };
    };
    const nordic = skin('nordic');
    const sands = skin('sands');
    expect(nordic.skin).toBeLessThan(0.2);
    expect(sands.skin).toBeGreaterThan(0.7);
    expect(nordic.blond).toBeGreaterThan(0.1);
    expect(sands.blond).toBe(0);
  });

  it('mêle les ascendances : un enfant de deux sous-espèces en tient moitié de chacune', () => {
    const child = new Uint8Array(4);
    mixAncestry(pureAncestry(0), 0, pureAncestry(2), 0, child);
    expect(child.reduce((sum, share) => sum + share, 0)).toBe(ANCESTRY_TOTAL);
    expect(Math.abs((child.at(0) ?? 0) - (child.at(2) ?? 0))).toBeLessThanOrEqual(1);
    const grandchild = new Uint8Array(4);
    mixAncestry(child, 0, pureAncestry(0), 0, grandchild);
    expect(grandchild[0]).toBeGreaterThan(185);
    expect(grandchild.reduce((sum, share) => sum + share, 0)).toBe(ANCESTRY_TOTAL);
  });

  it('est déterministe, et suit une loi normale', () => {
    const a = new Uint32Array(GENOME_WORDS);
    const b = new Uint32Array(GENOME_WORDS);
    randomGenome(genetics, subspecies('plains'), stream('même'), a);
    randomGenome(genetics, subspecies('plains'), stream('même'), b);
    expect(Array.from(a)).toEqual(Array.from(b));
    const random = stream('normale');
    let sum = 0;
    let squares = 0;
    for (let draw = 0; draw < 20_000; draw++) {
      const value = gaussian(random);
      sum += value;
      squares += value * value;
    }
    expect(Math.abs(sum / 20_000)).toBeLessThan(0.03);
    expect(squares / 20_000).toBeCloseTo(1, 1);
  });
});
