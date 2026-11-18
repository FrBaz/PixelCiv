/**
 * Individus et groupes sur la carte (tâches 2.9, 2b.2 et 2b.3 ; REN-03, REN-04, REN-08 ;
 * ADR 0013, ADR 0014) : ce que la carte dessine de chacun, où, à quelle taille, dans quel
 * ordre, et ce qu'un appui y désigne. Fonctions pures, sans PixiJS : PeopleLayer dessine la
 * disposition qu'elles calculent (layoutCrowd), et pickEntity y retrouve ce qu'on touche.
 *
 * - De près, chaque individu se tient à sa position, une variable de la simulation que le fil
 *   principal interpole entre deux jours sur les étapes du worker (app/frames.ts) : ni grappe,
 *   ni grille de case ou de pixel de carte. Ses pieds se posent sur sa position, arrondie au
 *   pixel physique.
 * - Sa taille lui est propre : sa stature, que donne le worker, choisit une variante de son
 *   motif d'une rangée de plus ou de moins (statureRows), quel que soit le zoom ; la vue fixe
 *   une densité entière k, la même pour tous ses individus (viewDensity). Une vue ne mêle donc
 *   jamais deux densités d'individus, et un pixel de motif y fait k × k pixels physiques.
 * - Le nourrisson porté se dessine contre sa mère, juste devant elle.
 * - De loin, la bannière de chaque groupe, à la densité de la carte, au barycentre de ses
 *   membres, ou au membre le plus proche si ce point tombe sur l'eau (bannerAt).
 * - Le plus bas à l'écran passe devant, d'après les pieds, puis le dernier disposé (depth).
 */
import { GROUP_STRIDE, type GroupsFrame } from '../core/protocol';
import { carriedSide, cellOf, deltaFixedX, FIXED, wrapFixedX } from '../core/position';
import { splitmix32 } from '../core/rng';
import { AGE_CLASSES, AGE_CODE, decodeVisual } from '../core/visual';
import { displayScale, TILE_PX, type Camera, type Extent } from './camera';

/**
 * Hauteur à l'écran, en pixels CSS, que doit viser l'adulte de référence pour que les
 * individus se voient : à partir du zoom 3 à la densité 1, et du zoom 2,9 sur Pixel 5.
 */
export const CLOSE_CSS_PX = 8;

/** Écart à sa cible que tolère la densité d'un niveau de motifs plus fin (2b.5). */
const LEVEL_TOLERANCE = 0.25;

/** Unités de stature par case : le worker l'envoie en 1/128 de case (ADR 0014). */
export const STATURE_UNITS = 128;

/** Densité et niveau de détail d'une vue (ADR 0014, § 6). */
export interface ViewDensity {
  /** Hauteur que vise l'adulte de référence, en pixels physiques, avant arrondi. */
  readonly target: number;
  /** Pixels physiques par pixel de motif des individus, le même pour tous : k ≥ 1. */
  readonly k: number;
  /** Niveau de motifs choisi : son rang dans `levels`, 0 pour les mini-sprites. */
  readonly level: number;
  /** Les individus se voient-ils, plutôt que les bannières ? */
  readonly close: boolean;
}

/**
 * Densité de la vue à l'échelle `scale` (displayScale, pixels physiques par pixel de carte),
 * sur un écran de `resolution` pixels physiques par pixel CSS, pour un adulte de référence de
 * `reference` cases (display.stature) : il vise reference × TILE_PX × scale pixels
 * physiques. `levels` donne les rangées de l'adulte de référence de chaque niveau de motifs,
 * du plus fin au plus grossier : la vue prend le plus fin dont k = arrondi(cible / rangées),
 * au moins 1, reste à 25 % de la cible, sinon le plus proche d'elle. Les mini-sprites forment
 * aujourd'hui le seul niveau ; 2b.5 y ajoutera les humains des planches. La vue rapprochée
 * commence quand la cible atteint CLOSE_CSS_PX pixels CSS.
 */
export function viewDensity(
  scale: number,
  resolution: number,
  reference: number,
  levels: readonly [number, ...number[]],
): ViewDensity {
  const target = reference * TILE_PX * scale;
  const densityOf = (rows: number) => Math.max(1, Math.round(target / rows));
  const errorOf = (rows: number) => Math.abs(densityOf(rows) * rows - target) / target;
  let level = levels.findIndex((rows) => errorOf(rows) <= LEVEL_TOLERANCE);
  if (level < 0) {
    level = 0;
    levels.forEach((rows, index) => {
      if (errorOf(rows) < errorOf(levels[level] ?? rows)) level = index;
    });
  }
  return {
    target,
    k: densityOf(levels[level] ?? levels[0]),
    level,
    close: target >= CLOSE_CSS_PX * resolution,
  };
}

/**
 * Rangées de la variante d'un individu de stature `stature` (en 1/STATURE_UNITS de case) :
 * arrondi(stature / référence × rangées de référence), dans l'étendue [min, max] des
 * variantes de sa classe d'âge. Elle ne dépend ni de la densité ni du zoom : un individu garde
 * sa variante à tout zoom.
 */
export function statureRows(
  stature: number,
  reference: number,
  referenceRows: number,
  range: readonly [number, number],
): number {
  const rows = Math.round((stature / STATURE_UNITS / reference) * referenceRows);
  return Math.min(range[1], Math.max(range[0], rows));
}

