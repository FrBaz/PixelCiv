import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DecorSchema } from '../src/core/data/decor';
import { Fingerprint } from '../src/core/hash';
import { DECOR_LEGEND, FAUNA_LEGEND, legendRole, legendRoles, regionCode } from '../src/gen/legend';
import { KEPT, reduceRoles, roleParts } from '../src/gen/humans';
import { HumansSchema } from '../src/core/data/humans';
import { FloraLookSchema } from '../src/core/data/decor';
import { humanAtlas } from '../src/render/humans';
import {
  buildDecorAtlas,
  decorGrids,
  formsOf,
  keepSnow,
  MIN_SNOW_SHARE,
  namedForms,
  underRegions,
  whitens,
} from './decor-atlas';
import { packSkyline, parseRoleGrid, ROLE_ATLAS_WIDTH, withShadow } from './role-grids';

const root = new URL('..', import.meta.url).pathname;
const grids = decorGrids(root);
const atlas = buildDecorAtlas(root, grids);
const roles = Buffer.from(atlas.roles, 'base64');
const SHADOW = [legendRole(DECOR_LEGEND, 'shadow', 0), legendRole(DECOR_LEGEND, 'shadow', 1)];
const isShadow = (role: number) => SHADOW.includes(role);

/** Une grille de deux rangées, dans la légende `name`, aux pieds en colonne 1. */
const grid = (name: string, rows: string[], feet = 1) =>
  [`# légende ${name}`, `# pieds ${String(feet)}`, ...rows].join('\n');

/** Les rôles d'un motif de l'atlas, rangée par rangée. */
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

describe('grilles du décor (ADR 0017, § 3 et 7)', () => {
  it('lisent les rôles de la légende du décor, le contour et le point des pieds', () => {
    const image = parseRoleGrid('essai', grid('decor', ['.Ff.', 'oWwo']), DECOR_LEGEND);
    expect([image.width, image.height, image.anchorX, image.anchorY]).toEqual([4, 2, 1, 2]);
    const map = legendRoles(DECOR_LEGEND);
    expect([...image.roles]).toEqual(
      ['.', 'F', 'f', '.', 'o', 'W', 'w', 'o'].map((char) => map.get(char) ?? -1),
    );
    expect(map.get('o')).toBe(KEPT);
    expect(legendRole(DECOR_LEGEND, 'foliage', 0)).toBe(16);
    expect(legendRole(DECOR_LEGEND, 'cap', 3)).toBe(16 + 7 * 8 + 3);
  });

  it('refusent une grille fausse, en nommant la grille et la ligne', () => {
    const refused: [string, RegExp][] = [
      [['# pieds 1', '.F.', 'oWo'].join('\n'), /^essai, ligne 2 : la légende se déclare en tête/],
      [['# pieds 1', '# rien'].join('\n'), /^essai : légende absente/],
      [grid('decor', ['.F.', 'oWoo']), /^essai, ligne 4 : 4 pixels, la grille en a 3/],
      [
        grid('decor', ['.F.', 'oXo']),
        /^essai, ligne 4, colonne 2 : « X » hors de la légende decor/,
      ],
      [
        grid('decor', ['.F.', 'oWo', '...']),
        /^essai, ligne 5 : dernière rangée vide, sous les pieds/,
      ],
      [['# légende decor', '.F.', 'oWo'].join('\n'), /^essai : colonne des pieds absente/],
      [grid('decor', ['.F.', 'oWo'], 3), /^essai : pieds en colonne 3, hors de 3/],
      [grid('decor', []), /^essai : grille vide/],
    ];
    for (const [text, expected] of refused) {
      expect(() => parseRoleGrid('essai', text, DECOR_LEGEND), text).toThrow(expected);
    }
  });

  it('refusent une grille du gibier lue avec la légende du décor, même faite de lettres communes', () => {
    // Le gibier a sa légende (ADR 0018, src/gen/legend.ts) : les mêmes lettres y ont d'autres
    // sens (C, le pelage ; c'est le chaperon du décor). Les grilles d'assets/fauna/ le sont
    // aussi (tools/fauna-atlas.test.ts).
    const deer = grid('fauna', ['.Cc.', 'oVvo']);
    expect(() => parseRoleGrid('cerf-0.txt', deer, FAUNA_LEGEND)).not.toThrow();
    expect(() => parseRoleGrid('cerf-0.txt', deer, DECOR_LEGEND)).toThrow(
      /^cerf-0\.txt, ligne 1 : légende « fauna », l'atlas lit « decor »/,
    );
    expect(() =>
      parseRoleGrid('cerf-0.txt', grid('decor', ['.De.', 'oVvo']), DECOR_LEGEND),
    ).toThrow(/« D » hors de la légende decor/);
  });

  it('ont chacune leur légende et leurs pieds, et chaque forme nommée a ses variantes', () => {
    expect(grids.length).toBeGreaterThan(30);
    for (const { name, text } of grids) {
      expect(text.startsWith('# légende decor\n'), name).toBe(true);
      expect(() => parseRoleGrid(name, text, DECOR_LEGEND), name).not.toThrow();
    }
    for (const form of namedForms(root)) {
      expect(Object.hasOwn(atlas.forms, form) ? atlas.forms[form].length : 0, form).toBeGreaterThan(
        0,
      );
    }
    // Une forme sans grille, ou des variantes qui ne se suivent pas, font échouer le build.
    const withoutPalms = grids.filter(({ name }) => !name.startsWith('palm-'));
    expect(() => buildDecorAtlas(root, withoutPalms)).toThrow(/formes sans grilles .*palm/);
    const gap = grids.filter(({ name }) => name !== 'palm-1.txt');
    expect(() => buildDecorAtlas(root, gap)).toThrow(
      /palm-2\.txt : variante 2, la forme palm attend 1/,
    );
    expect(() => buildDecorAtlas(root, [{ name: 'Palm.txt', text: '' }])).toThrow(/forme-variante/);
  });

  it('demandent les formes que nomment les données, et elles seules, rochers épars compris', () => {
    // Relecture 2b.6, problèmes 8 et 22 : la forme des rochers épars vient de data/decor.json.
    const decor = DecorSchema.parse(
      JSON.parse(readFileSync(join(root, 'data/decor.json'), 'utf8')),
    );
    expect(
      formsOf([], { rocks: { tundra: { chance: 0.1, form: 'pebble' } }, deposits: {} }),
    ).toEqual(['pebble']);
    expect(formsOf([], { rocks: {}, deposits: decor.deposits })).not.toContain('pebble');
    const named = namedForms(root);
    for (const rock of Object.values(decor.rocks)) expect(named).toContain(rock.form);
    for (const deposit of Object.values(decor.deposits)) expect(named).toContain(deposit.form);
  });
});

