/**
 * Atlas du décor (tâche 2b.6 ; AST-04, REN-08, REN-09 ; ADR 0017, § 3 et 4).
 *
 * Au build, et au lancement du serveur de développement, ce module lit les grilles de
 * assets/decor/ (une par forme et par variante, à la densité de la planche des humains, dans la
 * légende du décor, src/gen/legend.ts), en tire les niveaux de motifs des humains (facteurs et
 * contours de data/humans.json, réduction par vote de src/gen/humans.ts), ajoute à chaque niveau
 * l'ombre portée au sol (la silhouette du niveau projetée vers le sud-ouest, data/decor.json),
 * et range le tout dans un atlas de rôles de la largeur de celui des humains : le jeu le pose
 * sous l'atlas des humains, dans la même texture, pour que décor et humains soient les
 * particules d'un même conteneur (src/render/people.ts). Le jeu le reçoit par le module virtuel
 * « virtual:decor-atlas ».
 *
 * Le build échoue si une grille est fausse (sa légende, un caractère, une largeur, ses pieds),
 * si les variantes d'une forme ne se suivent pas, ou si une forme que nomment data/flora.json
 * et data/decor.json n'a pas de grilles.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizePath, type Plugin } from 'vite';
import { z } from 'zod';
import {
  DecorSchema,
  FloraLookSchema,
  type Decor,
  type FloraLook,
} from '../src/core/data/decor.ts';
import { HumansSchema } from '../src/core/data/humans.ts';
import { KEPT, reduceRoles, roleParts, type RoleImage } from '../src/gen/humans.ts';
import { DECOR_LEGEND, legendRole, regionCode } from '../src/gen/legend.ts';
import {
  drawAtlas,
  packSkyline,
  parseRoleGrid,
  ROLE_ATLAS_WIDTH,
  withShadow,
} from './role-grids.ts';

/** Côté le plus haut de l'atlas : ce que WebGL 2 garantit, l'atlas des humains compris. */
export const MAX_DECOR_ROWS = 1024;

export interface DecorAtlas {
  readonly width: number;
  readonly height: number;
  /** Rôles, un octet par pixel, en base64. */
  readonly roles: string;
  /** Six nombres par motif : x, y, largeur, hauteur, et le point des pieds dans le motif. */
  readonly motifs: readonly number[];
  /** Nom de chaque source (« forme-variante ») ; le motif du niveau l est source × niveaux + l. */
  readonly names: readonly string[];
  /** Sources de chaque forme, dans l'ordre de leurs variantes. */
  readonly forms: Readonly<Record<string, readonly number[]>>;
  readonly levels: number;
}

/** Le nom d'une grille : sa forme, puis le numéro de sa variante. */
const GRID_NAME = /^([a-z]+(?:-[a-z]+)*)-(\d+)\.txt$/u;

/**
 * Les formes que nomment la flore (`look.form`, `look.bare`) et le décor (les rochers épars et
 * ceux des gisements), triées : il leur faut des grilles. Aucune n'est nommée par le code.
 */
export function formsOf(
  flora: readonly { readonly look: FloraLook }[],
  decor: Pick<Decor, 'rocks' | 'deposits'>,
): string[] {
  const forms = new Set<string>();
  for (const { look } of flora) {
    forms.add(look.form);
    if (look.bare !== undefined) forms.add(look.bare);
  }
  for (const rock of Object.values(decor.rocks)) forms.add(rock.form);
  for (const deposit of Object.values(decor.deposits)) forms.add(deposit.form);
  return [...forms].sort();
}

/** Les formes que nomment data/flora.json et data/decor.json (formsOf). */
export function namedForms(root: string): string[] {
  const { flora, decor } = formData(root);
  return formsOf(flora, decor);
}

/** Les apparences de data/flora.json et le décor de data/decor.json, lus pour les formes. */
function formData(root: string) {
  const flora = z
    .array(z.object({ look: FloraLookSchema }).loose())
    .parse(JSON.parse(readFileSync(join(root, 'data/flora.json'), 'utf8')));
  const decor = DecorSchema.parse(JSON.parse(readFileSync(join(root, 'data/decor.json'), 'utf8')));
  return { flora, decor };
}