/** Motif de base d'une classe d'âge et d'un sexe, à l'image `step` (0 ou 1) de sa marche. */
export function spriteName(age: number, sex: number, step: number): string {
  const kind = AGE_CLASSES[age] ?? 'adult';
  if (kind === 'baby') return `sprites/baby-${String(step)}`;
  if (kind === 'child') return `sprites/child-${String(step)}`;
  return `sprites/adult-${sex === 0 ? 'female' : 'male'}-${String(step)}`;
}

/**
 * Variante de hauteur d'un motif, que l'atlas range quand sa source la demande
 * (tools/pixel-atlas.ts, variantName) : « sprites/adult-male-0@10 ».
 */
export function variantName(name: string, rows: number): string {
  return `${name}@${String(rows)}`;
}

/** Tous les motifs de base que spriteName peut nommer. */
export function spriteNames(): string[] {
  const names = new Set<string>();
  for (let age = 0; age < AGE_CLASSES.length; age++) {
    for (const sex of [0, 1]) for (const step of [0, 1]) names.add(spriteName(age, sex, step));
  }
  return [...names];
}

/** Largeur et hauteur, en pixels. */
export interface Size {
  readonly width: number;
  readonly height: number;
}

/** Un motif de l'atlas, et sa taille. */
export interface NamedSize extends Size {
  readonly name: string;
}

/**
 * Motifs de la bannière d'un groupe vu de loin, du plus petit au plus grand : un même
 * dessin, de 8, 16, 24 et 36 pixels de haut, les plus grands redessinés plus finement
 * (assets/pixel/icons).
 */
export const BANNERS = [
  'icons/group',
  'icons/group-16',
  'icons/group-24',
  'icons/group-36',
] as const;

/** Les bannières de BANNERS, chacune avec sa taille, dans le même ordre. */
export function bannerShapes(
  frameOf: (name: string) => Size,
): readonly [NamedSize, ...NamedSize[]] {
  const shape = (name: string): NamedSize => {
    const { width, height } = frameOf(name);
    return { name, width, height };
  };
  const [smallest, ...larger] = BANNERS;
  return [shape(smallest), ...larger.map(shape)];
}

/** Rangées d'un motif au plus, variantes comprises. */
const MAX_ROWS = 32;

/** Une bannière de la table des motifs : son nom, sa taille et son numéro. */
export interface BannerMotif extends NamedSize {
  readonly motif: number;
}

/**
 * Les motifs que dessine la carte, numérotés : chaque variante de hauteur de chaque motif
 * d'individu, puis les bannières. Une texture recolorée se désigne par ce numéro.
 */
export interface MotifTable {
  readonly names: readonly string[];
  readonly widths: readonly number[];
  readonly heights: readonly number[];
  /** Rangées de l'adulte de référence : la hauteur de la source du motif d'un adulte. */
  readonly referenceRows: number;
  /** Rangées des variantes de chaque classe d'âge (AGE_CLASSES), de la plus basse à la plus haute. */
  readonly ranges: readonly (readonly [number, number])[];
  /** Le plus large et le plus haut des motifs d'individus, en pixels de motif. */
  readonly widest: number;
  readonly tallest: number;
  /** Les bannières, de la plus petite à la plus grande. */
  readonly banners: readonly [BannerMotif, ...BannerMotif[]];
  /** Motif d'une classe d'âge, d'un sexe, d'une image de la marche et d'une hauteur. */
  person(age: number, sex: number, step: number, rows: number): number;
}

/**
 * Table des motifs de l'atlas : `has` dit si un motif existe, `frameOf` donne sa taille. Un
 * motif sans variante de hauteur n'a que la sienne : le nourrisson, aujourd'hui.
 */
export function motifTable(
  has: (name: string) => boolean,
  frameOf: (name: string) => Size,
): MotifTable {
  const names: string[] = [];
  const widths: number[] = [];
  const heights: number[] = [];
  const add = (name: string): number => {
    const known = names.indexOf(name);
    if (known >= 0) return known;
    const { width, height } = frameOf(name);
    names.push(name);
    widths.push(width);
    heights.push(height);
    return names.length - 1;
  };
  const slot = (age: number, sex: number, step: number, rows: number) =>
    ((age * 2 + sex) * 2 + step) * MAX_ROWS + rows;
  const people = new Int16Array(AGE_CLASSES.length * 4 * MAX_ROWS).fill(-1);
  const ranges: [number, number][] = [];
  for (let age = 0; age < AGE_CLASSES.length; age++) {
    let low = MAX_ROWS;
    let high = 0;
    for (const sex of [0, 1]) {
      for (const step of [0, 1]) {
        const base = spriteName(age, sex, step);
        let found = false;
        for (let rows = 1; rows < MAX_ROWS; rows++) {
          const name = variantName(base, rows);
          if (!has(name)) continue;
          found = true;
          people[slot(age, sex, step, rows)] = add(name);
          low = Math.min(low, rows);
          high = Math.max(high, rows);
        }
        if (!found) {
          const motif = add(base);
          const rows = heights[motif] ?? 1;
          people[slot(age, sex, step, rows)] = motif;
          low = Math.min(low, rows);
          high = Math.max(high, rows);
        }
      }
    }
    ranges.push([low, high]);
  }
  const widest = Math.max(...widths);
  const tallest = Math.max(...heights);
  const shapes = BANNERS.map((name): BannerMotif => {
    const motif = add(name);
    return { name, motif, width: widths[motif] ?? 0, height: heights[motif] ?? 0 };
  });
  const smallest = shapes.at(0);
  if (smallest === undefined) throw new Error('aucune bannière');
  return {
    names,
    widths,
    heights,
    referenceRows: frameOf(spriteName(AGE_CODE.adult, 1, 0)).height,
    ranges,
    widest,
    tallest,
    banners: [smallest, ...shapes.slice(1)],
    person(age, sex, step, rows) {
      // Une hauteur qui manque pour ce sexe ou cette image : la plus proche qui existe.
      for (let apart = 0; apart < MAX_ROWS; apart++) {
        for (const candidate of [rows - apart, rows + apart]) {
          if (candidate < 1 || candidate >= MAX_ROWS) continue;
          const motif = people[slot(age, sex & 1, step & 1, candidate)] ?? -1;
          if (motif >= 0) return motif;
        }
      }
      return 0;
    },
  };
}

