/**
 * Atlas du gibier (tâche 2b.6 ; AST-04, REN-08, REN-09 ; ADR 0018, § 7).
 *
 * Au build, et au lancement du serveur de développement, ce module lit les grilles de
 * assets/fauna/ (une par forme et par animation, ses images en blocs « # image k », dans la
 * légende du gibier, src/gen/legend.ts), en tire les niveaux de motifs des humains (facteurs et
 * de data/humans.json, réduction par vote de src/gen/humans.ts, qui garde l'œil ; le contour,
 * celui de rules.retrace de data/fauna.json, à tous les niveaux réduits), et,
 * pour le jeune de chaque espèce, les mêmes niveaux d'une réduction de plus (look.young de
 * data/fauna.json). Le jeune de la forme du mâle adulte (le cerf) n'est jamais montré : il n'est
 * pas rangé. Le tout se range en ligne d'horizon dans un atlas de rôles de la largeur de celui des
 * humains : le jeu le pose sous ceux des humains et du décor, dans la même texture, pour que le
 * gibier soit fait des particules du même conteneur (src/render/people.ts). Le jeu le reçoit par
 * le module virtuel « virtual:fauna-atlas ».
 *
 * Le build échoue si une grille est fausse (sa légende, un caractère, une largeur, ses images, ses
 * pieds), si une forme que nomme data/fauna.json n'a pas ses quatre animations, si une animation
 * n'a pas le même nombre d'images d'une forme à l'autre, ou si une forme dessine une région dont
 * l'espèce ne donne pas les tons (des bois sans look.horn).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizePath, type Plugin } from 'vite';
import { FaunaFileSchema, type FaunaSpecies } from '../src/core/data/fauna.ts';
import { HumansSchema } from '../src/core/data/humans.ts';
import { reduceRoles, type OutlineMode, type RoleImage } from '../src/gen/humans.ts';
import { FAUNA_LEGEND, FAUNA_REGIONS, legendRole } from '../src/gen/legend.ts';
import { drawAtlas, packSkyline, parseRoleFrames, ROLE_ATLAS_WIDTH } from './role-grids.ts';

/** Côté le plus haut de l'atlas : ce que WebGL 2 garantit, les autres atlas compris. */
export const MAX_FAUNA_ROWS = 512;
/** Les animations de chaque forme, dans l'ordre de l'index de l'atlas. */
export const FAUNA_ANIMATIONS = ['idle', 'walk', 'run', 'fall'] as const;
/** L'œil : l'ombre profonde des parties sombres, que la réduction garde d'un pixel. */
export const FAUNA_EYE = legendRole(FAUNA_LEGEND, 'dark', 3);

export interface FaunaAtlas {
  readonly width: number;
  readonly height: number;
  /** Rôles, un octet par pixel, en base64. */
  readonly roles: string;
  /** Six nombres par motif : x, y, largeur, hauteur, et le point des pieds dans le motif. */
  readonly motifs: readonly number[];
  /** Formes (« deer », « stag »…), et animations, dans l'ordre de l'index. */
  readonly forms: readonly string[];
  readonly animations: readonly string[];
  /** Images de chaque animation, les mêmes pour chaque forme. */
  readonly frames: readonly number[];
  readonly levels: number;
  /**
   * Premier motif de (forme, jeune, animation, niveau) : index[((forme × 2 + jeune) × animations
   * + animation) × niveaux + niveau], les images suivant ; −1 sans motif (le jeune du cerf).
   */
  readonly index: readonly number[];
}

/** Le nom d'une grille : sa forme, puis son animation. */
const GRID_NAME = /^([a-z]+(?:-[a-z]+)*)-(idle|walk|run|fall)\.txt$/u;

/** Les grilles du gibier : leurs noms et leur texte, dans l'ordre des noms. */
export function faunaGrids(root: string): { name: string; text: string }[] {
  const dir = join(root, 'assets/fauna');
  return readdirSync(dir)
    .filter((file) => file.endsWith('.txt'))
    .sort()
    .map((file) => ({ name: file, text: readFileSync(join(dir, file), 'utf8') }));
}

/**
 * Contour d'un motif du gibier réduit d'un facteur `factor`, adulte ou jeune : celui de la planche
 * au facteur 1, sinon celui que retrace la règle des données (rules.retrace), à tous les niveaux,
 * même ceux où les humains n'en ont plus : la consigne veut au gibier un contour sombre.
 */
export function faunaOutline(factor: number, retrace: OutlineMode): OutlineMode {
  return factor === 1 ? 'keep' : retrace;
}

/** Les régions qu'une image dessine. */
function regionsOf(image: RoleImage): Set<string> {
  const used = new Set<string>();
  for (const role of image.roles) {
    FAUNA_REGIONS.forEach((region) => {
      for (let rank = 0; rank < 4; rank++) {
        if (legendRole(FAUNA_LEGEND, region, rank) === role) used.add(region);
      }
    });
  }
  return used;
}