/**
 * La région que la neige de chaque forme recouvre hors neige, celle dont elle prend les tons
 * (src/render/decor.ts, decorPalette : `under`) : le bois d'une grille nue (`look.bare`), la pierre
 * d'un rocher ou d'un gisement, le feuillage des autres formes de la flore. Une forme nommée de
 * deux façons n'en a pas.
 */
export function underRegions(
  flora: readonly { readonly look: FloraLook }[],
  decor: Pick<Decor, 'rocks' | 'deposits'>,
): ReadonlyMap<string, string | undefined> {
  const under = new Map<string, string | undefined>();
  const name = (form: string, region: string) =>
    under.set(form, under.has(form) && under.get(form) !== region ? undefined : region);
  for (const { look } of flora) {
    name(look.form, 'foliage');
    if (look.bare !== undefined) name(look.bare, 'wood');
  }
  for (const rock of Object.values(decor.rocks)) name(rock.form, 'stone');
  for (const deposit of Object.values(decor.deposits)) name(deposit.form, 'stone');
  return under;
}

/** Régions de la neige et du chaperon, qui blanchissent sous la neige (decorPalette). */
const SNOW_REGION = regionCode(DECOR_LEGEND, 'snow');
const CAP_REGION = regionCode(DECOR_LEGEND, 'cap');

/**
 * Part de la neige et du chaperon de la planche que chaque niveau réduit garde au moins (keepSnow),
 * avec deux pixels au moins.
 */
export const MIN_SNOW_SHARE = 0.5;

/** Le rôle blanchit-il sous la neige : la région de la neige, ou le chaperon ? */
export function whitens(role: number): boolean {
  if (role < 16) return false;
  const { region } = roleParts(role);
  return region === SNOW_REGION || region === CAP_REGION;
}

/**
 * La neige des niveaux réduits (tâche 2b.7 ; ADR 0017, § 4 ; ADR 0019) : le vote de la réduction
 * (reduceRoles) donne chaque pixel à la région la plus présente de son bloc, si bien qu'une
 * neige fine, un chaperon d'un pixel, s'y perdent (le saule nain enneigé ne gardait au facteur 2
 * que 6 pixels blancs sur 78, contre 75 sur 284 à la planche). Cette passe en rend à la
 * réduction `reduced` de facteur `f` de la planche `base` jusqu'à retrouver la part de pixels
 * blanchissants de la planche (deux pixels au moins), sans rien changer hors neige :
 * - un contour dont le bloc porte du chaperon devient le chaperon, au rang moyen de celui-ci :
 *   hors neige, le chaperon a le ton du contour ;
 * - un pixel de la région `under` (underRegions) dont le bloc porte de la neige devient la neige,
 *   à son propre rang : hors neige, la neige prend les tons de cette région, rang pour rang.
 * Les pixels se prennent dans l'ordre de la part blanchissante de leur bloc, la plus forte
 * d'abord, puis de haut en bas et de gauche à droite. Aux niveaux où les formes fines (roseaux,
 * frondes des palmiers) n'ont plus assez de pixels sur la neige de la planche pour en garder la
 * moitié de la part (MIN_SNOW_SHARE) ou deux pixels, d'autres pixels de la région `under`, puis
 * du contour si la planche a un chaperon, se prennent du haut vers le bas, jusque-là seulement :
 * la neige se pose sur le dessus. La neige et le chaperon ont un ton dans toute palette du décor,
 * même d'une forme dont la planche n'en porte pas (decorPalette). Une forme dont la réduction n'a
 * ni contour ni pixel de la région `under` (la croûte de sel des petits niveaux, toute de
 * minerai) reste sans neige : rien n'y blanchirait sans changer hors neige.
 */
