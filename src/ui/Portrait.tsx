/**
 * Portrait d'un individu dans sa fiche (tâche 2.8 ; REN-07) : les rôles de teinte du
 * générateur (src/gen/portrait.ts), recolorés selon son teint, ses yeux, ses cheveux,
 * grisonnants avec l'âge, et l'habit de sa culture. Il s'affiche agrandi deux fois, sans
 * lissage, pour garder des pixels nets.
 */
import { useEffect, useRef } from 'preact/hooks';
import type { PersonView } from '../core/protocol';
import { PORTRAIT_SIZE, portraitRoles } from '../gen/portrait';
import { personPalette, recolorRoles, skinColor } from '../render/atlas';
import { parseColor, type Rgb } from '../render/bake';
import type { SheetContent } from './Sheet';

/** Cheveux de plus en plus gris, de 40 à 70 ans. */
function greying(hair: Rgb, grey: Rgb, age: number): Rgb {
  const t = Math.min(1, Math.max(0, (age - 40) / 30));
  return [
    Math.round(hair[0] + (grey[0] - hair[0]) * t),
    Math.round(hair[1] + (grey[1] - hair[1]) * t),
    Math.round(hair[2] + (grey[2] - hair[2]) * t),
  ];
}

/** Variante du portrait, stable pour un individu : tirée de son génome. */
function variantOf(genome: readonly number[]): number {
  let hash = 0x811c9dc5;
  for (const word of genome) hash = Math.imul(hash ^ word, 0x01000193) >>> 0;
  return hash;
}

export function Portrait({ person, content }: { person: PersonView; content: SheetContent }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (context === undefined || context === null) return;
    const allele = (locus: string) =>
      person.loci.find((entry) => entry.locus === locus)?.allele ?? '';
    const color = (locus: string) =>
      content.loci
        .find((entry) => entry.id === locus)
        ?.alleles.find((entry) => entry.id === allele(locus))?.color;
    const { appearance } = content;
    const skin = person.traits.find((entry) => entry.trait === 'skin')?.value ?? 0.5;
    const roles = portraitRoles({
      sex: person.sex,
      age: person.age,
      face: allele('face'),
      nose: allele('nose'),
      variant: variantOf(person.genome),
    });
    const clothing = appearance.clothing;
    const palette = personPalette(appearance, {
      skin: skinColor(appearance, skin),
      hair: greying(
        parseColor(color('hair') ?? appearance.grey),
        parseColor(appearance.grey),
        person.age,
      ),
      cloth: parseColor(
        clothing[(Math.max(1, person.culture) - 1) % clothing.length] ?? appearance.grey,
      ),
      eye: parseColor(color('eyes') ?? appearance.outline),
    });
    const pixels = recolorRoles(roles, palette);
    context.putImageData(new ImageData(pixels, PORTRAIT_SIZE, PORTRAIT_SIZE), 0, 0);
  }, [person, content]);
  return (
    <canvas
      ref={canvas}
      class={person.alive ? 'portrait' : 'portrait portrait-dead'}
      width={PORTRAIT_SIZE}
      height={PORTRAIT_SIZE}
      aria-hidden="true"
    />
  );
}