describe('ombre portée (ADR 0017, § 4)', () => {
  it('projette chaque pixel vers le sud-ouest, sous les pieds, en damier, sans toucher le motif', () => {
    // Un poteau d'un pixel de large, de quatre de haut, pieds en (0, 4).
    const post = {
      width: 1,
      height: 4,
      roles: new Uint8Array([20, 20, 20, 20]),
      anchorX: 0,
      anchorY: 4,
    };
    const shaded = withShadow(post, 1, 0.5, [100, 101]);
    // h = 3, 2, 1, 0 : vers (−3, 5), (−2, 4), (−1, 4), (0, 3), arrondis ; le damier suit
    // l'écart au point des pieds, si bien que deux voisins diffèrent.
    expect([shaded.width, shaded.height, shaded.anchorX, shaded.anchorY]).toEqual([4, 6, 3, 4]);
    const at = (x: number, y: number) => shaded.roles[y * shaded.width + x];
    expect([at(0, 5), at(1, 4), at(2, 4)]).toEqual([101, 101, 100]);
    // Le motif garde tous ses pixels, et l'ombre ne monte pas au-dessus des pieds.
    for (let y = 0; y < 4; y++) expect(at(3, y)).toBe(20);
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) expect(at(x, y)).toBe(0);
  });
});

