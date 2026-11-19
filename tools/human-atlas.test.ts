import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
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
  it('lit les 90 images des deux planches, et ne range pour le jeu que les animations montrées', () => {
    const frames = humans.animations.reduce((sum, animation) => sum + animation.frames, 0);
    expect(frames * 2).toBe(90);
    expect(every.animations.map((animation) => animation.id)).toEqual(
      humans.animations.map((animation) => animation.id),
    );
    expect(game.animations.map((animation) => animation.id)).toEqual(['idle', 'walk']);
    // Chaque (corps adulte, niveau, variante, animation) a ses motifs, autant que d'images.
    const L = humans.levels.length;
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

  it('tient dans son budget : moins de 200 Ko de module, moins de 60 Ko compressés', () => {
    const json = JSON.stringify(game);
    expect(json.length).toBeLessThan(200_000);
    expect(gzipSync(json).length).toBeLessThan(60_000);
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

  it('pose chaque motif sur ses pieds : la ligne du bas porte des pixels, sous le point des pieds', () => {
    for (let motif = 0; motif < game.motifs.length / 6; motif++) {
      const [, , width = 1, height = 1, anchorX = 0, anchorY = 0] = game.motifs.slice(
        motif * 6,
        motif * 6 + 6,
      );
      expect(anchorY, `motif ${String(motif)}`).toBe(height);
      expect(anchorX).toBeGreaterThanOrEqual(0);
      expect(anchorX).toBeLessThanOrEqual(width);
      const roles = motifRoles(game, motif);
      expect(
        roles.subarray((height - 1) * width).some((role) => role !== 0),
        `motif ${String(motif)}`,
      ).toBe(true);
    }
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

  it('garde son empreinte : toute retouche d’une grille, d’une planche ou d’une réduction se voit en revue', () => {
    // L'atlas du jeu, et celui de toutes les animations : une retouche d'une grille que le jeu
    // ne montre pas encore (lancer, chute, mort) se voit aussi.
    const fingerprint = (atlas: typeof game) =>
      fnv([
        ...Buffer.from(atlas.roles, 'base64'),
        ...atlas.motifs.flatMap((v) => [v & 255, v >> 8]),
      ]);
    expect([fingerprint(game), fingerprint(every)]).toEqual(['221278fb', 'c20d9401']);
  });
});
