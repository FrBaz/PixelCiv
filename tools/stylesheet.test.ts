/**
 * Feuille de style de l'application (src/app/style.css), lue comme le navigateur la lit, pour
 * quelques propriétés de la colonne de droite et du portrait : à une taille de fenêtre
 * donnée, quelle valeur l'emporte sur un élément ? Le calcul suit la cascade : media
 * queries, puis spécificité, puis ordre des règles. Il connaît les sélecteurs faits de
 * balises, d'identifiants, de classes et de combinateurs de descendance ou d'enfant ; un
 * autre sélecteur qui déclarerait l'une des propriétés lues fait échouer le test, au lieu
 * d'être ignoré. Les éléments se décrivent par leurs ancêtres, comme App.tsx les rend.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SMALL_SCREEN_QUERY } from '../src/render/camera';

// Lue par Node : sous Vitest, l'import d'une feuille de style, même brut, est vide.
const css = readFileSync(new URL('../src/app/style.css', import.meta.url), 'utf8');

/** Un élément de la page : sa balise, son identifiant, ses classes. */
interface Node {
  readonly tag: string;
  readonly id: string;
  readonly classes: readonly string[];
}

/** Une règle de la feuille, avec la media query qui l'entoure, s'il y en a une. */
interface Rule {
  readonly media: string | undefined;
  readonly selectors: readonly string[];
  readonly declarations: readonly (readonly [name: string, value: string])[];
}

/** Taille de la fenêtre, en pixels CSS. */
interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** Coupe `text` à chaque `separator` hors des parenthèses. */
function split(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, at));
      start = at + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/** Rang de l'accolade qui ferme celle ouverte au rang `open`. */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let at = open; at < text.length; at++) {
    if (text[at] === '{') depth++;
    if (text[at] === '}' && --depth === 0) return at;
  }
  throw new Error('accolade non fermée');
}

