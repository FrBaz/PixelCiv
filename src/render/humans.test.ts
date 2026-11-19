import { describe, expect, it } from 'vitest';
import { loadGameData } from '../core/data';
import { BODY_KINDS, LOOK_BITS } from '../core/data/humans';
import { geneRoles } from '../core/data/people';
import { AGE_CODE, GREY_LEVELS } from '../core/visual';
import { KEPT, RECOLOR, roleParts } from '../gen/humans';
import {
  ANIMATION,
  animationFrame,
  animationOf,
  ATLAS_ROLES,
  BODY_FEMALE,
  BODY_MALE,
  bodyKind,
  bodyOf,
  cadenceFrame,
  firstMotif,
  humanAtlas,
  humanPalette,
  LEVEL_ROWS,
  lookCode,
  lookParts,
  MOTIF_COUNT,
  recolorHuman,
  variantOf,
  type HumanLook,
} from './humans';
import { cultureOutfit, fabricTones, hairTones, skinPaletteOf } from './looks';

const data = loadGameData();
const { appearance } = data;
const hairIds = (data.genetics.loci[geneRoles(data.genetics).loci.hair]?.alleles ?? []).map(
  (allele) => allele.id,
);
const atlas = humanAtlas;
const hex = (color: readonly number[] | undefined) =>
  color === undefined
    ? undefined
    : `#${color.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** Empreinte FNV-1a de 32 bits. */
function fnv(bytes: Iterable<number>, hash = 0x811c9dc5): number {
  for (const byte of bytes) hash = Math.imul(hash ^ (byte & 255), 0x01000193) >>> 0;
  return hash;
}

/** Motifs de l'atlas d'une sorte de corps et d'un niveau. */
function motifsOf(kind: (typeof BODY_KINDS)[number], level: number): number[] {
  const out: number[] = [];
  atlas.bodies.forEach((_, body) => {
    if (bodyKind(body) !== kind) return;
    for (let variant = 0; variant < 3; variant++) {
      atlas.animations.forEach((animation, a) => {
        const first = firstMotif(body, level, variant, a);
        if (first >= 0) for (let f = 0; f < animation.frames; f++) out.push(first + f);
      });
    }
  });
  return out;
}

describe('palettes des humains (ADR 0016, § 3)', () => {
  it('range l’apparence sur les bits que bornent les données, sans perte', () => {
    expect(appearance.skinPalettes.length).toBeLessThanOrEqual(2 ** LOOK_BITS.skin);
    expect(appearance.outfits.length).toBeLessThanOrEqual(2 ** LOOK_BITS.outfit);
    expect(hairIds.length).toBeLessThanOrEqual(2 ** LOOK_BITS.hair);
    expect(GREY_LEVELS).toBe(2 ** LOOK_BITS.grey);
    for (const look of [
      { skin: 0, hair: 0, grey: 0, outfit: 0, body: 'female' },
      { skin: 7, hair: 15, grey: 3, outfit: 15, body: 'baby' },
      { skin: 5, hair: 2, grey: 1, outfit: 7, body: 'child' },
    ] satisfies HumanLook[]) {
      expect(lookParts(lookCode(look))).toEqual(look);
    }
    expect(lookCode({ skin: 7, hair: 15, grey: 3, outfit: 15, body: 'baby' })).toBeLessThan(
      2 ** 15,
    );
  });

  it('ne donne à chaque rôle de l’atlas qu’une couleur des planches ou des données, de son rang', () => {
    // Les tons permis, par rang : les palettes de peau, les tissus, les cheveux et leurs gris.
    const ramps = [
      ...appearance.skinPalettes.map((palette) => palette.tones),
      ...appearance.fabrics.map((fabric) => fabric.tones),
      ...Object.values(appearance.hair).map(([a, b, c]) => [a, b, c, c]),
      ...Object.values(appearance.greyRamps).map(([a, b, c]) => [a, b, c, c]),
    ];
    const allowed = [0, 1, 2, 3].map((rank) => new Set(ramps.map((ramp) => ramp[rank])));
    // Les rôles que montrent les motifs de chaque sorte de corps, à tous les niveaux.
    const rolesOf = (kind: (typeof BODY_KINDS)[number]) => {
      const found = new Set<number>();
      LEVEL_ROWS.forEach((_, level) => {
        for (const motif of motifsOf(kind, level)) {
          const [x = 0, y = 0, width = 1, height = 1] = atlas.motifs.slice(
            motif * 6,
            motif * 6 + 4,
          );
          for (let row = 0; row < height; row++) {
            for (let column = 0; column < width; column++) {
              found.add(ATLAS_ROLES[(y + row) * atlas.width + x + column] ?? 0);
            }
          }
        }
      });
      return found;
    };
    const roleSets = Object.fromEntries(BODY_KINDS.map((kind) => [kind, rolesOf(kind)]));
    let checked = 0;
    for (let skin = 0; skin < appearance.skinPalettes.length; skin++) {
      for (let hair = 0; hair < hairIds.length; hair++) {
        for (let grey = 0; grey < GREY_LEVELS; grey++) {
          for (let outfit = 0; outfit < appearance.outfits.length; outfit++) {
            for (const body of BODY_KINDS) {
              const palette = humanPalette(appearance, hairIds, { skin, hair, grey, outfit, body });
              for (const role of roleSets[body] ?? []) {
                if (role === 0) continue;
                const color = hex(palette[role]);
                if (role < RECOLOR) {
                  expect(color).toBe(atlas.kept[role - KEPT]);
                  continue;
                }
                checked++;
                const { rank } = roleParts(role);
                if (!allowed[rank]?.has(color ?? '')) {
                  throw new Error(
                    `${String(role)} : ${String(color)} hors des tons de rang ${String(rank)}`,
                  );
                }
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100_000);
  });

  it('prend au crâne les cheveux de l’allèle, gris puis blancs aux derniers crans', () => {
    const scalp = atlas.hairRegion;
    expect(atlas.regions[scalp]).toBe('scalp');
    const role = (rank: number) => RECOLOR + scalp * 8 + rank;
    for (let hair = 0; hair < hairIds.length; hair++) {
      const tones = [0, 1, 2, 3].map((grey) =>
        humanPalette(appearance, hairIds, { skin: 2, hair, grey, outfit: 0, body: 'male' }),
      );
      const ramp = appearance.hair[hairIds[hair] ?? ''] ?? [];
      expect(hex(tones[0][role(1)])).toBe(ramp[1]);
      expect(hex(tones[0][role(3)])).toBe(ramp[2]);
      // Premier cran : la lumière et la base passent au gris, l'ombre garde la couleur.
      expect(hex(tones[1][role(1)])).toBe(appearance.greyRamps.grey[1]);
      expect(hex(tones[1][role(2)])).toBe(ramp[2]);
      expect(hex(tones[2][role(2)])).toBe(appearance.greyRamps.grey[2]);
      expect(hex(tones[3][role(0)])).toBe(appearance.greyRamps.white[0]);
      expect(hairTones(appearance, hairIds[hair] ?? '', 3)?.[1]).toBe(
        appearance.greyRamps.white[1],
      );
    }
  });

  it('remplace sur une peau le tissu qui ne s’en détache pas par son tissu de rechange', () => {
    const dark = appearance.skinPalettes.findIndex((palette) => palette.id === 'dark');
    const leather = appearance.fabrics.find((fabric) => fabric.id === 'leather');
    const spare = appearance.fabrics.find((fabric) => fabric.id === leather?.onSkin?.dark);
    expect(spare).toBeDefined();
    expect(fabricTones(appearance, 'leather', dark)).toEqual(spare?.tones);
    expect(fabricTones(appearance, 'leather', 0)).toEqual(leather?.tones);
  });

  it('garde l’empreinte des planches habillées, à chaque niveau, adultes, enfants et nourrisson', () => {
    // Une apparence par tenue : teint medium, cheveux châtains, sans gris. Toute retouche d'une
    // grille, d'une réduction, d'une tenue ou d'une palette change ces empreintes.
    const medium = appearance.skinPalettes.findIndex((palette) => palette.id === 'medium');
    const brown = hairIds.indexOf('brown');
    const prints: Record<string, string> = {};
    appearance.outfits.forEach((outfit, index) => {
      for (const body of BODY_KINDS) {
        const palette = humanPalette(appearance, hairIds, {
          skin: medium,
          hair: brown,
          grey: 0,
          outfit: index,
          body,
        });
        const levels = LEVEL_ROWS.map((_, level) => {
          let hash = 0x811c9dc5;
          for (const motif of motifsOf(body, level)) hash = fnv(recolorHuman(motif, palette), hash);
          return hash.toString(16).padStart(8, '0');
        });
        prints[`${outfit.id} ${body}`] = levels.join(' ');
      }
    });
    expect(prints).toEqual({
      'dyed baby': 'fca80118 32bc7b76 43db031a 90f28274 39866a08',
      'dyed child': '3cee4349 338d6b0f 5e54f6c2 5abdc7bc db7ce0de',
      'dyed female': '4d02a0ec 863cbb6d 61316697 c8bdc21d 6ed58190',
      'dyed male': '8872083d d1cab410 52e1c187 f852eb78 2c445422',
      'furs baby': '74758ea8 468a9989 5f181ebf d5a2e2c0 666b6514',
      'furs child': '186488e0 f09d01b1 9793dd76 f37d4e64 fa1c4776',
      'furs female': '4c635607 e789cc65 c2e0514c dbe62e5d fe4a6f2a',
      'furs male': '70cdba97 72e98e2a 3bf05d47 929374a4 41f247b8',
      'loincloth baby': '9cf06387 0daf7a7d 2f56ee62 cfce0f56 0b3345b6',
      'loincloth child': 'c942bcf1 ee57e4d1 bdebbd09 27ceda23 ddf6d540',
      'loincloth female': '78201bf8 b27c0b36 1b0c6607 37dfe47f 699845ed',
      'loincloth male': '18ea375f b0bd523c 399987d5 ead87160 4290c2f7',
      'mantle baby': '00632239 03ae3a89 b587520e 83e8aa8c a9c784e0',
      'mantle child': '0d0c834c c10bb5cb 7efc07a2 5bae49a0 6bacd751',
      'mantle female': '390ff3f3 83824c21 487e4c0b e45e777d 344c3100',
      'mantle male': '31f0b35c 4687ef01 48492b92 0edfa893 34d38043',
      'robe baby': 'b252627a e72c2e42 67f87f3e bdd17956 cce28bfa',
      'robe child': '30522177 04c7b025 495c838b 2d9e7535 9e839a8f',
      'robe female': '0fc44650 80fbd839 af40112b 795d4395 e4a0c10c',
      'robe male': 'b01e19a3 4ba62b65 6081345d 551a6bac e6527b04',
      'sash baby': '87a8aef3 5617753b a3fce2e2 dc96b0a0 784aa814',
      'sash child': 'd9450b3f 26d03bfc 2ce3ecd0 5a40c480 2fbc2f6d',
      'sash female': '2619b1e7 b90a3e0d 75294b4b ad68000f 2a001b52',
      'sash male': '75abe0c2 4900340a 81225de9 8c30f8e0 5266748b',
      'tunic baby': '2607ea21 e8909549 9e1715af 2f4a24a8 feb43bb0',
      'tunic child': 'c06e337b 956b1298 048eee37 674e7ead ee9b7a03',
      'tunic female': 'e8650d82 fe667668 7d9cc5f2 938b6185 47d2fe91',
      'tunic male': '4369aa85 8c8cd4e1 eda5b89e 37904ffb b0ccbfff',
      'wrap baby': '94d48014 8b6faddd 8e2ab025 cbe8b9fe 5fe7ff52',
      'wrap child': 'c740199f 1ffa903e 5e92202d 2574477b 802dd44a',
      'wrap female': '60ef4331 f7105fc0 fd8103fa b76e251b d4fc6f52',
      'wrap male': 'c0d08cba b3ca20fa 5d54a808 415099e7 84cb0b33',
    });
  });
});

describe('corps, variantes et animations (ADR 0016, § 5, § 6)', () => {
  it('prend le corps de son sexe pour l’adulte et l’aîné, la taille d’enfant la plus proche, le nourrisson', () => {
    expect(bodyOf(0, AGE_CODE.adult, 1)).toBe(BODY_FEMALE);
    expect(bodyOf(1, AGE_CODE.elder, 1)).toBe(BODY_MALE);
    const children = atlas.kinds.flatMap((kind, index) => (kind === 'child' ? [index] : []));
    expect(children).toHaveLength(3);
    expect(bodyOf(0, AGE_CODE.child, 0.55)).toBe(children[0]);
    expect(bodyOf(1, AGE_CODE.child, 0.9)).toBe(children[2]);
    expect(bodyKind(bodyOf(0, AGE_CODE.baby, 0.3))).toBe('baby');
  });

  it('choisit la variante d’un adulte sur sa stature, la même à tout zoom', () => {
    for (let level = 1; level < LEVEL_ROWS.length; level++) {
      expect(variantOf(BODY_MALE, level, 1)).toBe(1);
      expect(variantOf(BODY_MALE, level, 0.85)).toBe(0);
      expect(variantOf(BODY_FEMALE, level, 1.15)).toBe(2);
    }
    expect(variantOf(BODY_MALE, 0, 1.2)).toBe(0);
    const child = atlas.kinds.indexOf('child');
    expect(variantOf(child, 2, 1.2)).toBe(0);
  });

  it('tire l’image d’une animation de l’horloge de la marche : pure, déphasée, figée quand l’horloge l’est', () => {
    const walk = ANIMATION.walk ?? -1;
    const idle = ANIMATION.idle ?? -1;
    expect(animationOf(true)).toBe(walk);
    expect(animationOf(false)).toBe(idle);
    // La marche : huit images en deux pas.
    const frames = Array.from({ length: 8 }, (_, i) => animationFrame(walk, i * 105, 420, 0));
    expect(frames).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(animationFrame(walk, 840, 420, 0)).toBe(0);
    // Même horloge, même phase : même image, autant de fois qu'on la demande.
    expect(animationFrame(walk, 1234, 420, 0.3)).toBe(animationFrame(walk, 1234, 420, 0.3));
    expect(animationFrame(walk, 0, 420, 0.5)).toBe(4);
    // Le repos : une image toutes les 260 ms, quelle que soit la vitesse.
    expect(animationFrame(idle, 520, 200, 0)).toBe(animationFrame(idle, 520, 420, 0));
    // Une animation sans boucle s'arrête sur sa dernière image.
    const death = { frames: 10, frameMs: 120, loop: false };
    expect(cadenceFrame(death, 120 * 25, 420, 0)).toBe(9);
    expect(cadenceFrame(death, -50, 420, 0)).toBe(0);
  });

  it('range un motif par image, chaque animation de chaque corps à chaque niveau', () => {
    for (let body = 0; body < atlas.bodies.length; body++) {
      LEVEL_ROWS.forEach((_, level) => {
        atlas.animations.forEach((_animation, a) => {
          expect(firstMotif(body, level, 0, a)).toBeGreaterThanOrEqual(0);
        });
      });
    }
    expect(MOTIF_COUNT).toBe(atlas.motifs.length / 6);
    expect(cultureOutfit(appearance, 1)).toBe(0);
    expect(cultureOutfit(appearance, appearance.cultureOutfits.length + 1)).toBe(0);
    expect(skinPaletteOf(appearance, 15)).toBe(appearance.skinPalettes.length - 1);
  });
});
