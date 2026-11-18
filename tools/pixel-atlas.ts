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
}

/**
 * Lit une source ; lève une erreur qui nomme la source et la ligne en défaut, numérotée
 * comme dans le fichier, commentaires et lignes vides compris. Une marque d'ordre des
 * octets (BOM) en tête, qu'ajoutent certains éditeurs, est ignorée.
 */
export function parseGrid(name: string, text: string): Grid {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line, index) => ({ text: line.trimEnd(), number: index + 1 }))
    .filter((line) => line.text !== '' && !line.text.startsWith('#'));
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
  return { width, height: lines.length, roles };
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

/** Sources d'un dossier, par nom de motif (« dossier/nom »). */
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
        grids[name] = parseGrid(name, readFileSync(path, 'utf8'));
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