/** Règles de la feuille, dans l'ordre du document. */
function parse(source: string): Rule[] {
  const rules: Rule[] = [];
  const block = (text: string, media: string | undefined) => {
    let at = 0;
    for (let open = text.indexOf('{'); open !== -1; open = text.indexOf('{', at)) {
      const prelude = text.slice(at, open).trim();
      const close = closing(text, open);
      const body = text.slice(open + 1, close);
      at = close + 1;
      if (prelude.startsWith('@media ') && media === undefined) {
        block(body, prelude.slice('@media '.length).trim());
        continue;
      }
      if (prelude.startsWith('@')) throw new Error(`règle non prise en charge : ${prelude}`);
      if (body.includes('{')) {
        throw new Error(`règles imbriquées non prises en charge : ${prelude}`);
      }
      const declarations = split(body, ';').map((declaration) => {
        const colon = declaration.indexOf(':');
        const value = declaration.slice(colon + 1).trim();
        if (colon === -1 || value.includes('!important')) {
          throw new Error(`déclaration non prise en charge : ${declaration}`);
        }
        return [declaration.slice(0, colon).trim(), value] as const;
      });
      rules.push({ media, selectors: split(prelude, ','), declarations });
    }
  };
  block(source.replace(/\/\*[\s\S]*?\*\//g, ''), undefined);
  return rules;
}

const RULES = parse(css);

/** Un rem des media queries : la taille de police initiale. */
const REM = 16;

/** La media query vaut-elle pour la fenêtre ? Une liste vaut si l'une de ses requêtes vaut. */
function mediaMatches(query: string, viewport: Viewport): boolean {
  return split(query, ',').some((part) =>
    part.split(/\s+and\s+/).every((feature) => {
      const range = /^\((min|max)-(width|height):\s*([\d.]+)(px|rem)\)$/.exec(feature);
      if (range !== null) {
        const [, bound, axis, value, unit] = range;
        const limit = Number(value) * (unit === 'rem' ? REM : 1);
        const size = axis === 'width' ? viewport.width : viewport.height;
        return bound === 'min' ? size >= limit : size <= limit;
      }
      const orientation = /^\(orientation:\s*(landscape|portrait)\)$/.exec(feature);
      if (orientation !== null) {
        const portrait = viewport.height >= viewport.width;
        return (orientation[1] === 'portrait') === portrait;
      }
      throw new Error(`media query non prise en charge : ${feature}`);
    }),
  );
}

/** Un sélecteur simple, avec le combinateur qui le relie au précédent. */
interface Compound {
  readonly tag: string;
  readonly id: string;
  readonly classes: readonly string[];
  readonly child: boolean;
}

/**
 * Les sélecteurs simples d'un sélecteur, ou undefined s'il n'est pas fait que de balises,
 * d'identifiants, de classes et de combinateurs de descendance ou d'enfant.
 */
function compounds(selector: string): Compound[] | undefined {
  const parts: Compound[] = [];
  let child = false;
  for (const token of selector.replace(/\s*>\s*/g, ' > ').split(/\s+/)) {
    if (token === '>') {
      child = true;
      continue;
    }
    const match = /^([a-z][a-z0-9]*|)(#[\w-]+|)((?:\.[\w-]+)*)$/.exec(token);
    if (match === null) return undefined;
    const [, tag, id, classes] = match;
    parts.push({ tag, id: id.slice(1), classes: classes.split('.').slice(1), child });
    child = false;
  }
  return parts;
}

/** Le sélecteur simple de rang `index` décrit-il l'élément de rang `depth`, et ses ancêtres ? */
function matchesAt(
  parts: readonly Compound[],
  index: number,
  path: readonly Node[],
  depth: number,
): boolean {
  if (depth < 0) return false;
  const part = parts[index];
  const node = path[depth];
  if (part.tag !== '' && part.tag !== node.tag) return false;
  if (part.id !== '' && part.id !== node.id) return false;
  if (!part.classes.every((name) => node.classes.includes(name))) return false;
  if (index === 0) return true;
  if (part.child) return matchesAt(parts, index - 1, path, depth - 1);
  for (let ancestor = depth - 1; ancestor >= 0; ancestor--) {
    if (matchesAt(parts, index - 1, path, ancestor)) return true;
  }
  return false;
}

/** Ce que déclare une règle pour `property`, raccourci compris : la dernière l'emporte. */
function declared(rule: Rule, property: string): string | undefined {
  let value: string | undefined;
  for (const [name, text] of rule.declarations) {
    if (name === property) value = text;
    // Le raccourci : une valeur pour les deux axes, ou celle de x puis celle de y.
    if (name === 'overscroll-behavior' && property.startsWith(`${name}-`)) {
      const [x, y = x] = text.split(/\s+/);
      value = property.endsWith('-x') ? x : y;
    }
  }
  return value;
}

/**
 * Valeur de `property` sur le dernier élément de `path` (de la racine à lui), dans la
 * fenêtre : celle de la déclaration qui l'emporte, ou `initial`. Ces propriétés ne
 * s'héritent pas.
 */
function computed(path: readonly Node[], property: string, viewport: Viewport, initial: string) {
  let best: { readonly specificity: number; readonly value: string } | undefined;
  for (const rule of RULES) {
    const value = declared(rule, property);
    if (value === undefined) continue;
    for (const selector of rule.selectors) {
      const parts = compounds(selector);
      if (parts === undefined) throw new Error(`sélecteur non pris en charge : ${selector}`);
      if (rule.media !== undefined && !mediaMatches(rule.media, viewport)) continue;
      if (!matchesAt(parts, parts.length - 1, path, path.length - 1)) continue;
      // Identifiants, puis classes, puis balises ; à spécificité égale, la règle d'après.
      const specificity = parts.reduce(
        (sum, part) =>
          sum + (part.id === '' ? 0 : 1e6) + part.classes.length * 1e3 + (part.tag === '' ? 0 : 1),
        0,
      );
      if (best === undefined || specificity >= best.specificity) best = { specificity, value };
    }
  }
  return best?.value ?? initial;
}

const node = (tag: string, ...classes: string[]): Node => ({ tag, id: '', classes });

/** La colonne de droite, dans la couche d'interface (index.html, App.tsx). */
const COLUMN = [
  node('html'),
  node('body'),
  { tag: 'div', id: 'ui', classes: [] },
  node('div', 'hud'),
  node('div', 'hud-side'),
];

/** La place d'un panneau : celle du dessus, ou une autre, cachée sur petit écran. */
const slot = (top: boolean) => [
  ...COLUMN,
  top ? node('div', 'side-slot') : node('div', 'side-slot', 'side-under'),
];

/** Les panneaux de la colonne, chacun à la place du dessus. */
const PANELS = {
  creator: [...slot(true), node('div', 'panel', 'creator-panel')],
  sheet: [...slot(true), node('div', 'panel', 'cell-info', 'sheet')],
  chronicle: [...slot(true), node('div', 'panel', 'chronicle')],
  cell: [...slot(true), node('div', 'panel', 'cell-info')],
  legend: [...slot(true), node('div', 'panel', 'legend')],
};

/** Ce qui défile dans la colonne : les panneaux, et les listes de la chronique et de la légende. */
const SCROLLERS = {
  ...PANELS,
  'chronicle-entries': [...PANELS.chronicle, node('ol', 'chronicle-entries')],
  'legend-entries': [...PANELS.legend, node('ul', 'legend-entries')],
};

/** Le portrait d'une fiche (Sheet.tsx, Portrait.tsx), vivant ou mort. */
const portrait = (dead: boolean) => [
  ...PANELS.sheet,
  node('div', 'sheet-top'),
  node('canvas', 'portrait', ...(dead ? ['portrait-dead'] : [])),
];

/**
 * Petits écrans (au plus 34 rem de large ou 32 rem de haut) : téléphone en paysage et en
 * portrait, petit téléphone, fenêtre de PC basse.
 */
const SMALL: readonly Viewport[] = [
  { width: 802, height: 293 },
  { width: 393, height: 727 },
  { width: 360, height: 640 },
  { width: 1280, height: 500 },
];

/** Grands écrans : fenêtre de PC de hauteur moyenne, où la colonne déborde, et plus grandes. */
const LARGE: readonly Viewport[] = [
  { width: 1280, height: 520 },
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
];

const named = (viewport: Viewport) => `${viewport.width} × ${viewport.height}`;

describe('feuille de style (src/app/style.css)', () => {
  it('se lit comme le navigateur : media queries, spécificité, ordre', () => {
    for (const viewport of SMALL) {
      expect(mediaMatches('(max-width: 34rem), (max-height: 32rem)', viewport)).toBe(true);
      // La place cachée l'emporte sur la règle de toutes les places, plus haut dans la feuille.
      expect(computed(slot(false), 'display', viewport, 'block'), named(viewport)).toBe('none');
      expect(computed(slot(true), 'display', viewport, 'block'), named(viewport)).toBe('contents');
    }
    for (const viewport of LARGE) {
      expect(mediaMatches('(max-width: 34rem), (max-height: 32rem)', viewport)).toBe(false);
      expect(computed(slot(false), 'display', viewport, 'block'), named(viewport)).toBe('contents');
    }
    expect(mediaMatches('(orientation: landscape) and (max-height: 32rem)', SMALL[0])).toBe(true);
    expect(mediaMatches('(orientation: landscape) and (max-height: 32rem)', SMALL[1])).toBe(false);
    // La colonne devient une feuille au bas de l'écran en portrait seulement.
    expect(computed(COLUMN, 'align-self', SMALL[1], 'auto')).toBe('end');
    expect(computed(COLUMN, 'align-self', SMALL[0], 'auto')).toBe('auto');
    // #map canvas ne décrit pas le portrait, ni .create-frame canvas.
    expect(computed(portrait(false), 'display', SMALL[0], 'inline')).toBe('inline');
    expect(() => computed(slot(true), 'background', SMALL[0], 'none')).toThrow(/sélecteur/);
  });

  it("repère le téléphone du zoom d'ouverture à la requête média du petit écran (2b.1)", () => {
    // Au doigt seul, une partie s'ouvre au zoom 3 sur le petit écran de la mise en page :
    // main.ts l'interroge par SMALL_SCREEN_QUERY, que la feuille emploie telle quelle.
    expect(RULES.some((rule) => rule.media === SMALL_SCREEN_QUERY)).toBe(true);
    for (const viewport of SMALL) expect(mediaMatches(SMALL_SCREEN_QUERY, viewport)).toBe(true);
    for (const viewport of LARGE) expect(mediaMatches(SMALL_SCREEN_QUERY, viewport)).toBe(false);
  });

  it('laisse toute la colonne à la chronique et à la légende sur petit écran (9-navigateur/P0)', () => {
    // La règle de base de la chronique vient après le bloc des petits écrans, avec une
    // spécificité égale : c'est la spécificité de ce bloc qui doit l'emporter.
    for (const viewport of SMALL) {
      for (const panel of [PANELS.chronicle, PANELS.legend]) {
        expect(computed(panel, 'max-height', viewport, 'none'), named(viewport)).toBe('none');
      }
    }
    // Sur grand écran, une longue liste laisse la moitié de la colonne aux autres panneaux.
    for (const viewport of LARGE) {
      for (const panel of [PANELS.chronicle, PANELS.legend]) {
        expect(computed(panel, 'max-height', viewport, 'none'), named(viewport)).toBe('50%');
      }
    }
  });

  it('fait défiler la colonne depuis ses panneaux sur grand écran (6-interface/P4)', () => {
    // La colonne, qui déborde quand les panneaux ne tiennent pas, ne reçoit pas les gestes
    // (pointer-events) : seuls ses panneaux, arrivés au bout du leur, lui passent la molette.
    for (const viewport of LARGE) {
      for (const [name, path] of Object.entries(SCROLLERS)) {
        expect(
          computed(path, 'overscroll-behavior-y', viewport, 'auto'),
          `${name}, ${named(viewport)}`,
        ).toBe('auto');
      }
    }
    // Sur petit écran, la colonne ne déborde pas : la fiche, la case et l'outil gardent leur
    // défilement, sans le passer à la page.
    for (const viewport of SMALL) {
      for (const [name, path] of Object.entries({
        creator: PANELS.creator,
        sheet: PANELS.sheet,
        cell: PANELS.cell,
      })) {
        expect(
          computed(path, 'overscroll-behavior-y', viewport, 'auto'),
          `${name}, ${named(viewport)}`,
        ).toBe('contain');
      }
    }
  });

  it('donne au portrait sa propre couche, vivant comme mort (9-navigateur/P1)', () => {
    for (const viewport of [...SMALL, ...LARGE]) {
      for (const dead of [false, true]) {
        expect(computed(portrait(dead), 'will-change', viewport, 'auto'), named(viewport)).toBe(
          'transform',
        );
        expect(computed(portrait(dead), 'image-rendering', viewport, 'auto')).toBe('pixelated');
      }
    }
  });
});
