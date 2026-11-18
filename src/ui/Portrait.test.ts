import { describe, expect, it } from 'vitest';
import { loadGameData } from '../core/data';
import { geneRoles } from '../core/data/people';
import { ageClass, greyLevel } from '../core/life';
import type { PersonView } from '../core/protocol';
import { GREY_LEVELS, ROLE } from '../core/visual';
import { PORTRAIT_SIZE, portraitRoles } from '../gen/portrait';
import { alleleColors, greyed } from '../render/atlas';
import { parseColor } from '../render/bake';
import { portraitPixels, variantOf } from './Portrait';
import type { SheetContent } from './Sheet';

const data = loadGameData();
const content: SheetContent = {
  species: data.species.entries,
  genetics: data.genetics,
  appearance: data.appearance,
};
const roles = geneRoles(data.genetics);
const human = data.species.entries[0] ?? missing();
const hairLocus = data.genetics.loci[roles.loci.hair] ?? missing();
const faceLocus = data.genetics.loci[roles.loci.face] ?? missing();

function missing(): never {
  throw new Error('donnée absente');
}

/** La fiche d'un homme de `age` ans, aux allèles `alleles` (par locus) ou aux premiers. */
function person(age: number, alleles: ReadonlyMap<string, string> = new Map()): PersonView {
  return {
    id: 1,
    name: 'Tiko',
    sex: 1,
    age,
    stage: ageClass(human, age),
    alive: true,
    birth: 0,
    species: human.id,
    culture: 1,
    ancestry: [],
    genome: [1, 2, 3, 4],
    loci: data.genetics.loci.map((locus) => ({
      locus: locus.id,
      allele: alleles.get(locus.id) ?? locus.alleles.at(0)?.id ?? '',
    })),
    traits: data.genetics.traits.map((entry) => ({ trait: entry.id, value: 0.5 })),
    height: 170,
    grey: greyLevel(human, age),
    nutrition: 1,
    pregnant: false,
    children: [],
    siblings: [],
  };
}

/** Couleur RGB du premier pixel du rôle `role` dans le portrait de `view`. */
function colorOf(view: PersonView, role: number): number[] {
  const pixels = portraitPixels(view, content) ?? missing();
  const face = faceLocus.alleles.find((allele) => allele.id === view.loci[roles.loci.face]?.allele);
  const nose = data.genetics.loci[roles.loci.nose]?.alleles.find(
    (allele) => allele.id === view.loci[roles.loci.nose]?.allele,
  );
  const map = portraitRoles({
    sex: view.sex,
    age: view.age,
    stage: view.stage,
    species: human,
    face: face?.face ?? missing(),
    nose: nose?.nose ?? missing(),
    variant: variantOf(view.genome),
  });
  const index = map.indexOf(role);
  expect(index).toBeGreaterThanOrEqual(0);
  return Array.from(pixels.subarray(index * 4, index * 4 + 3));
}

describe('portrait dans la fiche (REN-07)', () => {
  it('grisonne les cheveux au cran de son mini-sprite, à 45, 50 et 60 ans (A-10)', () => {
    const grey = parseColor(data.appearance.grey);
    const colors = alleleColors(hairLocus, grey);
    hairLocus.alleles.forEach((allele, index) => {
      for (const age of [30, 45, 50, 60, 70]) {
        const view = person(age, new Map([[hairLocus.id, allele.id]]));
        const level = greyLevel(human, age);
        expect(level).toBeLessThan(GREY_LEVELS);
        // Le gris du mini-sprite : la couleur de l'allèle, grisée du cran de son code.
        const onMap = greyed(colors[index] ?? missing(), grey, level);
        expect(colorOf(view, ROLE.hair), `${allele.id} à ${String(age)} ans`).toEqual(onMap);
      }
    });
  });

  it('se dessine de la forme de visage que porte son allèle', () => {
    const shapes = faceLocus.alleles.map((allele) =>
      Array.from(portraitPixels(person(30, new Map([[faceLocus.id, allele.id]])), content) ?? []),
    );
    for (let a = 0; a < shapes.length; a++) {
      expect(shapes[a]).toHaveLength(PORTRAIT_SIZE * PORTRAIT_SIZE * 4);
      for (let b = a + 1; b < shapes.length; b++) expect(shapes[a]).not.toEqual(shapes[b]);
    }
  });

  it('lit chaque gène par son rôle, quels que soient son nom et son rang (D-6)', () => {
    // Des allèles qui changent tout ce que le portrait montre : yeux, cheveux, visage, nez.
    const chosen = new Map(
      data.genetics.loci.map((locus) => [locus.id, locus.alleles.at(-1)?.id ?? '']),
    );
    const view = {
      ...person(50, chosen),
      traits: person(50).traits.map((entry, index) => ({
        ...entry,
        value: 0.2 + index * 0.1,
      })),
    };
    const expected = Array.from(portraitPixels(view, content) ?? missing());
    // Les locus et les traits renommés, et rangés à l'envers : la fiche les nomme de même.
    const rename = (id: string) => `${id}-x`;
    const genetics = {
      ...data.genetics,
      loci: [...data.genetics.loci].reverse().map((locus) => ({ ...locus, id: rename(locus.id) })),
      traits: [...data.genetics.traits]
        .reverse()
        .map((entry) => ({ ...entry, id: rename(entry.id) })),
    };
    const renamed: PersonView = {
      ...view,
      loci: view.loci.map((entry) => ({ ...entry, locus: rename(entry.locus) })).reverse(),
      traits: view.traits.map((entry) => ({ ...entry, trait: rename(entry.trait) })).reverse(),
    };
    expect(Array.from(portraitPixels(renamed, { ...content, genetics }) ?? [])).toEqual(expected);
  });

  it('ne dessine rien d’un individu que les données ne décrivent pas', () => {
    expect(portraitPixels({ ...person(30), species: 'dragon' }, content)).toBeUndefined();
    const unknown = person(30, new Map([[faceLocus.id, 'heart']]));
    expect(portraitPixels(unknown, content)).toBeUndefined();
  });
});
