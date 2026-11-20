import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FaunaFileSchema } from '../src/core/data/fauna';
import { KEPT, type RoleImage } from '../src/gen/humans';
import { DECOR_LEGEND, FAUNA_LEGEND, legendRole, legendRoles } from '../src/gen/legend';
import { humanAtlas } from '../src/render/humans';
import { decorGrids } from './decor-atlas';
import {
  buildFaunaAtlas,
  FAUNA_ANIMATIONS,
  FAUNA_EYE,
  faunaGrids,
  faunaOutline,
  MAX_FAUNA_ROWS,
} from './fauna-atlas';
import { parseRoleFrames, parseRoleGrid, ROLE_ATLAS_WIDTH } from './role-grids';

const root = new URL('..', import.meta.url).pathname;
const grids = faunaGrids(root);
const atlas = buildFaunaAtlas(root, grids);
const roles = Buffer.from(atlas.roles, 'base64');
const { species } = FaunaFileSchema.parse(
  JSON.parse(readFileSync(join(root, 'data/fauna.json'), 'utf8')),
);

/** Une grille d'animation dans la légende `name`, aux pieds en colonne `feet`. */
const frames = (name: string, images: string[][], feet = 1) =>
  [
    `# légende ${name}`,
    `# pieds ${String(feet)}`,
    ...images.flatMap((rows, index) => [`# image ${String(index)}`, ...rows]),
  ].join('\n');

/** Un motif de l'atlas : sa boîte, son point des pieds, et le rôle de ses pixels. */
function motif(index: number) {
  const [x, y, width, height, anchorX, anchorY] = atlas.motifs.slice(index * 6, index * 6 + 6) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const pixels = (u: number, v: number) => roles[(y + v) * atlas.width + x + u] ?? 0;
  return { x, y, width, height, anchorX, anchorY, pixels };
}

/** Le premier motif de (forme, jeune, animation, niveau), −1 sans motif. */
function first(form: number, young: number, animation: number, level: number): number {
  const { animations, levels } = atlas;
  return atlas.index[((form * 2 + young) * animations.length + animation) * levels + level] ?? -1;
}

/** Les grilles, celle de `name` remplacée par `text` (undefined : retirée). */
function replaced(name: string, text: string | undefined) {
  return grids.flatMap((grid) =>
    grid.name !== name ? [grid] : text === undefined ? [] : [{ name, text }],
  );
}

function textOf(name: string): string {
  return grids.find((grid) => grid.name === name)?.text ?? '';
}

