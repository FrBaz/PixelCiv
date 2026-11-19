/**
 * Pipeline d'assets (tâche 2.7 ; AST-03, AST-04, REN-09 ; ADR 0011).
 *
 * Les sources pixel art du jeu sont des grilles de texte, éditables à la main, dans
 * assets/pixel/ : un caractère par pixel, qui désigne un rôle de teinte (contour, peau,
 * cheveux, vêtement…, en ombre, base ou lumière), et non une couleur. Au build, et au
 * lancement du serveur de développement, ce module les lit toutes et les range dans un
 * atlas : une seule image de rôles, avec la place de chaque motif. Le jeu le reçoit par
 * le module virtuel « virtual:pixel-atlas », et le recolore à l'exécution (src/render/atlas.ts) :
 * un même motif sert à tous les teints, toutes les couleurs de cheveux et d'habits.
 *
 * Format d'une source : des lignes de même longueur ; une ligne vide ou qui commence par
 * « # » est ignorée. Une source nommée « nom.txt » donne le motif « dossier/nom ».
 *
 * Variantes de hauteur (ADR 0014) : une ligne « # variantes 8 à 10, rangée 7 » demande les
 * motifs « dossier/nom@8 », « dossier/nom@9 » et « dossier/nom@10 », d'une rangée de moins,
 * de la hauteur de la source et d'une rangée de plus : la rangée désignée, numérotée depuis le
 * haut du motif, y est ôtée ou doublée. Un individu prend ainsi une hauteur propre, sans
 * agrandissement qui ferait des pixels de deux tailles.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { normalizePath, type Plugin } from 'vite';
import { ROLE_CHARACTERS } from '../src/core/visual.ts';

export interface Grid {
  readonly width: number;
  readonly height: number;
  /** Code de rôle de chaque pixel, ligne par ligne. */
  readonly roles: readonly number[];
  /**
   * Variantes de hauteur demandées par la source : de `min` à `max` rangées, en ôtant ou en
   * doublant la rangée `row` (comptée de 1, en haut).
   */
  readonly variants?: { readonly min: number; readonly max: number; readonly row: number };
}

/** Ligne de commentaire qui demande des variantes de hauteur. */
const VARIANTS = /^#\s*variantes\b/u;
const VARIANTS_FORMAT = /^#\s*variantes\s+(\d+)\s+à\s+(\d+)\s*,\s*rangée\s+(\d+)\s*$/u;

/**
 * Lit une source ; lève une erreur qui nomme la source et la ligne en défaut, numérotée
 * comme dans le fichier, commentaires et lignes vides compris. Une marque d'ordre des
 * octets (BOM) en tête, qu'ajoutent certains éditeurs, est ignorée.
 */
export function parseGrid(name: string, text: string): Grid {
  const all = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line, index) => ({ text: line.trimEnd(), number: index + 1 }));
  const lines = all.filter((line) => line.text !== '' && !line.text.startsWith('#'));
  const width = lines[0]?.text.length ?? 0;
  if (width === 0) throw new Error(`${name} : motif vide`);
  const roles: number[] = [];
  for (const line of lines) {
    const where = `${name}, ligne ${String(line.number)}`;
    if (line.text.length !== width) {
      throw new Error(`${where} : ${String(line.text.length)} pixels au lieu de ${String(width)}`);
    }
    for (const character of line.text) {
      const role = ROLE_CHARACTERS.indexOf(character);
      if (role < 0) throw new Error(`${where} : rôle inconnu « ${character} »`);
      roles.push(role);
    }
  }
  const height = lines.length;
  const directives = all.filter((line) => VARIANTS.test(line.text));
  if (directives.length > 1) {
    throw new Error(`${name}, ligne ${String(directives[1]?.number)} : variantes déjà demandées`);
  }
  const directive = directives.at(0);
  if (directive === undefined) return { width, height, roles };
  const where = `${name}, ligne ${String(directive.number)}`;
  const match = VARIANTS_FORMAT.exec(directive.text);
  if (match === null) throw new Error(`${where} : « # variantes 8 à 10, rangée 7 » attendu`);
  const [min, max, row] = [match[1], match[2], match[3]].map(Number) as [number, number, number];
  // Une rangée ôtée ou doublée, au plus : la hauteur de la source, à une rangée près.
  if (!(min <= height && height <= max && min >= height - 1 && max <= height + 1)) {
    throw new Error(
      `${where} : de ${String(height - 1)} à ${String(height + 1)} rangées au plus, hauteur ${String(height)} comprise`,
    );
  }
  if (row < 1 || row > height) throw new Error(`${where} : rangée hors du motif`);
  return { width, height, roles, variants: { min, max, row } };
}

/**
 * Variante de `rows` rangées d'un motif qui en demande (Grid.variants) : la rangée désignée
 * ôtée pour une rangée de moins, doublée pour une de plus ; le motif tel quel à sa hauteur.
 */
