/**
 * Portrait d'un individu dans sa fiche (tâche 2.8 ; REN-07) : les rôles de teinte du
 * générateur (src/gen/portrait.ts), recolorés selon son teint, ses yeux, ses cheveux,
 * grisonnants avec l'âge, et l'habit de sa culture, sur le fond des portraits
 * (data/appearance.json).
 *
 * Pixel art net : le portrait s'affiche à un nombre entier de pixels physiques par pixel
 * (portraitScale), dans un canevas dont chaque pixel est un pixel physique de l'écran,
 * agrandi par le code (enlarge). Il suit les changements de densité de l'écran : zoom du
 * navigateur, fenêtre passée sur un autre écran.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { PersonView } from '../core/protocol';
import { PORTRAIT_SIZE, portraitRoles } from '../gen/portrait';
import { cultureCloth, personPalette, recolorRoles, skinColor } from '../render/atlas';
import { parseColor, type Rgb } from '../render/bake';
import { enlarge, portraitScale } from './portraitCanvas';
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

/** Pixels RGBA du portrait, PORTRAIT_SIZE × PORTRAIT_SIZE, recolorés. */
function portraitPixels(person: PersonView, content: SheetContent): Uint8ClampedArray {
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
  const palette = personPalette(appearance, {
    skin: skinColor(appearance, skin),
    hair: greying(
      parseColor(color('hair') ?? appearance.grey),
      parseColor(appearance.grey),
      person.age,
    ),
    cloth: parseColor(cultureCloth(appearance.clothing, person.culture) ?? appearance.grey),
    eye: parseColor(color('eyes') ?? appearance.outline),
  });
  return recolorRoles(roles, palette);
}

/**
 * Densité de l'écran, en pixels physiques par pixel CSS, suivie dans ses changements :
 * comparée à chaque image, comme le fait le rendu de la carte (renderer.ts), car aucun
 * événement ne les signale tous.
 */
function useDensity(): number {
  const [density, setDensity] = useState(() => devicePixelRatio);
  useEffect(() => {
    let frame = 0;
    const follow = () => {
      // Une même valeur ne refait pas le rendu.
      setDensity(devicePixelRatio);
      frame = requestAnimationFrame(follow);
    };
    frame = requestAnimationFrame(follow);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);
  return density;
}

export function Portrait({ person, content }: { person: PersonView; content: SheetContent }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const density = useDensity();
  const { factor, side, css } = portraitScale(density, PORTRAIT_SIZE);
  const pixels = useMemo(() => portraitPixels(person, content), [person, content]);
  const backdrop = useMemo(() => parseColor(content.appearance.backdrop), [content]);
  // Dessiné avant l'affichage : un changement de densité redimensionne le canevas, ce qui
  // le vide, et il ne doit pas paraître vide.
  useLayoutEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (context === undefined || context === null) return;
    const image = enlarge(pixels, PORTRAIT_SIZE, factor, side, side, backdrop);
    context.putImageData(new ImageData(image, side, side), 0, 0);
  }, [pixels, backdrop, factor, side]);

  return (
    <canvas
      ref={canvas}
      class={person.alive ? 'portrait' : 'portrait portrait-dead'}
      width={side}
      height={side}
      style={{ width: `${String(css)}px`, height: `${String(css)}px` }}
      aria-hidden="true"
    />
  );
}