/**
 * Apparence de chaque membre d'une image des groupes, tirée une fois par image : ses deux
 * motifs de marche, à la variante de sa stature, et le déphasage de sa marche, tiré de son
 * identifiant.
 */
export interface MemberLooks {
  readonly frame: GroupsFrame | undefined;
  /** Motif de chaque membre, image 0 puis image 1 de sa marche. */
  readonly motifs: Uint16Array<ArrayBuffer>;
  /** Rangées de sa variante. */
  readonly rows: Uint8Array<ArrayBuffer>;
  /** Déphasage de sa marche, de 0 à 1. */
  readonly phase: Float64Array<ArrayBuffer>;
  /** Son identifiant écrit, étiquette de son sprite (outils de PixiJS, essais). */
  readonly labels: readonly string[];
}

/**
 * Nombre de 0 à 1 tiré d'un identifiant, sans lien visible d'un identifiant au suivant : le
 * premier tirage de splitmix32 (core/rng.ts) sur cette graine.
 */
function hashUnit(id: number): number {
  return splitmix32(id)() / 2 ** 32;
}

/**
 * L'apparence des membres de `frame` (MemberLooks), d'après leur code d'apparence et leur
 * stature, pour un adulte de référence de `reference` cases.
 */
export function memberLooks(
  frame: GroupsFrame | undefined,
  motifs: MotifTable,
  reference: number,
): MemberLooks {
  const count = frame?.ids.length ?? 0;
  const looks = {
    frame,
    motifs: new Uint16Array(2 * count),
    rows: new Uint8Array(count),
    phase: new Float64Array(count),
    labels: Array.from(frame?.ids ?? [], (id) => String(id)),
  };
  if (frame === undefined) return looks;
  for (let member = 0; member < count; member++) {
    const visual = decodeVisual(frame.sprites[member] ?? 0);
    const rows = statureRows(
      frame.statures[member] ?? 0,
      reference,
      motifs.referenceRows,
      motifs.ranges[visual.age] ?? [motifs.referenceRows, motifs.referenceRows],
    );
    looks.rows[member] = rows;
    looks.motifs[2 * member] = motifs.person(visual.age, visual.sex, 0, rows);
    looks.motifs[2 * member + 1] = motifs.person(visual.age, visual.sex, 1, rows);
    looks.phase[member] = hashUnit(frame.ids[member] ?? 0);
  }
  return looks;
}

/** Hauteur à l'écran, en pixels CSS, que doit atteindre la bannière d'un groupe. */
export const BANNER_CSS_HEIGHT = 12;

/**
 * Pixels physiques par pixel de la carte telle qu'elle se montre à l'échelle `scale`
 * (displayScale) : l'échelle elle-même à partir de 1, où elle procède par paliers entiers
 * (camera.ts) ; en deçà, la carte se lit par ses mipmaps au plus proche, un pixel physique
 * par pixel affiché (map.ts). Les bannières en prennent autant par pixel de leur motif : la
 * carte et ses bannières gardent une seule densité (REN-08).
 */
export function mapPixel(scale: number): number {
  return scale >= 1 ? scale : 1;
}

/**
 * La bannière que montre un groupe vu de loin, parmi `banners`, à `pixel` pixels physiques
 * par pixel de son motif (mapPixel), sur un écran de `resolution` pixels physiques par
 * pixel CSS : la plus petite dont la hauteur à l'écran atteint BANNER_CSS_HEIGHT pixels
 * CSS, sinon la plus grande. La bannière reste ainsi à la densité de la carte : sa
 * lisibilité passe par la taille de son motif, et non par celle de ses pixels. Avec les
 * bannières de BANNERS, elle fait de 12 à 24 pixels CSS de haut aux densités d'écran de 1
 * à 3, à toutes les échelles de la vue lointaine.
 */
