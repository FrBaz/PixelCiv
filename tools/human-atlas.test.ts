import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { shownFrames } from '../src/core/data/humans';
import { RECOLOR, roleParts } from '../src/gen/humans';
import {
  atlasModule,
  buildHumanAtlas,
  creditsMention,
  loadHumans,
  loadOutfits,
  MAX_ATLAS_SIDE,
  MAX_MOTIFS,
  uncoveredUnderwear,
} from './human-atlas';

const root = fileURLToPath(new URL('..', import.meta.url));
const humans = loadHumans(root);
const game = buildHumanAtlas(root, humans);
const every = buildHumanAtlas(root, humans, { animations: 'all' });

/** Empreinte FNV-1a de 32 bits d'une suite d'octets. */
function fnv(bytes: Iterable<number>): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ (byte & 255), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, '0');
}

/** Rôles d'un motif de l'atlas, ligne par ligne. */
function motifRoles(atlas: typeof game, motif: number): Uint8Array {
  const [x = 0, y = 0, width = 1, height = 1] = atlas.motifs.slice(motif * 6, motif * 6 + 4);
  const all = Buffer.from(atlas.roles, 'base64');
  const out = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    out.set(
      all.subarray((y + row) * atlas.width + x, (y + row) * atlas.width + x + width),
      row * width,
    );
  }
  return out;
}

