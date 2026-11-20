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
import { bannerFabric, cultureOutfit, fabricTones, hairTones, skinPaletteOf } from './looks';

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

  it('donne à la bannière d’un groupe le tissu que porte le plus grand nombre de ses membres, rechange compris', () => {
    const tunic = appearance.cultureOutfits.indexOf('tunic') + 1;
    const loincloth = appearance.cultureOutfits.indexOf('loincloth') + 1;
    // Un code de teint de chaque palette de peau : le dernier qu'elle prend.
    const skin = (id: string) =>
      appearance.skinPalettes.find((palette) => palette.id === id)?.upTo ?? -1;
    const linen = appearance.fabrics.find((fabric) => fabric.id === 'linen');
    const leather = appearance.fabrics.find((fabric) => fabric.id === 'leather');
    expect(linen?.onSkin?.light).toBeDefined();
    expect(linen?.onSkin?.xlight).toBe(linen?.onSkin?.light);
    expect(leather?.onSkin?.medium).toBeDefined();
    // Une tunique de lin portée surtout par des peaux claires : le lin y prend son rechange.
    expect(bannerFabric(appearance, tunic, [skin('light'), skin('light'), skin('medium')])).toBe(
      linen?.onSkin?.light,
    );
    // Surtout par des peaux medium : le lin reste le lin. Le pagne de cuir y prend le lin.
    const mostlyMedium = [skin('medium'), skin('light'), skin('medium')];
    expect(bannerFabric(appearance, tunic, mostlyMedium)).toBe('linen');
    expect(bannerFabric(appearance, loincloth, mostlyMedium)).toBe(leather?.onSkin?.medium);
    // Le tissu le plus porté, et non celui de la palette la plus nombreuse : deux peaux très
    // claires (marine) contre une medium et une olive (lin), le lin l'emporte.
    expect(
      bannerFabric(appearance, tunic, [
        skin('xlight'),
        skin('xlight'),
        skin('medium'),
        skin('olive'),
      ]),
    ).toBe('linen');
    // Sans membre, et à égalité, le tissu de la culture.
    expect(bannerFabric(appearance, tunic, [])).toBe('linen');
    expect(bannerFabric(appearance, tunic, [skin('light'), skin('medium')])).toBe('linen');
    // Un seul membre : le tissu de la pièce que porte la femme, sur sa peau, rechange compris.
    for (let palette = 0; palette < appearance.skinPalettes.length; palette++) {
      const code = appearance.skinPalettes[palette]?.upTo ?? 0;
      expect(skinPaletteOf(appearance, code)).toBe(palette);
      for (let culture = 1; culture <= appearance.cultureOutfits.length; culture++) {
        const piece = appearance.outfits[cultureOutfit(appearance, culture)]?.female[0];
        const worn = appearance.fabrics.find(
          (fabric) => fabric.id === bannerFabric(appearance, culture, [code]),
        );
        expect(worn?.tones).toEqual(fabricTones(appearance, piece.fabric, palette));
      }
    }
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
      'dyed baby': '4a53d36a 7ce614a0 457e3736 90f28274 39866a08',
      'dyed child': '86a23027 964dfd50 93cb077d 5abdc7bc c08bef7a',
      'dyed female': '4d02a0ec 39d8c808 05808237 7cbc0474 cac442c0',
      'dyed male': '8872083d 0ebdef69 69a8ed8f 24a2c0f4 157c1010',
      'furs baby': '968ce376 89152177 925eaa13 d5a2e2c0 666b6514',
      'furs child': 'a6092703 d8795fe3 0fcb9b7a f37d4e64 bba0eb69',
      'furs female': '4c635607 b370eaba 40cf9cda e2ae9e84 3e73408e',
      'furs male': '70cdba97 ab274e03 807a55a5 596d1288 61613cab',
      'loincloth baby': 'f26f388d bcea67cf 6a4376ea cfce0f56 0b3345b6',
      'loincloth child': 'a2442892 146ce419 210dd524 27ceda23 e36a2845',
      'loincloth female': '78201bf8 11d088a5 5413c828 841ad772 6fe97c2d',
      'loincloth male': '18ea375f b3d85d51 48ae9ee4 98cab020 aa326b27',
      'mantle baby': 'f9aea7e3 78ba4417 839eb11a 83e8aa8c a9c784e0',
      'mantle child': 'b73d419a cff7aa65 1bf62803 5bae49a0 02b7256c',
      'mantle female': '390ff3f3 8dd6ff5d cb2db1bd 9691d61c 9301b010',
      'mantle male': '31f0b35c eca7c634 34f183ed e392cf07 9b8cacec',
      'robe baby': '7fd96744 8a063534 da3ecfba bdd17956 cce28bfa',
      'robe child': 'b4c64fc8 91e233b0 eed7e180 2d9e7535 4852ae25',
      'robe female': '0fc44650 ce8b6bec 9a0cf273 31ade79c 9adf0314',
      'robe male': 'b01e19a3 8903f358 2b55c153 d4f32530 f77d22f2',
      'sash baby': '76f845dd 5c523489 f0df1bd6 dc96b0a0 784aa814',
      'sash child': '3bf2a4f0 0a9ec71c 6f4b38d9 5a40c480 717c1b29',
      'sash female': '2619b1e7 64131267 2a42e531 d25bd3ea 42ab3fba',
      'sash male': '75abe0c2 664481d3 0d9d3848 3966e890 4c0776d2',
      'tunic baby': '3a1d3f6f 8d2373e7 fe5bf02b 2f4a24a8 feb43bb0',
      'tunic child': 'b6bc16d6 39e50bb2 8dc8063a 674e7ead 0857e14b',
      'tunic female': 'e8650d82 a5c38d11 8523becd d14a011c 79c0d7b9',
      'tunic male': '4369aa85 359a5e20 8001333c 4a02d253 55f17a8d',
      'wrap baby': 'b5396886 6674f887 e1d90ee1 cbe8b9fe 5fe7ff52',
      'wrap child': 'd7b1b9a9 9c64c520 635cc94c 2574477b 5171c696',
      'wrap female': '60ef4331 aa77847f 7699a641 b329281e c8ab23ba',
      'wrap male': 'c0d08cba 0a99241f b8de2811 72fe36bb e57fe007',
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

  it('choisit la variante d’un adulte la plus proche de sa stature, au niveau de la vue', () => {
    for (let level = 1; level < LEVEL_ROWS.length; level++) {
      expect(variantOf(BODY_MALE, level, 1)).toBe(1);
      expect(variantOf(BODY_MALE, level, 0.85)).toBe(0);
      expect(variantOf(BODY_FEMALE, level, 1.15)).toBe(2);
    }
    expect(variantOf(BODY_MALE, 0, 1.2)).toBe(0);
    const child = atlas.kinds.indexOf('child');
    expect(variantOf(child, 2, 1.2)).toBe(0);
  });

  it('donne à chaque stature d’adulte l’arrondi borné de sa hauteur à chaque niveau, croissant avec elle', () => {
    // Toutes les statures d'adulte, en 1/128 de case, de 82 à 110 : à chaque niveau, la variante
    // est l'écart arrondi de sa hauteur à celle de la référence, borné aux variantes rangées, et
    // ne décroît jamais quand la stature croît. D'un niveau à l'autre, elle peut changer d'un cran
    // (92 : moyen à ×1,5, grand à ×4) : c'est l'arrondi de chaque résolution (ADR 0016, § 7).
    const reference = data.species.entries.at(0)?.display.stature;
    expect(reference).toBeDefined();
    let changes = 0;
    for (const body of [BODY_FEMALE, BODY_MALE]) {
      for (let level = 1; level < LEVEL_ROWS.length; level++) {
        const info = atlas.levels[level];
        let previous = -1;
        for (let stature = 82; stature <= 110; stature++) {
          const ratio = stature / 128 / (reference ?? 1);
          const variant = variantOf(body, level, ratio);
          const offsets = info.variants;
          const wanted = Math.round(ratio * info.rows) - info.rows;
          const bounded = Math.min(Math.max(wanted, offsets[0] ?? 0), offsets.at(-1) ?? 0);
          expect(offsets[variant], `${String(stature)}, niveau ${String(level)}`).toBe(bounded);
          expect(variant).toBeGreaterThanOrEqual(previous);
          previous = variant;
          if (level > 1 && variant !== variantOf(body, 1, ratio)) changes++;
        }
      }
    }
    // Des statures changent de variante d'un niveau à l'autre : le test les couvre.
    expect(changes).toBeGreaterThan(0);
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