export function chooseBanner<T extends Size>(
  banners: readonly [T, ...T[]],
  pixel: number,
  resolution: number,
): T {
  let largest = banners[0];
  let chosen: T | undefined;
  for (const banner of banners) {
    if (banner.height > largest.height) largest = banner;
    const tall = banner.height * pixel >= BANNER_CSS_HEIGHT * resolution;
    if (tall && (chosen === undefined || banner.height < chosen.height)) chosen = banner;
  }
  return chosen ?? largest;
}

/** Valeurs d'apparence distinctes (core/visual.ts : 13 bits). */
const CODES = 2 ** 13;
/** Motifs distincts au plus, dans une clé de texture. */
const MOTIFS = 2 ** 8;

/**
 * Clé d'une texture recolorée, dans le cache du rendu : le motif (MotifTable), le code
 * d'apparence et l'habit, compté comme le premier rang de sa couleur parmi les habits des
 * données, et non comme la culture : deux cultures de même habit partagent leurs textures.
 * C'est un entier exact, plus rapide à chercher qu'une chaîne.
 */
export function textureKey(motif: number, code: number, cloth: number): number {
  return (cloth * MOTIFS + motif) * CODES + code;
}

/** Motif, code d'apparence et habit d'une clé de texture (textureKey). */
export function textureParts(key: number): {
  readonly motif: number;
  readonly code: number;
  readonly cloth: number;
} {
  const code = key % CODES;
  const rest = (key - code) / CODES;
  const motif = rest % MOTIFS;
  return { motif, code, cloth: (rest - motif) / MOTIFS };
}

/** Rectangle de l'écran, en pixels physiques : bords gauche et haut compris, droit et bas exclus. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Nombre de rangs que départage la profondeur : plus que de dessins dans une image. */
const RANKS = 2 ** 20;

/**
 * Profondeur d'un dessin de la carte, individu ou bannière, de rectangle `box` (bords
 * entiers) et de rang `rank` parmi les dessins de l'image (de 0 à RANKS − 1), dans l'ordre
 * où layoutCrowd les dispose : le plus bas à l'écran, d'après ses pieds, passe devant, puis,
 * à pied égal, le dernier disposé. Deux dessins d'une image n'ont jamais la même profondeur.
 * Le nourrisson porté, disposé juste après sa mère et aux mêmes pieds, passe juste devant
 * elle. PeopleLayer dessine dans cet ordre, et pickEntity compare la même valeur.
 */
export function depth(box: Box, rank: number): number {
  return (box.top + box.height) * RANKS + rank;
}

/**
 * Rectangle de la bannière d'un groupe, de `banner` pixels de motif à `pixel` pixels
 * physiques chacun : sa hampe se plante sur le point (x, y) de l'écran.
 */
export function bannerBox(x: number, y: number, banner: Size, pixel: number): Box {
  return {
    left: Math.round(x),
    top: Math.round(y - banner.height * pixel),
    width: banner.width * pixel,
    height: banner.height * pixel,
  };
}

/**
 * Rectangle d'un individu dont les pieds se tiennent au point (x, y) de l'écran : un motif de
 * `width` × `rows` pixels, à `k` pixels physiques par pixel de motif, centré sur ce point
 * arrondi au pixel physique, et posé dessus. Sa taille ne dépend que de sa variante et de la
 * densité de la vue, jamais de la case.
 */
export function personBox(x: number, y: number, width: number, rows: number, k: number): Box {
  return {
    left: Math.round(x) - Math.floor(width / 2) * k,
    top: Math.round(y) - rows * k,
    width: width * k,
    height: rows * k,
  };
}

/** Ce que voit la carte : la caméra, l'écran (pixels physiques), le monde (pixels de carte). */
export interface MapView {
  readonly camera: Camera;
  readonly viewport: Extent;
  readonly world: Extent;
  /** Pixels physiques par pixel CSS. */
  readonly resolution: number;
}

/**
 * Positions des membres d'une image des groupes à un instant, que tient le fil principal
 * (PositionMirror, app/frames.ts) : la disposition ne lit qu'elles.
 */
export interface CrowdSource {
  /** L'image des groupes de l'instant affiché. */
  readonly frame: GroupsFrame | undefined;
  /** Colonnes du monde. */
  readonly width: number;
  readonly groupCount: number;
  /** Étapes appliquées depuis l'image : ce compte change dès qu'une étape change. */
  readonly applied: number;
  /** Rang du premier membre de chaque groupe dans l'image, et son effectif. */
  readonly firsts: Uint32Array<ArrayBuffer>;
  readonly sizes: Uint32Array<ArrayBuffer>;
  /** Rang du porteur de chaque membre porté, −1 pour qui marche. */
  readonly carrierOf: Int32Array<ArrayBuffer>;
  /** Premier porté de chaque membre, et porté suivant de la même mère : −1 au bout. */
  readonly firstCarried: Int32Array<ArrayBuffer>;
  readonly nextCarried: Int32Array<ArrayBuffer>;
  /**
   * Ce que les membres du groupe `group` peuvent atteindre depuis l'image, en unités de
   * core/position.ts, porté compris : l'abscisse d'origine, les écarts horizontaux le plus à
   * l'ouest et le plus à l'est, pris depuis elle, puis les ordonnées du haut et du bas.
   */
  bounds(group: number, out: Float64Array): void;
  /**
   * Positions des membres du groupe `group` à l'instant `t` (jours, fractionnaires), en
   * unités, x ramené dans le monde, à leur rang de l'image dans `xs` et `ys` ; `moving` dit
   * qui est en marche sur une étape à cet instant. Le porté se tient contre sa mère.
   */
  positions(group: number, t: number, xs: Float64Array, ys: Float64Array, moving: Uint8Array): void;
}

