/**
 * Portrait d'un individu dans sa fiche (tâche 2.8 ; REN-07) : les rôles de teinte du
 * générateur (src/gen/portrait.ts), recolorés selon son teint, ses yeux, ses cheveux,
 * grisonnants avec l'âge, et l'habit de sa culture, sur le fond des portraits
 * (data/appearance.json). Les gènes se lisent par leur rôle (data/genetics.json), et les
 * cheveux grisonnent au cran de son mini-sprite (core/life.ts).
 *
 * Pixel art net : le portrait s'affiche à un nombre entier de pixels physiques par pixel
 * (portraitScale), dans un canevas dont chaque pixel est un pixel physique de l'écran,
 * agrandi par le code (enlarge). Il suit les changements de densité de l'écran : zoom du
 * navigateur, fenêtre passée sur un autre écran.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Allele, LocusRole } from '../core/data';
import { geneRoles } from '../core/data/people';
import type { PersonView } from '../core/protocol';
import { PORTRAIT_SIZE, portraitRoles } from '../gen/portrait';
import { cultureCloth, greyed, personPalette, recolorRoles, skinColor } from '../render/atlas';
import { parseColor } from '../render/bake';
import { enlarge, portraitScale } from './portraitCanvas';
import type { SheetContent } from './Sheet';

/** Variante du portrait, stable pour un individu : tirée de son génome. */
export function variantOf(genome: readonly number[]): number {
  let hash = 0x811c9dc5;
  for (const word of genome) hash = Math.imul(hash ^ word, 0x01000193) >>> 0;
  return hash;
}

/**
 * Pixels RGBA du portrait, PORTRAIT_SIZE × PORTRAIT_SIZE, recolorés ; undefined si son
 * espèce, l'un de ses allèles dessinés ou son teint manquent aux données, ce que la
 * relecture d'une sauvegarde empêche.
 */
export function portraitPixels(
  person: PersonView,
  content: SheetContent,
): Uint8ClampedArray<ArrayBuffer> | undefined {
  const { genetics, appearance } = content;
  const roles = geneRoles(genetics);
  // L'allèle exprimé du locus qui tient chaque rôle, d'après la fiche.
  const expressed = (role: LocusRole): Allele | undefined => {
    const locus = genetics.loci.at(roles.loci[role]);
    const id = person.loci.find((entry) => entry.locus === locus?.id)?.allele;
    return locus?.alleles.find((entry) => entry.id === id);
  };
  const skinTrait = genetics.traits.at(roles.traits.skin)?.id;
  const skin = person.traits.find((entry) => entry.trait === skinTrait)?.value;
  const species = content.species.find((entry) => entry.id === person.species);
  const face = expressed('face')?.face;
  const nose = expressed('nose')?.nose;
  const hair = expressed('hair')?.color;
  const eye = expressed('eyes')?.color;
  if (species === undefined || face === undefined || nose === undefined) return undefined;
  if (hair === undefined || eye === undefined || skin === undefined) return undefined;
  const portrait = portraitRoles({
    sex: person.sex,
    age: person.age,
    stage: person.stage,
    species,
    face,
    nose,
    variant: variantOf(person.genome),
  });
  const grey = parseColor(appearance.grey);
  const palette = personPalette(appearance, {
    skin: skinColor(appearance, skin),
    hair: greyed(parseColor(hair), grey, person.grey),
    cloth: parseColor(cultureCloth(appearance.clothing, person.culture) ?? appearance.grey),
    eye: parseColor(eye),
  });
  return recolorRoles(portrait, palette);
}

/** Un portrait sans pixel : le fond seul, pour un individu que les données ne décrivent pas. */
const BLANK = new Uint8ClampedArray(PORTRAIT_SIZE * PORTRAIT_SIZE * 4);

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
    const image = enlarge(pixels ?? BLANK, PORTRAIT_SIZE, factor, side, side, backdrop);
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
