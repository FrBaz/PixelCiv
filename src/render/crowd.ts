/**
 * Individus et groupes sur la carte (tâches 2.9, 2b.2, 2b.3 et 2b.5 ; REN-03, REN-04, REN-08 ;
 * ADR 0013, ADR 0014, ADR 0016) : ce que la carte dessine de chacun, où, à quelle taille, dans
 * quel ordre, et ce qu'un appui y désigne. Fonctions pures, sans PixiJS : PeopleLayer dessine
 * la disposition qu'elles calculent (layoutCrowd), et pickEntity y retrouve ce qu'on touche.
 *
 * - De près, chaque individu se tient à sa position, une variable de la simulation que le fil
 *   principal interpole entre deux jours sur les étapes du worker (app/frames.ts) : ni grappe,
 *   ni grille de case ou de pixel de carte. Ses pieds se posent sur sa position, arrondie au
 *   pixel physique.
 * - C'est un humain des planches (2b.5, src/render/humans.ts) : son corps (sexe, ou taille
 *   d'enfant, ou nourrisson), à la variante de hauteur la plus proche de sa stature au niveau de
 *   la vue (quel que soit k, mais d'un niveau à l'autre, l'arrondi peut changer d'une rangée), et
 *   à l'image de son animation (la marche quand il avance, le repos sinon) ; la vue choisit
 *   un niveau de motifs et une densité entière k, les mêmes pour tous ses individus
 *   (viewDensity). Une vue ne mêle donc jamais deux densités d'individus, et un pixel de motif
 *   y fait k × k pixels physiques. Tourné vers l'ouest dans la planche, il se retourne pour
 *   aller vers l'est.
 * - Le nourrisson porté se dessine contre sa mère, juste devant elle, tourné comme elle, et marche
 *   avec elle, du même pas, quand elle marche.
 * - De loin, la bannière de chaque groupe, à la densité de la carte, au barycentre de ses
 *   membres, ou au membre le plus proche si ce point tombe sur l'eau (bannerAt).
 * - Le plus bas à l'écran passe devant, d'après les pieds, puis le dernier disposé (depth).
 */
import { GROUP_STRIDE, type GroupsFrame } from '../core/protocol';
import { carriedSide, cellOf, deltaFixedX, FIXED, wrapFixedX } from '../core/position';
import { splitmix32 } from '../core/rng';
import { decodeVisual } from '../core/visual';
import { displayScale, TILE_PX, type Camera, type Extent } from './camera';

/**
 * Hauteur à l'écran, en pixels CSS, que doit viser l'adulte de référence pour que les
 * individus se voient : à partir du zoom 3 à la densité 1, et du zoom 2,9 sur Pixel 5.
 */
export const CLOSE_CSS_PX = 8;

/**
 * Un niveau de motifs se prend dès que son adulte de référence, à un pixel physique par pixel
 * de motif, ne dépasse pas LEVEL_SPAN fois la cible : la règle ne dépend que de la cible, si
 * bien que le détail ne recule jamais quand on zoome (2b.5, ADR 0016). Avec des niveaux espacés
 * d'un facteur LEVEL_STEP (1,5) au plus, ce que le schéma de data/humans.json impose, k =
 * arrondi(cible / rangées) tient la taille à 25 % de la cible, sauf au plus grossier, faute de
 * plus petit, et quand la planche passe d'un pixel physique par pixel de motif à deux, faute de
 * plus fin (jusqu'à un tiers).
 */
export const LEVEL_SPAN = 1.25;

/**
 * L'espacement le plus grand de deux niveaux de motifs qui se suivent, dont dépend la règle du
 * choix du niveau (viewDensity) : le schéma de data/humans.json refuse des niveaux plus espacés.
 */
export { LEVEL_STEP } from '../core/data/humans';

/** Unités de stature par case : le worker l'envoie en 1/128 de case (ADR 0014). */
export const STATURE_UNITS = 128;

/** Densité et niveau de détail d'une vue (ADR 0014, § 6). */
export interface ViewDensity {
  /** Hauteur que vise l'adulte de référence, en pixels physiques, avant arrondi. */
  readonly target: number;
  /** Pixels physiques par pixel de motif des individus, le même pour tous : k ≥ 1. */
  readonly k: number;
  /** Niveau de motifs choisi : son rang dans `levels`, 0 pour la planche à sa taille. */
  readonly level: number;
  /** Les individus se voient-ils, plutôt que les bannières ? */
  readonly close: boolean;
}