/**
 * Où planter la bannière d'un groupe, d'après les positions (en unités) de ses membres de
 * rangs `first` à `first + size − 1` dans `xs` et `ys` : au barycentre de ceux qui ne sont
 * pas portés, les écarts pris au plus court à travers la couture depuis le premier d'entre
 * eux ; si ce point tombe sur une case infranchissable, sur l'eau par exemple, au membre le
 * plus proche de lui. Écrit x (ramené dans le monde) et y dans `out`, en unités.
 */
export function bannerAt(
  xs: Float64Array,
  ys: Float64Array,
  carrierOf: Int32Array,
  first: number,
  size: number,
  width: number,
  passable: (cell: number) => boolean,
  out: Float64Array,
): void {
  let origin = Number.NaN;
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (let member = first; member < first + size; member++) {
    if ((carrierOf[member] ?? -1) >= 0) continue;
    const x = xs[member] ?? 0;
    if (Number.isNaN(origin)) origin = x;
    sumX += deltaFixedX(origin, x, width);
    sumY += ys[member] ?? 0;
    count++;
  }
  if (count === 0) {
    out[0] = xs[first] ?? 0;
    out[1] = ys[first] ?? 0;
    return;
  }
  const bx = wrapFixedX(origin + sumX / count, width);
  const by = sumY / count;
  out[0] = bx;
  out[1] = by;
  if (passable(cellOf(bx, by, width))) return;
  let best = Number.POSITIVE_INFINITY;
  for (let member = first; member < first + size; member++) {
    if ((carrierOf[member] ?? -1) >= 0) continue;
    const dx = deltaFixedX(bx, xs[member] ?? 0, width);
    const dy = (ys[member] ?? 0) - by;
    const distance = dx * dx + dy * dy;
    if (distance < best) {
      best = distance;
      out[0] = xs[member] ?? 0;
      out[1] = ys[member] ?? 0;
    }
  }
}

/**
 * Écart d'un nourrisson porté à sa mère, en unités, sur l'axe est-ouest : du côté que dit son
 * identifiant (carriedSide), à `carry` cases d'elle (display.carry), là où il se posera à son
 * sevrage, comme le calcule le worker.
 */
export function carriedOffset(id: number, carry: number): number {
  return Math.round(carriedSide(id) * carry * FIXED);
}

/** Ce que layoutCrowd doit savoir, outre la vue et l'instant. */
export interface CrowdOptions {
  readonly motifs: MotifTable;
  /** Stature de l'adulte de référence, en cases (display.stature). */
  readonly reference: number;
  /** Habit de chaque culture, compté comme le veut textureKey. */
  readonly cloth: (culture: number) => number;
  /** La case, comptée comme cellIndex, se franchit-elle ? */
  readonly passable: (cell: number) => boolean;
  /**
   * Horloge de la marche, en millisecondes : elle n'avance qu'avec l'instant affiché, et
   * reste donc figée en pause ; `stepMs` est la durée d'une image de la marche.
   */
  readonly walkMs: number;
  readonly stepMs: number;
}

/** Tableau d'entiers agrandi, contenu gardé. */
function grownInt32(array: Int32Array<ArrayBuffer>, length: number): Int32Array<ArrayBuffer> {
  if (array.length >= length) return array;
  const next = new Int32Array(Math.max(length, array.length * 2, 64));
  next.set(array);
  return next;
}

function grownFloat64(array: Float64Array<ArrayBuffer>, length: number): Float64Array<ArrayBuffer> {
  if (array.length >= length) return array;
  const next = new Float64Array(Math.max(length, array.length * 2, 64));
  next.set(array);
  return next;
}

/**
 * Disposition d'une image de la carte : ce qui se dessine, dans l'ordre de dessin, et ce qu'un
 * appui y retrouve. Ses tableaux se gardent d'une image à l'autre.
 */
export class CrowdLayout {
  /** Les individus se voient-ils (vue rapprochée), plutôt que les bannières ? */
  close = false;
  /** Densité de la vue, et pixels physiques par pixel de motif des bannières. */
  density: ViewDensity | undefined;
  bannerPixel = 1;
  /** Image des groupes disposée. */
  frame: GroupsFrame | undefined;
  /** Dessins : rectangles à l'écran, en pixels physiques. */
  count = 0;
  left = new Int32Array(0);
  top = new Int32Array(0);
  width = new Int32Array(0);
  height = new Int32Array(0);
  /** Profondeur de chaque dessin (depth), et les profondeurs rangées, du fond vers l'avant. */
  key = new Float64Array(0);
  sorted = new Float64Array(0);
  /** Rang dans l'image du membre dessiné, −1 pour une bannière ; rang de son groupe. */
  member = new Int32Array(0);
  group = new Int32Array(0);
  /** Texture de chaque dessin (textureKey), et pixels physiques par pixel de son motif. */
  texture = new Float64Array(0);
  unit = new Float64Array(0);
  /** Boîtes des membres dessinés de chaque groupe, une par copie visible du monde. */
  areaCount = 0;
  areaGroup = new Int32Array(0);
  areaLeft = new Float64Array(0);
  areaTop = new Float64Array(0);
  areaRight = new Float64Array(0);
  areaBottom = new Float64Array(0);
  /** Positions des membres des groupes visibles, en unités, et qui est en marche. */
  xs = new Float64Array(0);
  ys = new Float64Array(0);
  moving = new Uint8Array(0);
  /** Membres dont les positions ont été demandées, et groupes visibles. */
  placed = 0;
  visibleGroups = 0;

