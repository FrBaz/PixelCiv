import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseRegionGrids } from '../src/gen/humans';
import { loadHumans } from './human-atlas';

// Cohérence des grilles de régions (assets/humans/regions/, ADR 0016, § 2) : d'une image à
// l'autre, un membre garde à peu près son aire. Pour chaque animation, chaque membre et chaque
// image, l'aire se compare à celle du même membre au repos (médiane des images du repos) : elle en
// reste entre la moitié et le double, à un pixel près. Une grille qui compterait le bras dans le
// torse (la marche féminine du prototype), tout le bras levé comme avant-bras (son lancer), ou
// l'avant-bras plié devant le ventre comme ventre (sa course) en sortirait. Les écarts que le
// dessin justifie sont listés ci-dessous, image par image, avec leur raison.

const root = fileURLToPath(new URL('..', import.meta.url));
const humans = loadHumans(root);
const letters = humans.regions.map((region) => region.letter).join('');
const LIMBS = ['scalp', 'upper-arm', 'forearm', 'hand', 'thigh', 'shin', 'foot'] as const;
const SLACK = 1;

const CROSSED = 'jambes croisées : la cuisse lointaine passe derrière la proche';
const OUTSTRETCHED = 'bras tendus, écartés ou levés : l’avant-bras se voit de tout son long';
const LYING_ARMS = 'couché sur ses bras, qui ne se voient plus';
const LYING_LEGS = 'couché, les jambes vues en raccourci';
const TRAIL = 'la traînée de la chute, au-dessus de la tête qui tombe, porte les cheveux';

/** Écarts justifiés : « sexe animation membre » → images, et la raison. */
const EXCEPTIONS: Record<string, { readonly frames: readonly number[]; readonly why: string }> = {
  'female walk thigh': { frames: [3], why: CROSSED },
  'female run thigh': { frames: [3, 4], why: CROSSED },
  'male run thigh': { frames: [2], why: CROSSED },
  'female run upper-arm': {
    frames: [1],
    why: 'le bras proche, lancé en arrière, ne montre que le haut du bras',
  },
  'female run forearm': {
    frames: [1, 7],
    why: 'le bras lancé devant le corps montre tout son avant-bras',
  },
  'female jump forearm': { frames: [0, 1, 2, 3], why: OUTSTRETCHED },
  'female fall forearm': { frames: [0, 1, 2, 3], why: OUTSTRETCHED },
  'male fall forearm': { frames: [0, 1, 2, 3], why: OUTSTRETCHED },
  'female throw forearm': { frames: [1, 2, 3, 4], why: OUTSTRETCHED },
  'female death scalp': { frames: [7], why: TRAIL },
  'male death scalp': { frames: [7], why: TRAIL },
  'female death upper-arm': { frames: [7, 8, 9], why: LYING_ARMS },
  'female death forearm': { frames: [8, 9], why: LYING_ARMS },
  'female death hand': { frames: [7, 8, 9], why: LYING_ARMS },
  'male death upper-arm': { frames: [7, 8, 9], why: LYING_ARMS },
  'male death forearm': { frames: [7, 8, 9], why: LYING_ARMS },
  'male death hand': { frames: [7, 8, 9], why: LYING_ARMS },
  'female death thigh': { frames: [7], why: 'la traînée de la chute recouvre les cuisses' },
  'female death shin': { frames: [7, 8, 9], why: LYING_LEGS },
  'female death foot': { frames: [7, 8, 9], why: LYING_LEGS },
  'male death shin': { frames: [7, 8, 9], why: LYING_LEGS },
  'male death foot': { frames: [7], why: LYING_LEGS },
};

function areas(sex: 'female' | 'male', animation: string): Record<string, number>[] {
  const { frames } = parseRegionGrids(
    animation,
    readFileSync(`${root}/assets/humans/regions/${sex}/${animation}.txt`, 'utf8'),
    humans.cell.width,
    humans.cell.height,
    letters,
  );
  return frames.map((grid) => {
    const count: Record<string, number> = {};
    for (const region of humans.regions) {
      count[region.id] = grid.reduce((sum, line) => sum + line.split(region.letter).length - 1, 0);
    }
    return count;
  });
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

describe('grilles de régions (ADR 0016, § 2)', () => {
  it('gardent à chaque membre son aire du repos, à chaque image de chaque animation, hors écarts justifiés', () => {
    const outside: string[] = [];
    const used = new Set<string>();
    for (const sex of ['female', 'male'] as const) {
      const idle = areas(sex, 'idle');
      for (const animation of humans.animations) {
        const frames = areas(sex, animation.id);
        for (const limb of LIMBS) {
          const reference = median(idle.map((count) => count[limb] ?? 0));
          frames.forEach((count, frame) => {
            const area = count[limb] ?? 0;
            if (area >= reference / 2 - SLACK && area <= 2 * reference + SLACK) return;
            const key = `${sex} ${animation.id} ${limb}`;
            if (Object.hasOwn(EXCEPTIONS, key) && EXCEPTIONS[key].frames.includes(frame)) {
              used.add(`${key} ${String(frame)}`);
              return;
            }
            outside.push(`${key} ${String(frame)} : ${String(area)} (repos ${String(reference)})`);
          });
        }
      }
    }
    expect(outside).toEqual([]);
    // Chaque écart déclaré sert encore : une grille corrigée ne garde pas d'excuse périmée.
    const declared = Object.entries(EXCEPTIONS).flatMap(([key, { frames }]) =>
      frames.map((frame) => `${key} ${String(frame)}`),
    );
    expect(declared.filter((entry) => !used.has(entry))).toEqual([]);
  });

  it('donnent au crâne, aux bras et aux jambes une place à chaque image debout', () => {
    for (const sex of ['female', 'male'] as const) {
      for (const animation of ['idle', 'walk', 'run', 'jump', 'fall', 'throw']) {
        areas(sex, animation).forEach((count, frame) => {
          for (const limb of ['scalp', 'face', 'hips', 'thigh', 'shin', 'foot']) {
            expect(count[limb], `${sex} ${animation} ${String(frame)} ${limb}`).toBeGreaterThan(0);
          }
          expect(count['upper-arm'] + count.forearm + count.hand).toBeGreaterThan(0);
        });
      }
    }
  });
});