export function variantGrid(grid: Grid, rows: number): Grid {
  const { width, height, roles, variants } = grid;
  if (variants === undefined || rows < variants.min || rows > variants.max) {
    throw new Error(`variante de ${String(rows)} rangées non demandée`);
  }
  const at = variants.row - 1;
  const line = (index: number) => roles.slice(index * width, (index + 1) * width);
  const lines: number[][] = [];
  for (let index = 0; index < height; index++) {
    if (index === at && rows < height) continue;
    lines.push(line(index));
    if (index === at && rows > height) lines.push(line(index));
  }
  return { width, height: rows, roles: lines.flat() };
}

/** Nom d'une variante de hauteur d'un motif : « sprites/adult-male-0@10 ». */
export function variantName(name: string, rows: number): string {
  return `${name}@${String(rows)}`;
}

export interface Atlas {
  readonly width: number;
  readonly height: number;
  /** Code de rôle de chaque pixel de l'atlas, ligne par ligne ; 0 hors des motifs. */
  readonly roles: readonly number[];
  readonly frames: Readonly<
    Record<string, { x: number; y: number; width: number; height: number }>
  >;
}

/** Range les motifs en rangées, les plus hauts d'abord, avec un pixel de marge. */
export function packAtlas(grids: Readonly<Record<string, Grid>>, width = 128): Atlas {
  const entries = Object.entries(grids).sort(
    ([a, first], [b, second]) => second.height - first.height || a.localeCompare(b),
  );
  const frames: Record<string, { x: number; y: number; width: number; height: number }> = {};
  const placed: [Grid, { x: number; y: number }][] = [];
  let x = 0;
  let y = 0;
  let shelf = 0;
  for (const [name, grid] of entries) {
    if (grid.width > width) throw new Error(`${name} : plus large que l'atlas`);
    if (x + grid.width > width) {
      x = 0;
      y += shelf + 1;
      shelf = 0;
    }
    frames[name] = { x, y, width: grid.width, height: grid.height };
    placed.push([grid, { x, y }]);
    x += grid.width + 1;
    shelf = Math.max(shelf, grid.height);
  }
  const height = y + shelf;
  const roles = new Array<number>(width * height).fill(0);
  for (const [grid, at] of placed) {
    for (let row = 0; row < grid.height; row++) {
      for (let column = 0; column < grid.width; column++) {
        roles[(at.y + row) * width + at.x + column] = grid.roles[row * grid.width + column] ?? 0;
      }
    }
  }
  return { width, height, roles, frames };
}

/**
 * Sources d'un dossier, par nom de motif (« dossier/nom »), et les variantes de hauteur
 * qu'elles demandent (« dossier/nom@rangées »).
 */
export function readSources(root: string): Record<string, Grid> {
  const grids: Record<string, Grid> = {};
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith('.txt')) {
        const name = relative(root, path)
          .split(sep)
          .join('/')
          .replace(/\.txt$/, '');
        const grid = parseGrid(name, readFileSync(path, 'utf8'));
        grids[name] = grid;
        const { variants } = grid;
        if (variants === undefined) continue;
        for (let rows = variants.min; rows <= variants.max; rows++) {
          grids[variantName(name, rows)] = variantGrid(grid, rows);
        }
      }
    }
  };
  walk(root);
  return grids;
}

export const MODULE = 'virtual:pixel-atlas';
const RESOLVED = `\0${MODULE}`;

/**
 * Extension de Vite : le module virtuel de l'atlas, refait quand une source est ajoutée,
 * modifiée ou supprimée. En développement, la page se recharge alors. Le crochet
 * hotUpdate reçoit ces trois sortes d'événements, quand handleHotUpdate ne recevait que
 * les modifications : une source ajoutée n'entrait pas dans l'atlas, même après un
 * rechargement de la page.
 */
export function pixelAtlas(root: string): Plugin {
  const directory = normalizePath(root).replace(/\/?$/, '/');
  return {
    name: 'pixelciv-pixel-atlas',
    resolveId(id) {
      return id === MODULE ? RESOLVED : undefined;
    },
    load(id) {
      if (id !== RESOLVED) return undefined;
      const sources = readSources(root);
      for (const name of Object.keys(sources)) this.addWatchFile(join(root, `${name}.txt`));
      return `export default ${JSON.stringify(packAtlas(sources))};`;
    },
    hotUpdate({ file }) {
      const path = normalizePath(file);
      if (this.environment.name !== 'client' || !path.startsWith(directory)) return;
      if (!path.endsWith('.txt')) return;
      const graph = this.environment.moduleGraph;
      const module = graph.getModuleById(RESOLVED);
      if (module !== undefined) graph.invalidateModule(module);
      this.environment.hot.send({ type: 'full-reload' });
      return [];
    },
  };
}
