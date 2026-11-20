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
import { DecorSchema, FloraLookSchema } from '../src/core/data/decor.ts';
import { HumansSchema } from '../src/core/data/humans.ts';
import { reduceRoles, type RoleImage } from '../src/gen/humans.ts';
import { DECOR_LEGEND, legendRole } from '../src/gen/legend.ts';
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

/** Les formes que nomment la flore et le décor : il leur faut des grilles. */
export function namedForms(root: string): string[] {
  const flora = z
    .array(z.object({ look: FloraLookSchema }).loose())
    .parse(JSON.parse(readFileSync(join(root, 'data/flora.json'), 'utf8')));
  const decor = DecorSchema.parse(JSON.parse(readFileSync(join(root, 'data/decor.json'), 'utf8')));
  const forms = new Set<string>(['rock']);
  for (const { look } of flora) {
    forms.add(look.form);
    if (look.bare !== undefined) forms.add(look.bare);
  }
  for (const deposit of Object.values(decor.deposits)) forms.add(deposit.form);
  return [...forms].sort();
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
  const decor = DecorSchema.parse(JSON.parse(readFileSync(join(root, 'data/decor.json'), 'utf8')));
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
      const reduced = reduceRoles(base, level.factor, level.outline, []);
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
