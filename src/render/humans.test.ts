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
      'dyed baby': '437a9369 821abb1a f666faf7 48834772 40359abb',
      'dyed child': '352b101f 0c0804cf 77d2225e 04555e18 7c629c8a',
      'dyed female': '4d02a0ec 3c6c1fee b409fcfc 09a6b281 64f39dec',
      'dyed male': 'c98d41de 67b03f56 82f511e3 6607f6a9 57cffcaa',
      'furs baby': '4f564e11 d8db2e91 710ae304 7ddb2f14 ace92ff1',
      'furs child': '0db32c3a 2d91d038 d56ba3d6 4f1d6c10 9b04a2bc',
      'furs female': 'eb947e0f 2d47a8dc 352b01ba dee76efe 785c55dd',
      'furs male': '2a2501db c41b0022 75658641 acc1aaaa 0e75fba7',
      'loincloth baby': 'd601978b 257832a3 4706692f 1111222f 2099f656',
      'loincloth child': 'da837522 6dade5db 53b3e787 0738ef05 7b3ea449',
      'loincloth female': '354fdf23 d824f5cf 4038a468 0711433f b9f7b0b8',
      'loincloth male': 'e325b32a d2b2e06d 9ced7610 7bf548a3 6ddd9942',
      'mantle baby': 'aeaaacdc c863c191 5581ab08 b172272c 06b62da9',
      'mantle child': '5e296cbd ebcaa3b7 fa9386ab 3d28a99f 22eee9c5',
      'mantle female': '29eeb27e 8de8cd7e 67c46a15 31925d97 66751a49',
      'mantle male': '128930b1 941790e5 e6260532 da7d2471 ea847b2f',
      'robe baby': 'f9435ded 09f0704e 87eaac13 09dd7ac4 7f5f5e65',
      'robe child': 'c50498fe 84c96bef 6f30f443 da02091b d767b0d9',
      'robe female': '18137210 4cab778d 939af066 84a2fbec cb6b2e6d',
      'robe male': 'a4bf56a8 57386a12 2d240d10 973f5608 bf541dbb',
      'sash baby': 'ce1d519a f60d6a1b 191f4092 d8a99a68 195c28b5',
      'sash child': '563b3a9a 0ae69860 84e117c9 4450d7cc 13bb330d',
      'sash female': '37fe176b 78868ab0 540278fb 349efda0 277a9d8e',
      'sash male': '6ce5021e 77bcb18a 3e21a8c0 37f9efea f249fb70',
      'tunic baby': 'd689b370 aaf935f9 04cdff40 64de9319 9af80bc8',
      'tunic child': '1f2a62d8 696c0e1d 71b080b0 f60a568d 76098e5b',
      'tunic female': '618ad413 99245767 b51017d5 6563e91e 81bc2965',
      'tunic male': '9ffd5d45 a9b78ff0 1b2d98c7 764c917c f9715ece',
      'wrap baby': 'f36ce646 22d3ce7f 6b6be434 278b05a0 6aef2635',
      'wrap child': 'be20bd93 e975e6bd 37760cb8 02bb7481 daaf39fb',
      'wrap female': '5bfa57c9 1551460e 20a3f4a5 b6ed0338 32c29e30',
      'wrap male': '6b57ef21 16bada32 4a77dd80 e566d900 cd00b62e',
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