  /** Une nouvelle disposition, de l'image `frame`. */
  reset(frame: GroupsFrame | undefined): void {
    this.frame = frame;
    this.count = 0;
    this.areaCount = 0;
    this.placed = 0;
    this.visibleGroups = 0;
    const members = frame?.ids.length ?? 0;
    if (this.xs.length < members) {
      this.xs = new Float64Array(members);
      this.ys = new Float64Array(members);
      this.moving = new Uint8Array(members);
    }
  }

  /** Ajoute un dessin, de rectangle (left, top, width, height) ; renvoie son rang. */
  add(
    left: number,
    top: number,
    width: number,
    height: number,
    member: number,
    group: number,
    texture: number,
    unit: number,
  ): number {
    const at = this.count++;
    if (at >= this.left.length) {
      const size = at + 1;
      this.left = grownInt32(this.left, size);
      this.top = grownInt32(this.top, size);
      this.width = grownInt32(this.width, size);
      this.height = grownInt32(this.height, size);
      this.member = grownInt32(this.member, size);
      this.group = grownInt32(this.group, size);
      this.key = grownFloat64(this.key, size);
      this.texture = grownFloat64(this.texture, size);
      this.unit = grownFloat64(this.unit, size);
    }
    this.left[at] = left;
    this.top[at] = top;
    this.width[at] = width;
    this.height[at] = height;
    this.member[at] = member;
    this.group[at] = group;
    this.texture[at] = texture;
    this.unit[at] = unit;
    this.key[at] = (top + height) * RANKS + at;
    return at;
  }

  /** Ajoute la boîte des membres dessinés d'un groupe dans une copie du monde. */
  addArea(group: number, left: number, top: number, right: number, bottom: number): void {
    const at = this.areaCount++;
    if (at >= this.areaGroup.length) {
      this.areaGroup = grownInt32(this.areaGroup, at + 1);
      this.areaLeft = grownFloat64(this.areaLeft, at + 1);
      this.areaTop = grownFloat64(this.areaTop, at + 1);
      this.areaRight = grownFloat64(this.areaRight, at + 1);
      this.areaBottom = grownFloat64(this.areaBottom, at + 1);
    }
    this.areaGroup[at] = group;
    this.areaLeft[at] = left;
    this.areaTop[at] = top;
    this.areaRight[at] = right;
    this.areaBottom[at] = bottom;
  }

  /** Range les dessins par profondeur, du fond vers l'avant (drawn). */
  sort(): void {
    if (this.sorted.length < this.count) this.sorted = new Float64Array(this.key.length);
    const sorted = this.sorted.subarray(0, this.count);
    sorted.set(this.key.subarray(0, this.count));
    sorted.sort();
  }

  /** Rang du i-ième dessin, du fond vers l'avant (après sort). */
  drawn(index: number): number {
    const key = this.sorted[index] ?? 0;
    return ((key % RANKS) + RANKS) % RANKS;
  }

  /** Rectangle d'un dessin. */
  box(index: number): Box {
    return {
      left: this.left[index] ?? 0,
      top: this.top[index] ?? 0,
      width: this.width[index] ?? 0,
      height: this.height[index] ?? 0,
    };
  }
}

/**
 * Boîte des membres dessinés d'un groupe, de rang `area` parmi celles de la disposition,
 * élargie de `margin` pixels physiques de chaque côté : un appui qui y tombe sans toucher
 * personne désigne le groupe.
 */
export function groupArea(layout: CrowdLayout, area: number, margin: number): Box {
  const left = (layout.areaLeft[area] ?? 0) - margin;
  const top = (layout.areaTop[area] ?? 0) - margin;
  return {
    left,
    top,
    width: (layout.areaRight[area] ?? 0) + margin - left,
    height: (layout.areaBottom[area] ?? 0) + margin - top,
  };
}

/** Une étendue de l'écran touche-t-elle l'écran, à un pixel près ? */
function touches(left: number, top: number, right: number, bottom: number, viewport: Extent) {
  return right > -1 && left < viewport.width + 1 && bottom > -1 && top < viewport.height + 1;
}

/** Valeurs de CrowdSource.bounds, réutilisées. */
const bounded = new Float64Array(5);
/** Point où se plante une bannière, réutilisé. */
const planted = new Float64Array(2);