describe('atlas du décor (ADR 0017, § 3)', () => {
  const levels = atlas.levels;

  it('a la largeur de l’atlas des humains, dont il partage la texture, et cinq niveaux par source', () => {
    expect(atlas.width).toBe(ROLE_ATLAS_WIDTH);
    expect(atlas.width).toBe(humanAtlas.width);
    expect(levels).toBe(humanAtlas.levels.length);
    expect(atlas.motifs.length).toBe(atlas.names.length * levels * 6);
    expect(roles.length).toBe(atlas.width * atlas.height);
  });

  it('range ses motifs sans qu’ils se recouvrent, dans un atlas plein à plus de 40 %', () => {
    const count = atlas.motifs.length / 6;
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
    expect(area / (atlas.width * atlas.height)).toBeGreaterThan(0.4);
    // Le rangement en ligne d'horizon, sur des boîtes connues.
    const packed = packSkyline(
      [
        { width: 600, height: 10 },
        { width: 600, height: 8 },
        { width: 400, height: 8 },
      ],
      1024,
    );
    expect(packed.at).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 11 },
      { x: 601, y: 0 },
    ]);
    expect(packed.height).toBe(19);
  });

  it('pose chaque motif sur ses pieds, l’ombre au sol seulement, dans les régions de sa source', () => {
    atlas.names.forEach((name, source) => {
      const text = grids.find((entry) => entry.name === `${name}.txt`)?.text ?? '';
      const base = parseRoleGrid(name, text, DECOR_LEGEND);
      // La réduction par vote ne fait que des rôles des régions de sa source, à l'un de leurs
      // quatre rangs (un contour intérieur y devient l'ombre profonde), ou le contour : aucun
      // rôle sans couleur dans les palettes du décor.
      // La neige et le chaperon, que tout niveau réduit peut prendre (keepSnow), ont un ton dans
      // toute palette du décor (decorPalette).
      const regions = new Set([
        ...[...base.roles].filter((role) => role >= 16).map((role) => role >> 3),
        legendRole(DECOR_LEGEND, 'snow', 0) >> 3,
        legendRole(DECOR_LEGEND, 'cap', 0) >> 3,
      ]);
      const allowed = (role: number) => role === KEPT || regions.has(role >> 3);
      for (let level = 0; level < levels; level++) {
        const box = motif(source * levels + level);
        const where = `${name}, niveau ${String(level)}`;
        let feet = 0;
        for (let v = 0; v < box.height; v++) {
          for (let u = 0; u < box.width; u++) {
            const role = box.pixels(u, v);
            if (role === 0) continue;
            if (isShadow(role)) {
              // L'ombre ne monte pas au-dessus de la rangée des pieds.
              expect(v, where).toBeGreaterThanOrEqual(box.anchorY - 1);
              continue;
            }
            // Rien du motif sous ses pieds ; ses rôles sont ceux de sa grille, ou le contour.
            expect(v, where).toBeLessThan(box.anchorY);
            expect(allowed(role), `${where} : rôle ${String(role)}`).toBe(true);
            if (v === box.anchorY - 1) feet++;
          }
        }
        expect(feet, `${where} : pieds sur la dernière rangée`).toBeGreaterThan(0);
        expect(box.anchorX, where).toBeGreaterThanOrEqual(0);
        expect(box.anchorX, where).toBeLessThan(box.width);
      }
    });
  });

  it('borde ses motifs du contour, ou de son chaperon, au premier niveau', () => {
    // Relecture 2b.6, problème 5 : un feuillu sans contour ne tombait que par l'empreinte. Part
    // du bord de la silhouette (hors ombre portée) au contour ou au chaperon : les formes fines
    // (roseaux, branches nues) en ont moins, les autres presque tout.
    const cap = [0, 1, 2, 3].map((rank) => legendRole(DECOR_LEGEND, 'cap', rank));
    const shares = atlas.names.map((name, source) => {
      const box = motif(source * atlas.levels);
      const filled = (u: number, v: number) =>
        u >= 0 &&
        v >= 0 &&
        u < box.width &&
        v < box.height &&
        box.pixels(u, v) !== 0 &&
        !isShadow(box.pixels(u, v));
      let border = 0;
      let outlined = 0;
      for (let v = 0; v < box.height; v++) {
        for (let u = 0; u < box.width; u++) {
          if (!filled(u, v)) continue;
          if (filled(u - 1, v) && filled(u + 1, v) && filled(u, v - 1) && filled(u, v + 1))
            continue;
          border++;
          if (box.pixels(u, v) === KEPT || cap.includes(box.pixels(u, v))) outlined++;
        }
      }
      return { name, share: outlined / border };
    });
    for (const { name, share } of shares) expect(share, name).toBeGreaterThanOrEqual(0.1);
    const full = shares.filter(({ share }) => share >= 0.95).length;
    expect(full / shares.length).toBeGreaterThanOrEqual(0.6);
    for (const name of ['broadleaf-0', 'conifer-0', 'rock-0', 'berry-bush-0']) {
      expect(shares.find((entry) => entry.name === name)?.share, name).toBeGreaterThanOrEqual(0.95);
    }
  });

  it('garde à chaque niveau réduit la moitié de la neige et du chaperon de la planche, et deux pixels', () => {
    // Tâche 2b.7, constat de la publication de 2b.6 : le saule nain enneigé ne gardait au
    // facteur 2 que 6 pixels blancs sur 78, contre 75 sur 284 à la planche, et se lisait comme un
    // buisson nu sur la neige. Seules les croûtes de sel des niveaux sans contour (facteurs 3 et
    // 4), tout de minerai, n'ont aucun pixel qui blanchirait sans changer hors neige.
    const share = (box: ReturnType<typeof motif>) => {
      let opaque = 0;
      let white = 0;
      for (let v = 0; v < box.height; v++) {
        for (let u = 0; u < box.width; u++) {
          const role = box.pixels(u, v);
          if (role === 0 || isShadow(role)) continue;
          opaque++;
          if (whitens(role)) white++;
        }
      }
      return { opaque, white };
    };
    const short: string[] = [];
    atlas.names.forEach((name, source) => {
      const planche = share(motif(source * levels));
      if (planche.white === 0) return;
      for (let level = 1; level < levels; level++) {
        const reduced = share(motif(source * levels + level));
        const kept =
          reduced.white / reduced.opaque >=
            (MIN_SNOW_SHARE * planche.white) / planche.opaque - 1e-12 &&
          reduced.white >= Math.min(2, planche.white);
        if (!kept) short.push(`${name} ${String(level)}`);
      }
    });
    expect(short).toEqual(['salt-crust-0 3', 'salt-crust-0 4', 'salt-crust-1 3', 'salt-crust-1 4']);
  });

  it('ne change rien hors neige : un contour devient le chaperon, la région recouverte la neige, rang pour rang', () => {
    // Hors neige, le chaperon a le ton du contour, et la neige ceux de la région qu'elle recouvre
    // (decorPalette, `under`) : un niveau réduit ne change qu'enneigé. Le vote seul, puis la
    // neige gardée, pour chaque source et chaque niveau.
    const humans = HumansSchema.parse(
      JSON.parse(readFileSync(join(root, 'data/humans.json'), 'utf8')),
    );
    const decor = DecorSchema.parse(
      JSON.parse(readFileSync(join(root, 'data/decor.json'), 'utf8')),
    );
    const flora = (
      JSON.parse(readFileSync(join(root, 'data/flora.json'), 'utf8')) as { look: unknown }[]
    ).map((entry) => ({ look: FloraLookSchema.parse(entry.look) }));
    const unders = underRegions(flora, decor);
    const capOf = (rank: number) => legendRole(DECOR_LEGEND, 'cap', rank) >> 3;
    let changed = 0;
    for (const { name, text } of grids) {
      const form = name.replace(/-\d+\.txt$/u, '');
      const under = unders.get(form);
      const base = parseRoleGrid(name, text, DECOR_LEGEND);
      for (const [index, level] of humans.levels.entries()) {
        const voted = reduceRoles(base, level.factor, level.outline, []);
        const kept = keepSnow(base, voted, level.factor, under);
        expect([kept.width, kept.height, kept.anchorX, kept.anchorY]).toEqual([
          voted.width,
          voted.height,
          voted.anchorX,
          voted.anchorY,
        ]);
        voted.roles.forEach((before, at) => {
          const after = kept.roles[at] ?? 0;
          if (after === before) return;
          changed++;
          const where = `${name}, niveau ${String(index)}, pixel ${String(at)}`;
          if (before === KEPT) {
            expect(after >> 3, where).toBe(capOf(0));
            return;
          }
          // Un pixel de la région recouverte, au même rang, devenu la neige.
          expect(under, where).toBeDefined();
          expect(roleParts(before).region, where).toBe(regionCode(DECOR_LEGEND, under ?? ''));
          expect(after, where).toBe(legendRole(DECOR_LEGEND, 'snow', roleParts(before).rank));
        });
      }
    }
    expect(changed).toBeGreaterThan(100);
  });

  it('sait quelle région la neige de chaque forme recouvre : bois des grilles nues, pierre, feuillage', () => {
    const decor = DecorSchema.parse(
      JSON.parse(readFileSync(join(root, 'data/decor.json'), 'utf8')),
    );
    const flora = (
      JSON.parse(readFileSync(join(root, 'data/flora.json'), 'utf8')) as { look: unknown }[]
    ).map((entry) => ({ look: FloraLookSchema.parse(entry.look) }));
    const unders = underRegions(flora, decor);
    expect(unders.get('larch-bare')).toBe('wood');
    expect(unders.get('broadleaf')).toBe('foliage');
    expect(unders.get('rock')).toBe('stone');
    expect(unders.get('salt-crust')).toBe('stone');
    expect([...unders.keys()].sort()).toEqual(namedForms(root));
    // Une forme nommée de deux façons n'en a pas.
    const look = flora.at(0)?.look;
    if (look === undefined) throw new Error('flore vide');
    const twice = underRegions([{ look: { ...look, form: 'x', bare: 'x' } }], {
      rocks: {},
      deposits: {},
    });
    expect(twice.get('x')).toBeUndefined();
    expect(twice.has('x')).toBe(true);
  });

  it('a une empreinte, que tout changement des grilles, des niveaux ou de l’ombre doit expliquer', () => {
    const print = new Fingerprint().bytes(roles);
    for (const value of atlas.motifs) print.uint32(value);
    for (const name of atlas.names) print.string(name);
    expect([atlas.width, atlas.height, atlas.names.length]).toEqual([1024, 275, 42]);
    // Tâche 2b.7 : la neige des niveaux réduits (keepSnow), de 9553d4a3 à f1f1ad1c.
    expect(print.hex()).toBe('f1f1ad1c');
  });
});