export function keepSnow(
  base: RoleImage,
  reduced: RoleImage,
  f: number,
  under: string | undefined,
): RoleImage {
  if (f === 1) return reduced;
  const count = (image: RoleImage) => {
    let opaque = 0;
    let white = 0;
    for (const role of image.roles) {
      if (role === 0) continue;
      opaque++;
      if (whitens(role)) white++;
    }
    return { opaque, white };
  };
  const planche = count(base);
  if (planche.white === 0) return reduced;
  const level = count(reduced);
  const share = planche.white / planche.opaque;
  const floor = Math.min(2, planche.white);
  const goal = (part: number) =>
    Math.min(level.opaque, Math.max(floor, Math.ceil(part * share * level.opaque)));
  // La part de la planche par les pixels de sa neige, sa moitié au moins par les autres.
  const full = goal(1);
  const least = goal(MIN_SNOW_SHARE);
  if (level.white >= full) return reduced;
  const underCode = under === undefined ? -1 : regionCode(DECOR_LEGEND, under);
  const { width, height } = reduced;
  // Les pixels sur la neige de la planche ; puis, du haut vers le bas, ceux de la région `under`,
  // et le contour, d'une planche à chaperon.
  const candidates: { at: number; weight: number; role: number }[] = [];
  const fallback: { at: number; weight: number; role: number }[] = [];
  const outlines: { at: number; weight: number; role: number }[] = [];
  const capped = base.roles.some((role) => role >= 16 && roleParts(role).region === CAP_REGION);
  for (let v = 0; v < height; v++) {
    // Le bloc de la planche sous le pixel (u, v), comme reduceRoles le découpe.
    const y0 = base.anchorY - (height - v) * f;
    for (let u = 0; u < width; u++) {
      const at = v * width + u;
      const role = reduced.roles[at] ?? 0;
      if (role === 0 || whitens(role)) continue;
      const outline = role === KEPT;
      const own = role >= 16 ? roleParts(role) : undefined;
      if (!outline && own?.region !== underCode) continue;
      const x0 = base.anchorX + (u - reduced.anchorX) * f;
      let snow = 0;
      let cap = 0;
      let capRanks = 0;
      blockCover(base, x0, y0, f, (cell, weight) => {
        if (cell < 16) return;
        const { region, rank } = roleParts(cell);
        if (region === SNOW_REGION) snow += weight;
        if (region === CAP_REGION) {
          cap += weight;
          capRanks += weight * rank;
        }
      });
      if (outline) {
        const rank = cap > 0 ? Math.min(3, Math.round(capRanks / cap)) : 0;
        const role = legendRole(DECOR_LEGEND, 'cap', rank);
        if (cap > 0) candidates.push({ at, weight: cap, role });
        else if (capped) outlines.push({ at, weight: 0, role });
      } else if (own !== undefined) {
        const role = legendRole(DECOR_LEGEND, 'snow', own.rank);
        (snow > 0 ? candidates : fallback).push({ at, weight: snow, role });
      }
    }
  }
  candidates.sort((a, b) => b.weight - a.weight || a.at - b.at);
  const chosen = candidates.slice(0, full - level.white);
  const missing = least - level.white - chosen.length;
  if (missing > 0) chosen.push(...[...fallback, ...outlines].slice(0, missing));
  const roles = Uint8Array.from(reduced.roles);
  for (const candidate of chosen) roles[candidate.at] = candidate.role;
  return { ...reduced, roles };
}

/** Les pixels de `image` qui recouvrent le bloc [x0, x0 + f) × [y0, y0 + f), et la part de chacun. */
function blockCover(
  image: RoleImage,
  x0: number,
  y0: number,
  f: number,
  visit: (role: number, weight: number) => void,
): void {
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(image.height, Math.ceil(y0 + f)); y++) {
    const wy = Math.min(y + 1, y0 + f) - Math.max(y, y0);
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(image.width, Math.ceil(x0 + f)); x++) {
      const wx = Math.min(x + 1, x0 + f) - Math.max(x, x0);
      if (wx > 0 && wy > 0) visit(image.roles[y * image.width + x] ?? 0, wx * wy);
    }
  }
}

/** Les grilles du décor : leurs noms et leur texte, dans l'ordre des noms. */
export function decorGrids(root: string): { name: string; text: string }[] {
  const dir = join(root, 'assets/decor');
  return readdirSync(dir)
    .filter((file) => file.endsWith('.txt'))
    .sort()
    .map((file) => ({ name: file, text: readFileSync(join(dir, file), 'utf8') }));
}