export function buildFaunaAtlas(
  root: string,
  grids: readonly { name: string; text: string }[] = faunaGrids(root),
): FaunaAtlas {
  const humans = HumansSchema.parse(
    JSON.parse(readFileSync(join(root, 'data/humans.json'), 'utf8')),
  );
  const { species, rules } = FaunaFileSchema.parse(
    JSON.parse(readFileSync(join(root, 'data/fauna.json'), 'utf8')),
  );
  const parsed = new Map<string, RoleImage[]>();
  for (const { name, text } of grids) {
    const match = GRID_NAME.exec(name);
    if (match === null) throw new Error(`${name} : nom de grille « forme-animation.txt » attendu`);
    parsed.set(name.slice(0, -4), parseRoleFrames(name, text, FAUNA_LEGEND));
  }
  // Les formes que nomment les données, chacune avec son espèce, et si son jeune se montre.
  const forms: { form: string; species: FaunaSpecies; young: boolean }[] = [];
  for (const entry of species) {
    if (!forms.some((known) => known.form === entry.look.form)) {
      forms.push({ form: entry.look.form, species: entry, young: true });
    }
    const male = entry.look.male;
    if (male !== undefined && !forms.some((known) => known.form === male)) {
      forms.push({ form: male, species: entry, young: false });
    }
  }
  const frames = FAUNA_ANIMATIONS.map(
    (animation) => parsed.get(`${forms[0]?.form ?? ''}-${animation}`)?.length ?? 0,
  );
  for (const { form, species: entry } of forms) {
    FAUNA_ANIMATIONS.forEach((animation, at) => {
      const grid = parsed.get(`${form}-${animation}`);
      if (grid === undefined) throw new Error(`assets/fauna : pas de grille ${form}-${animation}`);
      if (grid.length !== frames[at]) {
        throw new Error(
          `assets/fauna/${form}-${animation}.txt : ${String(grid.length)} images, les autres formes en ont ${String(frames[at])}`,
        );
      }
      for (const image of grid) {
        if (regionsOf(image).has('horn') && entry.look.horn === undefined) {
          throw new Error(
            `assets/fauna/${form}-${animation}.txt : des bois ou des défenses, sans look.horn pour ${entry.id}`,
          );
        }
      }
    });
  }
  const levels = humans.levels;
  const images: RoleImage[] = [];
  const index: number[] = [];
  for (const { form, species: entry, young: shown } of forms) {
    for (const young of [false, true]) {
      for (const animation of FAUNA_ANIMATIONS) {
        const grid = parsed.get(`${form}-${animation}`) ?? [];
        for (const level of levels) {
          if (young && !shown) {
            index.push(-1);
            continue;
          }
          index.push(images.length);
          for (const base of grid) {
            const factor = level.factor * (young ? entry.look.young : 1);
            const outline = faunaOutline(factor, rules.retrace);
            images.push(reduceRoles(base, factor, outline, [FAUNA_EYE]));
          }
        }
      }
    }
  }
  const { height, at } = packSkyline(images, ROLE_ATLAS_WIDTH);
  if (height > MAX_FAUNA_ROWS) {
    throw new Error(
      `atlas du gibier : ${String(height)} rangées, ${String(MAX_FAUNA_ROWS)} au plus`,
    );
  }
  const roles = drawAtlas(images, at, ROLE_ATLAS_WIDTH, height);
  const motifs: number[] = [];
  images.forEach((image, rank) => {
    const { x, y } = at[rank] ?? { x: 0, y: 0 };
    motifs.push(x, y, image.width, image.height, image.anchorX, image.anchorY);
  });
  return {
    width: ROLE_ATLAS_WIDTH,
    height,
    roles: Buffer.from(roles).toString('base64'),
    motifs,
    forms: forms.map(({ form }) => form),
    animations: [...FAUNA_ANIMATIONS],
    frames,
    levels: levels.length,
    index,
  };
}

export const FAUNA_MODULE = 'virtual:fauna-atlas';
const RESOLVED = `\0${FAUNA_MODULE}`;

/**
 * Extension de Vite : le module virtuel de l'atlas du gibier, refait quand une grille,
 * data/fauna.json ou data/humans.json change ; en développement, la page se recharge alors.
 */
export function faunaAtlas(root: string): Plugin {
  const watched = (path: string) =>
    path.includes('/assets/fauna/') ||
    path.endsWith('/data/fauna.json') ||
    path.endsWith('/data/humans.json');
  return {
    name: 'pixelciv-fauna-atlas',
    resolveId(id) {
      return id === FAUNA_MODULE ? RESOLVED : undefined;
    },
    load(id) {
      if (id !== RESOLVED) return undefined;
      for (const file of ['data/fauna.json', 'data/humans.json']) {
        this.addWatchFile(join(root, file));
      }
      const grids = faunaGrids(root);
      for (const grid of grids) this.addWatchFile(join(root, 'assets/fauna', grid.name));
      return `export default ${JSON.stringify(buildFaunaAtlas(root, grids))};`;
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