/**
 * Densité de la vue à l'échelle `scale` (displayScale, pixels physiques par pixel de carte),
 * sur un écran de `resolution` pixels physiques par pixel CSS, pour un adulte de référence de
 * `reference` cases (display.stature) : il vise reference × TILE_PX × scale pixels
 * physiques. `levels` donne les rangées de l'adulte de référence de chaque niveau de motifs,
 * du plus fin au plus grossier : la vue prend le plus fin dont les rangées ne dépassent pas
 * LEVEL_SPAN fois la cible, sinon le plus grossier, et k = arrondi(cible / rangées), au moins
 * 1. La vue rapprochée commence quand la cible atteint CLOSE_CSS_PX pixels CSS.
 */
export function viewDensity(
  scale: number,
  resolution: number,
  reference: number,
  levels: readonly [number, ...number[]],
): ViewDensity {
  const target = reference * TILE_PX * scale;
  const densityOf = (rows: number) => Math.max(1, Math.round(target / rows));
  let level = levels.findIndex((rows) => rows <= target * LEVEL_SPAN);
  if (level < 0) level = levels.length - 1;
  return {
    target,
    k: densityOf(levels[level] ?? levels[0]),
    level,
    close: target >= CLOSE_CSS_PX * resolution,
  };
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

/** Une bannière de la table des motifs : son nom, sa taille et son numéro. */
export interface BannerMotif extends NamedSize {
  readonly motif: number;
}

/**
 * Les motifs pixel art que dessine la carte, numérotés : les bannières (assets/pixel/icons).
 * Une texture recolorée se désigne par ce numéro (textureKey). Les individus sont des humains
 * des planches, que dessine le shader de PeopleLayer (HumanTable).
 */
export interface MotifTable {
  readonly names: readonly string[];
  readonly widths: readonly number[];
  readonly heights: readonly number[];
  /** Les bannières, de la plus petite à la plus grande. */
  readonly banners: readonly [BannerMotif, ...BannerMotif[]];
}

/** Table des motifs de l'atlas pixel art : `frameOf` donne la taille d'un motif. */
export function motifTable(frameOf: (name: string) => Size): MotifTable {
  const names: string[] = [];
  const widths: number[] = [];
  const heights: number[] = [];
  const shapes = BANNERS.map((name): BannerMotif => {
    const { width, height } = frameOf(name);
    names.push(name);
    widths.push(width);
    heights.push(height);
    return { name, motif: names.length - 1, width, height };
  });
  const smallest = shapes.at(0);
  if (smallest === undefined) throw new Error('aucune bannière');
  return { names, widths, heights, banners: [smallest, ...shapes.slice(1)] };
}

/**
 * Apparence de chaque membre d'une image des groupes : son corps, sa stature sur celle de
 * l'adulte de référence, l'apparence de sa palette (lookCode, src/render/humans.ts) et le
 * déphasage de son animation, tiré de son identifiant. Elle se tire groupe par groupe, une fois
 * par image, à la première qui montre ses membres de près (lookGroup) : les groupes hors de
 * l'écran ne coûtent rien.
 */
export interface MemberLooks {
  readonly frame: GroupsFrame | undefined;
  readonly humans: HumanTable;
  /** Stature de l'adulte de référence, en cases. */
  readonly reference: number;
  readonly body: Uint8Array<ArrayBuffer>;
  readonly ratio: Float32Array<ArrayBuffer>;
  readonly look: Uint16Array<ArrayBuffer>;
  /** Déphasage de son animation, de 0 à 1. */
  readonly phase: Float64Array<ArrayBuffer>;
  /** Groupes, par rang, dont l'apparence des membres est tirée (1). */
  readonly ready: Uint8Array<ArrayBuffer>;
  /** Tissu de la bannière de chaque groupe, par rang, tiré à sa première vue de loin (−1 avant). */
  readonly banner: Int32Array<ArrayBuffer>;
}

/**
 * Les humains des planches, vus de la disposition (src/render/humans.ts) : niveaux de motifs,
 * motifs de chaque corps, niveau, variante et animation, et leur taille.
 */
export interface HumanTable {
  /** Rangées de l'adulte de référence de chaque niveau, du plus fin au plus grossier. */
  readonly levels: readonly [number, ...number[]];
  /** Le plus large et le plus haut des motifs de chaque niveau, en pixels de motif. */
  readonly widest: readonly number[];
  readonly tallest: readonly number[];
  /** Largeur, hauteur et abscisse des pieds de chaque motif. */
  readonly width: ArrayLike<number>;
  readonly height: ArrayLike<number>;
  readonly anchor: ArrayLike<number>;
  bodyOf(sex: number, age: number, ratio: number): number;
  variantOf(body: number, level: number, ratio: number): number;
  firstMotif(body: number, level: number, variant: number, animation: number): number;
  animationOf(moving: boolean): number;
  frame(animation: number, clockMs: number, stepMs: number, phase: number): number;
  /** Apparence de la palette d'un membre (lookCode), de son code d'apparence, de son corps et de sa culture. */
  look(code: number, body: number, culture: number): number;
}

/**
 * Nombre de 0 à 1 tiré d'un identifiant, sans lien visible d'un identifiant au suivant : le
 * premier tirage de splitmix32 (core/rng.ts) sur cette graine.
 */
function hashUnit(id: number): number {
  return splitmix32(id)() / 2 ** 32;
}

/**
 * L'apparence des membres de `frame` (MemberLooks), pour un adulte de référence de
 * `reference` cases : rien n'en est encore tiré.
 */
export function memberLooks(
  frame: GroupsFrame | undefined,
  humans: HumanTable,
  reference: number,
): MemberLooks {
  const count = frame?.ids.length ?? 0;
  return {
    frame,
    humans,
    reference,
    body: new Uint8Array(count),
    ratio: new Float32Array(count),
    look: new Uint16Array(count),
    phase: new Float64Array(count),
    ready: new Uint8Array(Math.floor((frame?.groups.length ?? 0) / GROUP_STRIDE)),
    banner: new Int32Array(Math.floor((frame?.groups.length ?? 0) / GROUP_STRIDE)).fill(-1),
  };
}

/**
 * Tire, s'il ne l'est pas encore, l'apparence des membres du groupe de rang `group`, du
 * rang `first` au rang `first + size` : d'après leur code d'apparence et leur stature.
 */
export function lookGroup(looks: MemberLooks, group: number, first: number, size: number): void {
  const { frame, reference, humans } = looks;
  if (frame === undefined || looks.ready[group] !== 0) return;
  looks.ready[group] = 1;
  const culture = frame.groups[group * GROUP_STRIDE + 4] ?? 1;
  for (let member = first; member < first + size; member++) {
    const code = frame.sprites[member] ?? 0;
    const visual = decodeVisual(code);
    const ratio = (frame.statures[member] ?? 0) / STATURE_UNITS / reference;
    const body = humans.bodyOf(visual.sex, visual.age, ratio);
    looks.ratio[member] = ratio;
    looks.body[member] = body;
    looks.look[member] = humans.look(code, body, culture);
    looks.phase[member] = hashUnit(frame.ids[member] ?? 0);
  }
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

/** Motifs distincts au plus, dans une clé de texture. */
const MOTIFS = 2 ** 8;

/**
 * Clé d'une texture recolorée de bannière, dans le cache du rendu : le motif (MotifTable) et le
 * tissu qui la colore, compté comme son rang dans data/appearance.json, et non comme la
 * culture : deux cultures dont la tenue commence par le même tissu partagent leurs textures.
 * C'est un entier exact, plus rapide à chercher qu'une chaîne.
 */
export function textureKey(motif: number, cloth: number): number {
  return cloth * MOTIFS + motif;
}

/** Motif et tissu d'une clé de texture (textureKey). */
export function textureParts(key: number): { readonly motif: number; readonly cloth: number } {
  const motif = key % MOTIFS;
  return { motif, cloth: (key - motif) / MOTIFS };
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
 * `width` × `rows` pixels, dont les pieds sont à `foot` pixels de son bord gauche, à `k` pixels
 * physiques par pixel de motif, posé sur ce point arrondi au pixel physique. Retourné vers
 * l'est (`east`), le motif se lit en miroir : ses pieds sont à `foot` pixels de son bord droit.
 * Sa taille ne dépend que de son motif et de la densité de la vue, jamais de la case.
 */
export function personBox(
  x: number,
  y: number,
  width: number,
  rows: number,
  foot: number,
  k: number,
  east: boolean,
): Box {
  return {
    left: Math.round(x) - (east ? width - foot : foot) * k,
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
   * qui est en marche sur une étape à cet instant. Le porté se tient contre sa mère. `facing`
   * reçoit le sens de chacun qui marche : celui du pas horizontal de son étape en cours ou de
   * la dernière qu'on lui connaît, gardé d'une image des groupes à l'autre, −1 vers l'ouest,
   * 1 vers l'est, 0 sans étape connue.
   */
  positions(
    group: number,
    t: number,
    xs: Float64Array,
    ys: Float64Array,
    moving: Uint8Array,
    facing?: Int8Array,
  ): void;
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
  /**
   * Tissu de la bannière d'un groupe de la culture `culture`, dont les membres ont pour codes
   * d'apparence codes[first … first + size) : celui que porte le plus grand nombre d'entre eux,
   * compté comme le veut textureKey.
   */
  readonly cloth: (
    culture: number,
    codes: ArrayLike<number>,
    first: number,
    size: number,
  ) => number;
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
  /**
   * Ce que montre chaque dessin : pour un individu, son motif de l'atlas des humains et
   * l'apparence de sa palette (lookCode) ; pour une bannière, sa texture (textureKey), et −1.
   * Puis les pixels physiques par pixel de son motif, négatifs pour un motif retourné.
   */
  texture = new Float64Array(0);
  look = new Int32Array(0);
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
  /** Sens de chacun : −1 vers l'ouest, 1 vers l'est, 0 sans étape connue (CrowdSource). */
  facing = new Int8Array(0);
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
      this.facing = new Int8Array(members);
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
    look: number,
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
      this.look = grownInt32(this.look, size);
      this.unit = grownFloat64(this.unit, size);
    }
    this.left[at] = left;
    this.top[at] = top;
    this.width[at] = width;
    this.height[at] = height;
    this.member[at] = member;
    this.group[at] = group;
    this.texture[at] = texture;
    this.look[at] = look;
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
  const { humans } = looks;
  const width = source.width;
  const scale = displayScale(camera.zoom);
  const density = viewDensity(scale, resolution, options.reference, humans.levels);
  const close = density.close;
  const k = density.k;
  const level = density.level;
  const pixel = mapPixel(scale);
  const banner = chooseBanner(motifs.banners, pixel, resolution);
  layout.close = close;
  layout.density = density;
  layout.bannerPixel = pixel;
  const span = world.width * scale;
  const halfWidth = viewport.width / 2;
  const halfHeight = viewport.height / 2;
  // Ce qui dépasse d'une position, en pixels physiques : un individu, au-dessus de ses pieds,
  // qui ne sont pas au milieu de son motif et qui peut se retourner, au plus de la largeur du
  // plus large motif du niveau de chaque côté ; une bannière, à droite de sa hampe et au-dessus.
  const widest = humans.widest[level] ?? 1;
  const reachLeft = close ? widest * k + 1 : 1;
  const reachRight = close ? widest * k + 1 : banner.width * pixel + 1;
  const reachUp = close ? (humans.tallest[level] ?? 1) * k + 1 : banner.height * pixel + 1;
  const unitToScreen = (TILE_PX * scale) / FIXED;
  const { xs, ys, moving, facing } = layout;
  const { carrierOf, firstCarried, nextCarried } = source;
  const groups = frame.groups;
  const resting = humans.animationOf(false);
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
          source.positions(group, t, xs, ys, moving, facing);
          layout.placed += size;
          if (close) lookGroup(looks, group, first, size);
        }
      }
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
          let cloth = looks.banner[group] ?? -1;
          if (cloth < 0) {
            const culture = groups[group * GROUP_STRIDE + 4] ?? 1;
            cloth = options.cloth(culture, looks.frame?.sprites ?? [], first, size);
            looks.banner[group] = cloth;
          }
          layout.add(
            box.left,
            box.top,
            box.width,
            box.height,
            -1,
            group,
            textureKey(banner.motif, cloth),
            -1,
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
        // Le sens du porteur, que prennent ses portés : celui de sa marche, gardé à l'arrêt
        // (CrowdSource.positions) ; sans étape connue, celui que dit son identifiant.
        const sense = facing[index] ?? 0;
        const east = sense > 0 || (sense === 0 && (looks.phase[index] ?? 0) >= 0.5);
        let member = index;
        // L'animation du porteur, et son déphasage, que prennent ses portés : un nourrisson
        // contre sa mère qui marche marche avec elle, du même pas, au lieu de glisser au repos.
        const walking = (moving[index] ?? 0) === 1;
        const pace = looks.phase[index] ?? 0;
        while (member >= 0) {
          // Son corps, sa variante au niveau de la vue, et l'image de son animation à
          // l'horloge de la marche du rendu, figée en pause.
          const body = looks.body[member] ?? 0;
          const ratio = looks.ratio[member] ?? 1;
          const variant = humans.variantOf(body, level, ratio);
          let animation = humans.animationOf(walking);
          let start = humans.firstMotif(body, level, variant, animation);
          if (start < 0) {
            animation = resting;
            start = Math.max(0, humans.firstMotif(body, level, variant, animation));
          }
          const motif = start + humans.frame(animation, walkMs, stepMs, pace);
          const motifWidth = humans.width[motif] ?? 1;
          const rows = humans.height[motif] ?? 1;
          const x = base + deltaFixedX(originX, xs[member] ?? 0, width) * unitToScreen;
          const y = (ys[member] ?? 0) * unitToScreen - camera.y * scale + halfHeight;
          const box = personBox(x, y, motifWidth, rows, humans.anchor[motif] ?? 0, k, east);
          const right = box.left + box.width;
          const bottom = box.top + box.height;
          if (touches(box.left, box.top, right, bottom, viewport)) {
            layout.add(
              box.left,
              box.top,
              box.width,
              box.height,
              member,
              group,
              motif,
              looks.look[member] ?? 0,
              east ? -k : k,
            );
            if (box.left < areaLeft) areaLeft = box.left;
            if (box.top < areaTop) areaTop = box.top;
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