export function buildDecorAtlas(
  root: string,
  grids: readonly { name: string; text: string }[] = decorGrids(root),
): DecorAtlas {
  const humans = HumansSchema.parse(
    JSON.parse(readFileSync(join(root, 'data/humans.json'), 'utf8')),
  );
  const { flora, decor } = formData(root);
  const unders = underRegions(flora, decor);
  const shadowRoles: [number, number] = [
    legendRole(DECOR_LEGEND, 'shadow', 0),
    legendRole(DECOR_LEGEND, 'shadow', 1),
  ];
  const names: string[] = [];
  const forms: Record<string, number[]> = {};
  const images: RoleImage[] = [];
  for (const { name, text } of grids) {
    const match = GRID_NAME.exec(name);
    if (match === null) throw new Error(`${name} : nom de grille « forme-variante.txt » attendu`);
    const form = match[1];
    const variant = Number(match[2]);
    const sources = (forms[form] ??= []);
    if (variant !== sources.length) {
      throw new Error(
        `${name} : variante ${String(variant)}, la forme ${form} attend ${String(sources.length)}`,
      );
    }
    sources.push(names.length);
    names.push(name.slice(0, -4));
    const base = parseRoleGrid(name, text, DECOR_LEGEND);
    for (const level of humans.levels) {
      const reduced = keepSnow(
        base,
        reduceRoles(base, level.factor, level.outline, []),
        level.factor,
        unders.get(form),
      );
      images.push(withShadow(reduced, decor.shadow.sx, decor.shadow.sy, shadowRoles));
    }
  }
  const missing = namedForms(root).filter((form) => !Object.hasOwn(forms, form));
  if (missing.length > 0) {
    throw new Error(
      `atlas du décor : formes sans grilles dans assets/decor/ : ${missing.join(', ')}`,
    );
  }
  const { height, at } = packSkyline(images, ROLE_ATLAS_WIDTH);
  if (height > MAX_DECOR_ROWS) {
    throw new Error(
      `atlas du décor : ${String(height)} rangées, ${String(MAX_DECOR_ROWS)} au plus`,
    );
  }
  const roles = drawAtlas(images, at, ROLE_ATLAS_WIDTH, height);
  const motifs: number[] = [];
  images.forEach((image, index) => {
    const { x, y } = at[index] ?? { x: 0, y: 0 };
    motifs.push(x, y, image.width, image.height, image.anchorX, image.anchorY);
  });
  return {
    width: ROLE_ATLAS_WIDTH,
    height,
    roles: Buffer.from(roles).toString('base64'),
    motifs,
    names,
    forms,
    levels: humans.levels.length,
  };
}

export const DECOR_MODULE = 'virtual:decor-atlas';
const RESOLVED = `\0${DECOR_MODULE}`;

/**
 * Extension de Vite : le module virtuel de l'atlas du décor, refait quand une grille,
 * data/decor.json, data/flora.json ou data/humans.json change ; en développement, la page se
 * recharge alors.
 */
export function decorAtlas(root: string): Plugin {
  const watched = (path: string) =>
    path.includes('/assets/decor/') ||
    path.endsWith('/data/decor.json') ||
    path.endsWith('/data/flora.json') ||
    path.endsWith('/data/humans.json');
  return {
    name: 'pixelciv-decor-atlas',
    resolveId(id) {
      return id === DECOR_MODULE ? RESOLVED : undefined;
    },
    load(id) {
      if (id !== RESOLVED) return undefined;
      for (const file of ['data/decor.json', 'data/flora.json', 'data/humans.json']) {
        this.addWatchFile(join(root, file));
      }
      const grids = decorGrids(root);
      for (const grid of grids) this.addWatchFile(join(root, 'assets/decor', grid.name));
      return `export default ${JSON.stringify(buildDecorAtlas(root, grids))};`;
    },
    hotUpdate({ file }) {
      if (this.environment.name !== 'client' || !watched(normalizePath(file))) return;
      const graph = this.environment.moduleGraph;
      const module = graph.getModuleById(RESOLVED);
      if (module !== undefined) graph.invalidateModule(module);
      this.environment.hot.send({ type: 'full-reload' });
      return [];
    },
  };
}