describe('grilles d’animation du gibier (ADR 0018, § 7)', () => {
  it('lisent les images d’une grille, chacune de même taille, aux pieds sur la dernière rangée', () => {
    const images = parseRoleFrames(
      'essai',
      frames('fauna', [
        ['.Cc.', 'oVvo'],
        ['.Hj.', '....'],
      ]),
      FAUNA_LEGEND,
    );
    expect(images).toHaveLength(2);
    const map = legendRoles(FAUNA_LEGEND);
    const [ground, leap] = images as [RoleImage, RoleImage];
    expect([ground.width, ground.height, ground.anchorX, ground.anchorY]).toEqual([4, 2, 1, 2]);
    expect([...ground.roles]).toEqual(
      ['.', 'C', 'c', '.', 'o', 'V', 'v', 'o'].map((char) => map.get(char) ?? -1),
    );
    // Un bond quitte le sol : sa dernière rangée est vide, mais la grille a une image qui s'y pose.
    expect([...leap.roles.subarray(4)]).toEqual([0, 0, 0, 0]);
    expect(map.get('o')).toBe(KEPT);
    expect(FAUNA_EYE).toBe(map.get('E'));
    expect(legendRole(FAUNA_LEGEND, 'horn', 0)).toBe(map.get('H'));
  });

  it('refusent une grille fausse, en nommant la grille, la ligne et l’image', () => {
    const refused: [string, RegExp][] = [
      [
        ['# pieds 1', '# image 0', '.C.', 'oVo'].join('\n'),
        /^essai, ligne 3 : la légende se déclare en tête/,
      ],
      [['# pieds 1', '# rien'].join('\n'), /^essai : légende absente/],
      [
        frames('decor', [['.C.', 'oVo']]),
        /^essai, ligne 1 : légende « decor », l'atlas lit « fauna »/,
      ],
      [
        ['# légende fauna', '# pieds 1', '# image 1', '.C.', 'oVo'].join('\n'),
        /^essai, ligne 3 : image 1, la grille attend 0/,
      ],
      [
        ['# légende fauna', '# pieds 1', '.C.', '# image 0', 'oVo'].join('\n'),
        /^essai, ligne 3 : pixels hors d'une image/,
      ],
      [frames('fauna', [['.C.', 'oVoo']]), /^essai, ligne 5 : 4 pixels, la grille en a 3/],
      [
        frames('fauna', [
          ['.C.', 'oVo'],
          ['.Co.', 'oVo.'],
        ]),
        /^essai, ligne 7 : 4 pixels, la grille en a 3/,
      ],
      [
        frames('fauna', [['.C.', 'oWo']]),
        /^essai, ligne 5, colonne 2 : « W » hors de la légende fauna/,
      ],
      [
        frames('fauna', [['.C.', 'oVo'], ['oVo']]),
        /^essai, ligne 6 : image 1 de 1 rangées, la grille en a 2/,
      ],
      [
        frames('fauna', [
          ['.C.', '...'],
          ['.C.', '...'],
        ]),
        /^essai : aucune image ne se pose sur la dernière rangée/,
      ],
      [
        ['# légende fauna', '# image 0', '.C.', 'oVo'].join('\n'),
        /^essai : colonne des pieds absente/,
      ],
      [frames('fauna', [['.C.', 'oVo']], 3), /^essai : pieds en colonne 3, hors de 3/],
      [['# légende fauna', '# pieds 1'].join('\n'), /^essai : aucune image/],
    ];
    for (const [text, expected] of refused) {
      expect(() => parseRoleFrames('essai', text, FAUNA_LEGEND), text).toThrow(expected);
    }
  });

  it('ne se lisent qu’avec la légende de leur atlas : chaque atlas refuse les grilles de l’autre', () => {
    // Requis 5 de la critique : une légende par atlas. Une vraie grille du gibier, faite de
    // lettres que le décor connaît aussi (C, c, v, P, p), est refusée par l'atlas du décor, et une
    // vraie grille du décor par celui du gibier : c'est l'en-tête qui les sépare.
    const deer = textOf('deer-idle.txt');
    expect(() => parseRoleFrames('deer-idle.txt', deer, FAUNA_LEGEND)).not.toThrow();
    expect(() => parseRoleGrid('deer-idle.txt', deer, DECOR_LEGEND)).toThrow(
      /^deer-idle\.txt, ligne \d+ : légende « fauna », l'atlas lit « decor »/,
    );
    const tree = decorGrids(root).find(({ name }) => name === 'birch-0.txt');
    if (tree === undefined) throw new Error('pas de grille birch-0.txt');
    expect(() => parseRoleGrid(tree.name, tree.text, DECOR_LEGEND)).not.toThrow();
    expect(() => parseRoleFrames(tree.name, tree.text, FAUNA_LEGEND)).toThrow(
      /^birch-0\.txt, ligne \d+ : légende « decor », l'atlas lit « fauna »/,
    );
    // Et l'atlas du gibier refuse une grille du décor glissée parmi les siennes.
    expect(() => buildFaunaAtlas(root, replaced('deer-idle.txt', tree.text))).toThrow(
      /légende « decor », l'atlas lit « fauna »/,
    );
  });

  it('ont chacune leur légende, et chaque forme que nomment les données a ses quatre animations', () => {
    expect(grids).toHaveLength(atlas.forms.length * FAUNA_ANIMATIONS.length);
    for (const { name, text } of grids) {
      expect(text, name).toMatch(/^(?:#[^\n]*\n)*# légende fauna\n/u);
    }
    const named = new Set(
      species.flatMap(({ look }) =>
        look.male === undefined ? [look.form] : [look.form, look.male],
      ),
    );
    expect(new Set(atlas.forms)).toEqual(named);
    expect(() => buildFaunaAtlas(root, replaced('hare-fall.txt', undefined))).toThrow(
      /pas de grille hare-fall/,
    );
    expect(() => buildFaunaAtlas(root, [...grids, { name: 'Deer.txt', text: '' }])).toThrow(
      /Deer\.txt : nom de grille « forme-animation\.txt » attendu/,
    );
  });

  it('refusent une animation qui n’a pas, d’une forme à l’autre, le même nombre d’images', () => {
    const walk = textOf('boar-walk.txt');
    const cut = walk.slice(0, walk.lastIndexOf('# image'));
    expect(() => buildFaunaAtlas(root, replaced('boar-walk.txt', cut))).toThrow(
      /assets\/fauna\/boar-walk\.txt : 3 images, les autres formes en ont 4/,
    );
  });

  it('refusent des bois ou des défenses pour une espèce qui n’en donne pas les tons', () => {
    const hare = textOf('hare-idle.txt');
    const at = hare.indexOf('C', hare.indexOf('# image 0'));
    const horned = `${hare.slice(0, at)}H${hare.slice(at + 1)}`;
    expect(() => buildFaunaAtlas(root, replaced('hare-idle.txt', horned))).toThrow(
      /hare-idle\.txt : des bois ou des défenses, sans look\.horn pour hare/,
    );
  });
});

describe('atlas du gibier (ADR 0018, § 7)', () => {
  const { levels } = atlas;
  const count = atlas.motifs.length / 6;

  it('a la largeur de l’atlas des humains, dont il partage la texture, et ses cinq niveaux', () => {
    expect(atlas.width).toBe(ROLE_ATLAS_WIDTH);
    expect(atlas.width).toBe(humanAtlas.width);
    expect(levels).toBe(humanAtlas.levels.length);
    expect(atlas.animations).toEqual([...FAUNA_ANIMATIONS]);
    expect(atlas.forms).toEqual(['deer', 'stag', 'boar', 'hare']);
    expect(atlas.frames).toEqual([4, 4, 4, 2]);
    expect(atlas.index).toHaveLength(atlas.forms.length * 2 * FAUNA_ANIMATIONS.length * levels);
    expect(roles.length).toBe(atlas.width * atlas.height);
    expect(atlas.height).toBeLessThanOrEqual(MAX_FAUNA_ROWS);
  });

  it('range le jeune de chaque forme, sauf celui du cerf, qui ne se montre pas', () => {
    let motifs = 0;
    atlas.forms.forEach((form, f) => {
      for (const young of [0, 1]) {
        FAUNA_ANIMATIONS.forEach((_, animation) => {
          for (let level = 0; level < levels; level++) {
            const start = first(f, young, animation, level);
            if (form === 'stag' && young === 1) {
              expect(start, `${form} jeune`).toBe(-1);
              continue;
            }
            expect(start, form).toBeGreaterThanOrEqual(0);
            motifs += atlas.frames[animation] ?? 0;
          }
        });
      }
    });
    expect(motifs).toBe(count);
  });

  it('range ses motifs sans qu’ils se recouvrent, dans un atlas plein à plus de 30 %', () => {
    const boxes = Array.from({ length: count }, (_, index) => motif(index));
    let area = 0;
    for (const [index, box] of boxes.entries()) {
      area += box.width * box.height;
      expect(box.x + box.width).toBeLessThanOrEqual(atlas.width);
      expect(box.y + box.height).toBeLessThanOrEqual(atlas.height);
      for (const other of boxes.slice(index + 1)) {
        const apart =
          box.x + box.width <= other.x ||
          other.x + other.width <= box.x ||
          box.y + box.height <= other.y ||
          other.y + other.height <= box.y;
        expect(apart).toBe(true);
      }
    }
    expect(area / (atlas.width * atlas.height)).toBeGreaterThan(0.3);
  });

  it('garde la grille au premier niveau, réduit le jeune de look.young, et pose tout sur ses pieds', () => {
    atlas.forms.forEach((form, f) => {
      const entry = species.find((known) => known.look.form === form || known.look.male === form);
      if (entry === undefined) throw new Error(form);
      FAUNA_ANIMATIONS.forEach((animation, a) => {
        const source = parseRoleFrames(form, textOf(`${form}-${animation}.txt`), FAUNA_LEGEND);
        source.forEach((image, frame) => {
          // Au niveau 0, l'adulte est la grille même, pixel pour pixel.
          const box = motif(first(f, 0, a, 0) + frame);
          expect([box.width, box.height, box.anchorX, box.anchorY]).toEqual([
            image.width,
            image.height,
            image.anchorX,
            image.anchorY,
          ]);
          for (let v = 0; v < box.height; v++) {
            for (let u = 0; u < box.width; u++) {
              expect(box.pixels(u, v)).toBe(image.roles[v * image.width + u]);
            }
          }
          // Le jeune : la même image, réduite de look.young dès le premier niveau.
          const start = first(f, 1, a, 0);
          if (start < 0) return;
          const young = motif(start + frame);
          expect(young.height, `${form} jeune`).toBe(Math.ceil(image.anchorY / entry.look.young));
        });
        for (const young of [0, 1]) {
          for (let level = 0; level < levels; level++) {
            const start = first(f, young, a, level);
            if (start < 0) continue;
            // Chaque motif a ses pieds dans sa largeur, sur sa dernière rangée ; une image au
            // moins de l'animation s'y pose (le galop et les bonds la quittent).
            let grounded = false;
            for (let frame = 0; frame < (atlas.frames[a] ?? 0); frame++) {
              const box = motif(start + frame);
              expect(box.anchorX).toBeLessThan(box.width);
              expect(box.anchorY).toBe(box.height);
              for (let u = 0; u < box.width; u++) {
                if (box.pixels(u, box.height - 1) !== 0) grounded = true;
              }
            }
            expect(grounded, `${form} ${animation} niveau ${String(level)}`).toBe(true);
          }
        }
      });
    });
  });

  it('borde chaque motif d’un contour sombre, à chaque niveau, l’adulte comme le jeune', () => {
    // Relecture 2b.6, problème 4 : aux facteurs 3 et 4, et pour le jeune dès le niveau 1, le
    // gibier n'avait plus de contour. Un pixel du bord de la silhouette (un de ses quatre
    // voisins est vide) est au contour, ou à l'œil, aussi sombre, que la réduction garde.
    let checked = 0;
    atlas.forms.forEach((form, f) => {
      for (const young of [0, 1]) {
        FAUNA_ANIMATIONS.forEach((animation, a) => {
          for (let level = 0; level < levels; level++) {
            const start = first(f, young, a, level);
            if (start < 0) continue;
            for (let frame = 0; frame < (atlas.frames[a] ?? 0); frame++) {
              const box = motif(start + frame);
              const filled = (u: number, v: number) =>
                u >= 0 && v >= 0 && u < box.width && v < box.height && box.pixels(u, v) !== 0;
              let border = 0;
              let dark = 0;
              for (let v = 0; v < box.height; v++) {
                for (let u = 0; u < box.width; u++) {
                  if (!filled(u, v)) continue;
                  if (filled(u - 1, v) && filled(u + 1, v) && filled(u, v - 1) && filled(u, v + 1))
                    continue;
                  border++;
                  const role = box.pixels(u, v);
                  if (role === KEPT || role === FAUNA_EYE) dark++;
                }
              }
              const where = `${form} ${young === 1 ? 'jeune' : 'adulte'} ${animation} ${String(frame)} niveau ${String(level)}`;
              expect(dark / border, where).toBeGreaterThanOrEqual(0.85);
              checked++;
            }
          }
        });
      }
    });
    expect(checked).toBeGreaterThan(200);
  });

  it('retrace le contour de la règle des données aux niveaux réduits, et garde celui de la grille au premier', () => {
    expect(faunaOutline(1, 'silhouette')).toBe('keep');
    expect(faunaOutline(1.6, 'silhouette')).toBe('silhouette');
    expect(faunaOutline(4, 'thick')).toBe('thick');
    // La règle de data/fauna.json est celle que l'atlas applique : avec « thick », les petits
    // niveaux perdent une part de leur contour, là où la forme n'a pas trois pixels d'épaisseur.
    const fauna = JSON.parse(readFileSync(join(root, 'data/fauna.json'), 'utf8')) as {
      rules: { retrace: string };
    };
    expect(fauna.rules.retrace).toBe('silhouette');
  });

  it('garde l’œil de l’adulte d’un pixel à chaque niveau, là où sa grille le dessine', () => {
    let eyes = 0;
    atlas.forms.forEach((form, f) => {
      FAUNA_ANIMATIONS.forEach((animation, a) => {
        const source = parseRoleFrames(form, textOf(`${form}-${animation}.txt`), FAUNA_LEGEND);
        source.forEach((image, frame) => {
          if (!image.roles.includes(FAUNA_EYE)) return;
          for (let level = 0; level < levels; level++) {
            const box = motif(first(f, 0, a, level) + frame);
            let seen = 0;
            for (let v = 0; v < box.height; v++) {
              for (let u = 0; u < box.width; u++) if (box.pixels(u, v) === FAUNA_EYE) seen++;
            }
            const where = `${form} ${animation} ${String(frame)} niveau ${String(level)}`;
            if (level === 0) expect(seen, where).toBe(1);
            else expect(seen, where).toBeGreaterThan(0);
            eyes++;
          }
        });
      });
    });
    expect(eyes).toBeGreaterThan(50);
  });
});