/**
 * Dispose l'image de l'instant `t` (jours, fractionnaires) telle que la vue `view` la
 * montre : de près, chaque individu des groupes visibles, à sa position, à sa variante et à
 * la densité de la vue ; de loin, la bannière de chaque groupe visible. Seuls les groupes que
 * l'écran peut montrer, d'après ce que leurs membres peuvent atteindre (CrowdSource.bounds),
 * demandent leurs positions. Quand le monde est plus étroit que l'écran, chacun se voit dans
 * chacune des copies visibles (monde cylindrique). Reste à ranger les dessins par profondeur
 * (CrowdLayout.sort), avant de les dessiner : PeopleLayer mesure ce tri à part.
 */
export function layoutCrowd(
  layout: CrowdLayout,
  source: CrowdSource,
  looks: MemberLooks,
  view: MapView,
  t: number,
  options: CrowdOptions,
): void {
  const frame = source.frame;
  layout.reset(frame);
  if (frame === undefined) return;
  const { camera, viewport, world, resolution } = view;
  const { motifs, walkMs, stepMs } = options;
  const width = source.width;
  const scale = displayScale(camera.zoom);
  const density = viewDensity(scale, resolution, options.reference, [motifs.referenceRows]);
  const close = density.close;
  const k = density.k;
  const pixel = mapPixel(scale);
  const banner = chooseBanner(motifs.banners, pixel, resolution);
  layout.close = close;
  layout.density = density;
  layout.bannerPixel = pixel;
  const span = world.width * scale;
  const halfWidth = viewport.width / 2;
  const halfHeight = viewport.height / 2;
  // Ce qui dépasse d'une position, en pixels physiques : un individu, centré, au-dessus de ses
  // pieds ; une bannière, à droite de sa hampe et au-dessus.
  const reachLeft = close ? Math.ceil(motifs.widest / 2) * k + 1 : 1;
  const reachRight = close ? Math.ceil(motifs.widest / 2) * k + 1 : banner.width * pixel + 1;
  const reachUp = close ? motifs.tallest * k + 1 : banner.height * pixel + 1;
  const unitToScreen = (TILE_PX * scale) / FIXED;
  const { xs, ys, moving } = layout;
  const { carrierOf, firstCarried, nextCarried } = source;
  const groups = frame.groups;
  for (let group = 0; group < source.groupCount; group++) {
    const first = source.firsts[group] ?? 0;
    const size = source.sizes[group] ?? 0;
    if (size === 0 && close) continue;
    let originX: number;
    let fromX: number;
    let toX: number;
    let fromY: number;
    let toY: number;
    if (size === 0) {
      // Un groupe sans membre : sa bannière au centre de sa case.
      originX = ((groups[group * GROUP_STRIDE + 1] ?? 0) + 0.5) * FIXED;
      fromX = toX = 0;
      fromY = toY = ((groups[group * GROUP_STRIDE + 2] ?? 0) + 0.5) * FIXED;
    } else {
      source.bounds(group, bounded);
      originX = bounded[0];
      fromX = bounded[1];
      toX = bounded[2];
      fromY = bounded[3];
      toY = bounded[4];
    }
    // L'origin dans la copie du monde la plus proche de la caméra, à l'écran.
    const originMap = (originX / FIXED) * TILE_PX;
    const shift = Math.round((camera.x - originMap) / world.width) * world.width;
    const originScreen = (originMap + shift - camera.x) * scale + halfWidth;
    const top = (fromY / FIXED) * TILE_PX - camera.y;
    const screenTop = top * scale + halfHeight - reachUp;
    const screenBottom = ((toY / FIXED) * TILE_PX - camera.y) * scale + halfHeight + 1;
    const screenLeft = originScreen + fromX * unitToScreen - reachLeft;
    const screenRight = originScreen + toX * unitToScreen + reachRight;
    const copies = Math.ceil((viewport.width + screenRight - screenLeft) / span) + 1;
    let seen = false;
    for (let copy = -copies; copy <= copies; copy++) {
      const offset = copy * span;
      if (!touches(screenLeft + offset, screenTop, screenRight + offset, screenBottom, viewport)) {
        continue;
      }
      if (!seen) {
        seen = true;
        layout.visibleGroups++;
        if (size > 0) {
          source.positions(group, t, xs, ys, moving);
          layout.placed += size;
        }
      }
      const cloth = options.cloth(groups[group * GROUP_STRIDE + 4] ?? 1);
      const base = originScreen + offset;
      if (!close) {
        if (size === 0) {
          planted[0] = originX;
          planted[1] = fromY;
        } else {
          bannerAt(xs, ys, carrierOf, first, size, width, options.passable, planted);
        }
        const x = base + deltaFixedX(originX, planted[0], width) * unitToScreen;
        const y = (planted[1] / FIXED) * TILE_PX * scale - camera.y * scale + halfHeight;
        const box = bannerBox(x, y, banner, pixel);
        if (touches(box.left, box.top, box.left + box.width, box.top + box.height, viewport)) {
          layout.add(
            box.left,
            box.top,
            box.width,
            box.height,
            -1,
            group,
            textureKey(banner.motif, 0, cloth),
            pixel,
          );
        }
        continue;
      }
      let areaLeft = Number.POSITIVE_INFINITY;
      let areaTop = Number.POSITIVE_INFINITY;
      let areaRight = Number.NEGATIVE_INFINITY;
      let areaBottom = Number.NEGATIVE_INFINITY;
      // Chaque membre qui marche, puis ses nourrissons : disposés juste après elle, aux
      // mêmes pieds, ils passent juste devant elle.
      for (let index = first; index < first + size; index++) {
        if ((carrierOf[index] ?? -1) >= 0) continue;
        let member = index;
        while (member >= 0) {
          // L'image de la marche : une alternance toutes les `stepMs`, déphasée par son
          // identifiant, à l'horloge de la marche du rendu, et non au fil des jours, qui
          // scintillerait à ×16 ; la première image hors d'une étape.
          const step =
            (moving[member] ?? 0) === 1
              ? Math.floor(walkMs / stepMs + (looks.phase[member] ?? 0) * 2) % 2
              : 0;
          const motif = looks.motifs[2 * member + step] ?? 0;
          const motifWidth = motifs.widths[motif] ?? 0;
          const rows = motifs.heights[motif] ?? 0;
          const x = base + deltaFixedX(originX, xs[member] ?? 0, width) * unitToScreen;
          const y = (ys[member] ?? 0) * unitToScreen - camera.y * scale + halfHeight;
          const left = Math.round(x) - Math.floor(motifWidth / 2) * k;
          const boxTop = Math.round(y) - rows * k;
          const right = left + motifWidth * k;
          const bottom = boxTop + rows * k;
          if (touches(left, boxTop, right, bottom, viewport)) {
            const texture = textureKey(motif, frame.sprites[member] ?? 0, cloth);
            layout.add(left, boxTop, motifWidth * k, rows * k, member, group, texture, k);
            if (left < areaLeft) areaLeft = left;
            if (boxTop < areaTop) areaTop = boxTop;
            if (right > areaRight) areaRight = right;
            if (bottom > areaBottom) areaBottom = bottom;
          }
          member = member === index ? (firstCarried[index] ?? -1) : (nextCarried[member] ?? -1);
        }
      }
      if (areaRight > areaLeft) layout.addArea(group, areaLeft, areaTop, areaRight, areaBottom);
    }
  }
}