describe('atlas des humains (ADR 0016, § 1, § 7)', () => {
  it('lit les 90 images des deux planches, et ne range pour le jeu que les images montrées', () => {
    const frames = humans.animations.reduce((sum, animation) => sum + animation.frames, 0);
    expect(frames * 2).toBe(90);
    expect(every.animations.map((animation) => animation.id)).toEqual(
      humans.animations.map((animation) => animation.id),
    );
    // Le jeu range les sept animations, et de la mort la seule figure à genoux (ADR 0022, § 4),
    // chaque image à son rang de la planche, que les gestes nomment ; toutes, pour les tests.
    expect(
      game.animations.map((animation) => `${animation.id} ${animation.ranks.join(',')}`),
    ).toEqual([
      'idle 0,1,2,3,4',
      'walk 0,1,2,3,4,5,6,7',
      'run 0,1,2,3,4,5,6,7',
      'jump 0,1,2,3',
      'fall 0,1,2,3',
      'throw 0,1,2,3,4,5',
      'death 2,3,4',
    ]);
    game.animations.forEach((animation, a) => {
      expect(animation.ranks).toEqual(shownFrames(humans.animations[a] ?? humans.animations[0]));
      expect(animation.frames).toBe(animation.ranks.length);
    });
    every.animations.forEach((animation, a) => {
      expect(animation.ranks).toHaveLength(humans.animations[a]?.frames ?? 0);
    });
    // Les enfants reçoivent toutes les animations ; le nourrisson, celles des gestes de la mère
    // qui le porte, sans la course, le saut ni la chute (data/humans.json, young).
    const L = humans.levels.length;
    const has = (body: number, a: number) =>
      (game.index[(body * L * 3 + 0) * game.animations.length + a] ?? -1) >= 0;
    game.bodies.forEach((name, body) => {
      const kind = game.kinds[body] ?? 'male';
      const received = game.animations.flatMap((animation, a) =>
        has(body, a) ? [animation.id] : [],
      );
      const expected =
        kind === 'baby'
          ? ['idle', 'walk', 'throw', 'death']
          : game.animations.map((animation) => animation.id);
      expect(received, name).toEqual(expected);
    });
    // Chaque (corps adulte, niveau, variante, animation) a ses motifs, autant que d'images.
    for (const atlas of [game, every]) {
      for (let body = 0; body < 2; body++) {
        humans.levels.forEach((level, l) => {
          level.variants.forEach((_, variant) => {
            atlas.animations.forEach((_animation, a) => {
              const slot = ((body * L + l) * 3 + variant) * atlas.animations.length + a;
              expect(
                atlas.index[slot],
                `${String(body)} ${String(l)} ${String(variant)}`,
              ).toBeGreaterThanOrEqual(0);
            });
          });
        });
      }
    }
    expect(game.motifs.length / 6).toBeLessThanOrEqual(MAX_MOTIFS);
    expect(game.height).toBeLessThanOrEqual(MAX_ATLAS_SIDE);
  });

  it('tient dans son budget : moins de 560 Ko de module, moins de 111 Ko compressés', () => {
    // Mesuré en 2b.8 (ADR 0022, § 4) : 1 668 motifs, 1 024 × 374 rôles, 544 Ko de module et
    // 108 Ko compressés, contre 598 motifs, 188 et 34 Ko avec le seul repos et la marche.
    const json = JSON.stringify(game);
    expect(game.motifs.length / 6).toBeLessThanOrEqual(1_700);
    expect(json.length).toBeLessThan(560_000);
    expect(gzipSync(json).length).toBeLessThan(111_000);
  });

  it('ne range, réduit ou composé, que des rôles des planches, ou le contour', () => {
    // Les rôles des images de la planche à sa taille : niveau 0, variante unique, chaque sexe.
    const L = humans.levels.length;
    const original = new Set<number>();
    for (let body = 0; body < 2; body++) {
      every.animations.forEach((animation, a) => {
        const first = every.index[(body * L * 3 + 0) * every.animations.length + a] ?? 0;
        for (let motif = first; motif < first + animation.frames; motif++) {
          for (const role of motifRoles(every, motif)) original.add(role);
        }
      });
    }
    const outline = 1;
    const foreign: string[] = [];
    for (let motif = 0; motif < every.motifs.length / 6; motif++) {
      for (const role of new Set(motifRoles(every, motif))) {
        if (role !== 0 && role !== outline && !original.has(role)) {
          foreign.push(`motif ${String(motif)}, rôle ${String(role)}`);
        }
      }
    }
    expect(foreign).toEqual([]);
    expect(original.size).toBeGreaterThan(50);
  });

  it('pose chaque motif sur ses pieds, sauf au saut, à la chute et à une foulée de la course', () => {
    // La ligne du bas porte des pixels ; elle est celle des pieds, sauf au saut, à la chute et à
    // la dernière foulée de la course de l'homme, que l'auteur a dessinés au-dessus d'elle (de 1
    // à 4 pixels de la planche) : le rendu les pose à leur point des pieds (src/render/crowd.ts,
    // personBox), et la figure quitte le sol.
    const L = humans.levels.length;
    const airborne = new Set(['jump', 'fall', 'run']);
    const lifts = new Set<number>();
    let seen = 0;
    game.bodies.forEach((_, body) => {
      for (let level = 0; level < L; level++) {
        for (let variant = 0; variant < 3; variant++) {
          game.animations.forEach((animation, a) => {
            const first =
              game.index[((body * L + level) * 3 + variant) * game.animations.length + a] ?? -1;
            for (let frame = 0; first >= 0 && frame < animation.frames; frame++) {
              const motif = first + frame;
              seen++;
              const [, , width = 1, height = 1, anchorX = 0, anchorY = 0] = game.motifs.slice(
                motif * 6,
                motif * 6 + 6,
              );
              const name = `${String(body)} ${String(level)} ${animation.id} ${String(frame)}`;
              if (airborne.has(animation.id)) {
                expect(anchorY, name).toBeGreaterThanOrEqual(height);
                expect(anchorY - height, name).toBeLessThanOrEqual(4);
                lifts.add(anchorY - height);
              } else {
                expect(anchorY, name).toBe(height);
              }
              expect(anchorX).toBeGreaterThanOrEqual(0);
              expect(anchorX).toBeLessThanOrEqual(width);
              const roles = motifRoles(game, motif);
              expect(
                roles.subarray((height - 1) * width).some((role) => role !== 0),
                name,
              ).toBe(true);
            }
          });
        }
      }
    });
    expect(seen).toBe(game.motifs.length / 6);
    // Le saut quitte bien le sol, au moins à la taille de la planche.
    expect(Math.max(...lifts)).toBeGreaterThan(0);
  });

  it('range les niveaux de l’adulte de référence, et des variantes d’une rangée de plus ou de moins', () => {
    expect(game.levels.map((level) => level.rows)).toEqual([43, 29, 22, 14, 11]);
    const heights = (level: number, variant: number) => {
      const slot = ((1 * humans.levels.length + level) * 3 + variant) * game.animations.length;
      const first = game.index[slot] ?? -1;
      return game.motifs[first * 6 + 3];
    };
    for (let level = 1; level < humans.levels.length; level++) {
      const rows = game.levels[level]?.rows ?? 0;
      expect(
        [heights(level, 0), heights(level, 1), heights(level, 2)].map((h) => h - rows),
      ).toEqual([-1, 0, 1]);
    }
  });

  it('déduit des planches les régions où chaque corps montre du sous-vêtement', () => {
    expect(game.underRegions).toEqual({
      female: ['chest', 'hips'],
      male: ['hips'],
      child: ['hips'],
      baby: ['hips'],
    });
    // Aucune région de sous-vêtement ailleurs, même aux animations que le jeu ne range pas.
    const regions = new Set<number>();
    for (let motif = 0; motif < every.motifs.length / 6; motif++) {
      for (const role of motifRoles(every, motif)) {
        if (role >= RECOLOR && roleParts(role).source === 1) regions.add(roleParts(role).region);
      }
    }
    expect([...regions].map((region) => humans.regions[region]?.id).sort()).toEqual([
      'chest',
      'hips',
    ]);
  });

  it('refuse au build un enfant ou un nourrisson qui n’est pas plus petit que l’adulte de référence', () => {
    // L'adulte de référence a 43 rangées (le tableau des niveaux) : un enfant de 60, ou de 43,
    // casserait la règle du niveau, qui tient sur lui la taille de toute la vue.
    const reference = game.levels[0]?.rows ?? 0;
    expect(reference).toBe(43);
    for (const rows of [60, reference]) {
      const child = [...humans.young.child.slice(0, -1), { rows, head: 10 }];
      expect(() => buildHumanAtlas(root, { ...humans, young: { ...humans.young, child } })).toThrow(
        /n'est pas plus petit que l'adulte de référence \(43 rangées\)/,
      );
      const baby = [{ rows, head: 8 }];
      expect(() => buildHumanAtlas(root, { ...humans, young: { ...humans.young, baby } })).toThrow(
        /n'est pas plus petit/,
      );
    }
    const child = [...humans.young.child.slice(0, -1), { rows: reference - 1, head: 10 }];
    expect(() =>
      buildHumanAtlas(root, { ...humans, young: { ...humans.young, child } }),
    ).not.toThrow();
  });

  it('refuse au build une tenue qui laisse voir le sous-vêtement, ou un pack que CREDITS.md ne cite pas', () => {
    const outfits = loadOutfits(root);
    expect(uncoveredUnderwear(game, outfits)).toEqual([]);
    const bare = outfits.map((outfit) => ({
      ...outfit,
      female: outfit.female.map((piece) => ({
        ...piece,
        regions: piece.regions.filter((r) => r !== 'chest'),
      })),
    }));
    expect(uncoveredUnderwear(game, bare)).toContain(
      'tenue tunic (female) : sous-vêtement des planches nu, région chest',
    );
    expect(creditsMention(root, humans.credit)).toBe(true);
    // Une copie du dépôt dont CREDITS.md ne cite plus le pack : le module ne se construit pas.
    const copy = mkdtempSync(join(tmpdir(), 'pixelciv-credits-'));
    try {
      for (const path of ['data', 'assets/humans', 'sprites/humans']) {
        cpSync(join(root, path), join(copy, path), { recursive: true });
      }
      const credits = readFileSync(join(root, 'CREDITS.md'), 'utf8');
      writeFileSync(join(copy, 'CREDITS.md'), credits.replaceAll(humans.credit.url, ''));
      expect(() => atlasModule(copy)).toThrow(/CREDITS\.md ne cite pas le pack/);
      writeFileSync(join(copy, 'CREDITS.md'), credits);
      expect(atlasModule(copy)).toMatch(/^export default /);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  it('donne au plus petit enfant la tête de l’adulte à la taille de la planche, comme aux autres', () => {
    // La tête de l'adulte de référence a 10 rangées : réduite d'un facteur 10/9, elle étalait les
    // yeux en blocs de 2 × 2 et posait une rangée de contour sur celle du corps (relecture 2b.5).
    expect(humans.young.child.map((size) => size.head)).toEqual([10, 10, 10]);
  });

  it('compose l’enfant à genoux plus petit que debout, dans la proportion de l’adulte', () => {
    // Un enfant se compose image par image, sa tête et son corps réduits à ses rangées ; à
    // genoux, le corps de l'adulte est plus court : réduit comme debout (youngRoles, standing),
    // l'enfant s'agenouille au lieu d'être étiré à sa hauteur debout (ADR 0022, § 4).
    const L = humans.levels.length;
    const death = game.animations.findIndex((animation) => animation.id === 'death');
    const idle = game.animations.findIndex((animation) => animation.id === 'idle');
    const tall = (body: number, level: number, a: number, frame: number) => {
      const first = game.index[(body * L + level) * 3 * game.animations.length + a] ?? -1;
      return game.motifs[(first + frame) * 6 + 5] ?? 0;
    };
    for (let level = 0; level < 3; level++) {
      const adult = tall(1, level, death, 1) / tall(1, level, idle, 0);
      game.kinds.forEach((kind, body) => {
        if (kind !== 'child') return;
        const ratio = tall(body, level, death, 1) / tall(body, level, idle, 0);
        expect(ratio, `${String(body)} ${String(level)}`).toBeLessThan(0.92);
        expect(Math.abs(ratio - adult), `${String(body)} ${String(level)}`).toBeLessThan(0.12);
      });
    }
  });

  it('garde son empreinte : toute retouche d’une grille, d’une planche ou d’une réduction se voit en revue', () => {
    // L'atlas du jeu, et celui de toutes les animations : une retouche d'une grille que le jeu
    // ne montre pas encore (lancer, chute, mort) se voit aussi.
    const fingerprint = (atlas: typeof game) =>
      fnv([
        ...Buffer.from(atlas.roles, 'base64'),
        ...atlas.motifs.flatMap((v) => [v & 255, v >> 8]),
      ]);
    expect([fingerprint(game), fingerprint(every)]).toEqual(['2c87123d', '97b920ac']);
  });
});

describe('têtes des motifs (ADR 0016, § 7)', () => {
  const L = humans.levels.length;
  const face = humans.regions.findIndex((region) => region.head === true && region.hair !== true);
  const head = new Set(
    humans.regions.flatMap((region, index) => (region.head === true ? [index] : [])),
  );
  const outlines = humans.tones.outline.map((_, index) => 1 + index);

  interface Sequence {
    readonly name: string;
    readonly body: number;
    readonly level: number;
    readonly loop: boolean;
    readonly motifs: readonly Uint8Array[];
    readonly widths: readonly number[];
  }

  /** Chaque suite de motifs d'un atlas : un corps, un niveau, une variante, une animation. */
  function sequences(atlas: typeof game): Sequence[] {
    const out: Sequence[] = [];
    atlas.bodies.forEach((bodyName, body) => {
      for (let level = 0; level < L; level++) {
        for (let variant = 0; variant < 3; variant++) {
          atlas.animations.forEach((animation, a) => {
            const slot = ((body * L + level) * 3 + variant) * atlas.animations.length + a;
            const first = atlas.index[slot] ?? -1;
            if (first < 0) return;
            const motifs: Uint8Array[] = [];
            const widths: number[] = [];
            for (let frame = 0; frame < animation.frames; frame++) {
              motifs.push(motifRoles(atlas, first + frame));
              widths.push(atlas.motifs[(first + frame) * 6 + 2] ?? 1);
            }
            const name = `${bodyName} niveau ${String(level)} variante ${String(variant)} ${animation.id}`;
            out.push({ name, body, level, loop: animation.loop, motifs, widths });
          });
        }
      }
    });
    return out;
  }
  const count = (roles: Uint8Array, keep: (role: number) => boolean) =>
    roles.reduce((sum, role) => sum + (keep(role) ? 1 : 0), 0);
  const isFace = (role: number) => role >= RECOLOR && roleParts(role).region === face;
  const isEye = (role: number) => every.eyes.includes(role);

  it('gardent un visage à chaque image debout, à chaque niveau et à chaque variante de chaque corps', () => {
    const faceless = sequences(every)
      .filter((sequence) => sequence.loop)
      .flatMap((sequence) =>
        sequence.motifs.flatMap((roles, frame) =>
          count(roles, isFace) > 0 ? [] : [`${sequence.name} ${String(frame)}`],
        ),
      );
    expect(faceless).toEqual([]);
  });

  /**
   * Le haut de la tête d'un motif, en texte : de sa première rangée opaque à celle qui suit la
   * dernière rangée des yeux, recadré sur ses colonnes opaques ; vide sans yeux.
   */
  function headTop(roles: Uint8Array, width: number): string {
    const height = roles.length / width;
    let first = -1;
    let last = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const role = roles[y * width + x] ?? 0;
        if (role !== 0 && first < 0) first = y;
        if (isEye(role)) last = y;
      }
    }
    if (first < 0 || last < 0) return '';
    let left = width;
    let right = -1;
    for (let y = first; y <= last + 1; y++) {
      for (let x = 0; x < width; x++) {
        if ((roles[y * width + x] ?? 0) === 0) continue;
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
    const rows: string[] = [];
    for (let y = first; y <= last + 1; y++) {
      rows.push(roles.subarray(y * width + left, y * width + right + 1).join(','));
    }
    return rows.join('/');
  }

  it('gardent aux adultes la même tête, du crâne à la rangée sous les yeux, tout au long d’une boucle montrée, à chaque niveau réduit', () => {
    // Aux niveaux réduits, la tête se réduit à part, sur une grille calée sous les yeux : le
    // balancement la déplace sans la changer, si bien que ni le visage ni les yeux ne clignotent.
    // Seul le menton, posé sur le cou, peut gagner ou perdre un pixel là où le contour se
    // retrace (facteurs 1,5 et 2). La tête se compare sur les boucles où rien ne passe devant
    // elle : au lancer et à la chute, une main se lève à sa hauteur ; à genoux, l'auteur la
    // dessine un peu autrement d'une image à l'autre. Partout, les yeux ne clignotent pas.
    const clear = new Set(['idle', 'walk', 'run', 'jump']);
    const adults = sequences(game).filter((sequence) => sequence.body < 2 && sequence.level > 0);
    const varying = adults.flatMap((sequence) => {
      const heads = new Set(
        sequence.motifs.map((roles, frame) => headTop(roles, sequence.widths[frame] ?? 1)),
      );
      const eyes = new Set(sequence.motifs.map((roles) => count(roles, isEye)));
      const id = sequence.name.split(' ').at(-1) ?? '';
      const head = !clear.has(id) || (heads.size === 1 && !heads.has(''));
      return head && eyes.size === 1 ? [] : [sequence.name];
    });
    expect(varying).toEqual([]);
    expect(new Set(adults.map((sequence) => sequence.name.split(' ').at(-1)))).toEqual(
      new Set(game.animations.map((animation) => animation.id)),
    );
    expect(humans.levels.map((level) => level.head)).toEqual([
      'feet',
      'eyes',
      'eyes',
      'eyes',
      'eyes',
    ]);
  });

  it('ne dessinent que des yeux d’un pixel : deux pixels d’yeux au plus, jamais l’un sur l’autre', () => {
    const wrong = sequences(every).flatMap((sequence) =>
      sequence.motifs.flatMap((roles, frame) => {
        const width = sequence.widths[frame] ?? 1;
        const stacked = roles.some(
          (role, index) => isEye(role) && isEye(roles[index + width] ?? 0),
        );
        return count(roles, isEye) <= 2 && !stacked ? [] : [`${sequence.name} ${String(frame)}`];
      }),
    );
    expect(wrong).toEqual([]);
  });

  it('ne posent jamais entre la tête et le corps une bande de contour de deux pixels d’épaisseur', () => {
    // Deux rangées de contour l'une sur l'autre, sur trois colonnes au moins, la tête au-dessus et
    // le corps au-dessous : le menton d'une tête réduite à part posé sur le contour retracé du
    // corps, comme chez le plus petit enfant de 2b.5.
    const banded = sequences(every).flatMap((sequence) =>
      sequence.motifs.flatMap((roles, frame) => {
        const width = sequence.widths[frame] ?? 1;
        const height = roles.length / width;
        const at = (x: number, y: number) =>
          x < 0 || y < 0 || x >= width || y >= height ? 0 : (roles[y * width + x] ?? 0);
        const line = (x: number, y: number) => outlines.includes(at(x, y));
        const inHead = (role: number) => role >= RECOLOR && head.has(roleParts(role).region);
        const inBody = (role: number) => role >= RECOLOR && !head.has(roleParts(role).region);
        for (let y = 1; y + 2 < height; y++) {
          let run: number[] = [];
          for (let x = 0; x <= width; x++) {
            if (x < width && line(x, y) && line(x, y + 1)) {
              run.push(x);
              continue;
            }
            const band =
              run.length >= 3 &&
              run.some((c) => inHead(at(c, y - 1))) &&
              run.some((c) => inBody(at(c, y + 2)));
            if (band) return [`${sequence.name} ${String(frame)}`];
            run = [];
          }
        }
        return [];
      }),
    );
    expect(banded).toEqual([]);
  });
});