/** Écart d'un point à un rectangle, en pixels physiques : 0 dedans ou sur son bord. */
function gap(box: Box, x: number, y: number): number {
  const dx = Math.max(box.left - x, 0, x - (box.left + box.width));
  const dy = Math.max(box.top - y, 0, y - (box.top + box.height));
  return Math.max(dx, dy);
}

/** Ce qu'un appui désigne sur la carte : un individu ou un groupe. */
export type Picked =
  | { readonly kind: 'person'; readonly id: number }
  | { readonly kind: 'group'; readonly id: number };

/**
 * Tolérance d'un appui autour d'un dessin, en pixels CSS : 4 pour un pointeur fin, souris ou
 * stylet, et 12 pour le doigt, qui couvre plus qu'un pixel.
 */
export const POINTER_SLOP = 4;
export const FINGER_SLOP = 12;

/**
 * Ce qu'un appui au point (x, y) de l'écran (pixels physiques) désigne dans la disposition
 * `layout` : on touche ce qu'on voit. Un individu touché, ou frôlé à `slop` pixels physiques
 * au plus ; à égalité d'écart, celui de devant (depth). De loin, une bannière, de même. Faute
 * de dessin touché, de près, un appui dans la boîte des membres d'un groupe, élargie de
 * `slop` (groupArea), désigne ce groupe, et, si plusieurs boîtes le contiennent, celui dont un
 * membre est le plus proche. Sinon, rien : l'appui désigne la case.
 */
export function pickEntity(
  layout: CrowdLayout,
  x: number,
  y: number,
  slop: number,
): Picked | undefined {
  const frame = layout.frame;
  if (frame === undefined) return undefined;
  let best = -1;
  let bestGap = Number.POSITIVE_INFINITY;
  let bestFront = Number.NEGATIVE_INFINITY;
  // Écart de l'appui au membre le plus proche de chaque groupe, pour départager les boîtes.
  const nearest = new Map<number, number>();
  for (let index = 0; index < layout.count; index++) {
    const distance = gap(layout.box(index), x, y);
    const group = layout.group[index] ?? 0;
    nearest.set(group, Math.min(nearest.get(group) ?? Number.POSITIVE_INFINITY, distance));
    if (distance > slop) continue;
    const front = layout.key[index] ?? 0;
    if (distance < bestGap || (distance === bestGap && front > bestFront)) {
      best = index;
      bestGap = distance;
      bestFront = front;
    }
  }
  const groupId = (group: number) => frame.groups[group * GROUP_STRIDE] ?? 0;
  if (best >= 0) {
    const member = layout.member[best] ?? -1;
    return member >= 0
      ? { kind: 'person', id: frame.ids[member] ?? 0 }
      : { kind: 'group', id: groupId(layout.group[best] ?? 0) };
  }
  let chosen = -1;
  let chosenGap = Number.POSITIVE_INFINITY;
  for (let area = 0; area < layout.areaCount; area++) {
    if (gap(groupArea(layout, area, slop), x, y) > 0) continue;
    const group = layout.areaGroup[area] ?? 0;
    const distance = nearest.get(group) ?? Number.POSITIVE_INFINITY;
    if (distance < chosenGap) {
      chosen = group;
      chosenGap = distance;
    }
  }
  return chosen >= 0 ? { kind: 'group', id: groupId(chosen) } : undefined;
}
