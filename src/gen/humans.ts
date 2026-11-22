/**
 * Humains des planches (tâche 2b.5, ADR 0016), en fonctions pures : des pixels d'une planche de
 * base et des grilles de régions, une image de rôles par image d'animation ; ses réductions,
 * sans couleur nouvelle ; et les enfants et nourrissons composés d'un corps d'adulte, la tête
 * réduite moins que le corps. Le build les range dans un atlas (tools/human-atlas.ts) ; le
 * rendu les recolore (src/render/humans.ts). Les régions, leurs lettres et les tons de la base
 * viennent de data/humans.json, que l'appelant passe : ce module n'importe rien, car
 * l'extension de Vite qui range l'atlas le charge avec la configuration.
 *
 * Rôle d'un pixel, sur un octet :
 *   0                 transparent
 *   1 à 15            ton gardé tel quel : les contours, puis les yeux, puis les autres traits,
 *                     dans l'ordre de data/humans.json (KEPT + rang, keptTones)
 *   16 + 8r + 4s + t  pixel recolorable de la région r (son rang dans data/humans.json), de
 *                     source s (0 la peau, 1 le sous-vêtement) et de rang t (0 la lumière à 3
 *                     l'ombre profonde)
 */

/** Premier rôle des tons gardés, et premier rôle recolorable (core/data/humans.ts, bornes). */
export const KEPT = 1;
export const RECOLOR = 16;

export function recolorRole(region: number, source: number, rank: number): number {
  return RECOLOR + region * 8 + source * 4 + rank;
}

export function roleParts(role: number): { region: number; source: number; rank: number } {
  const value = role - RECOLOR;
  return { region: value >> 3, source: (value >> 2) & 1, rank: value & 3 };
}

/** Une image de rôles : largeur, hauteur, un octet par pixel, et le point des pieds. */
export interface RoleImage {
  readonly width: number;
  readonly height: number;
  readonly roles: Uint8Array;
  /** Point des pieds, en pixels de l'image : au milieu du bas de la case d'origine. */
  readonly anchorX: number;
  readonly anchorY: number;
}

/** Tons de la base (data/humans.json, tones), en #rrggbb. */
export interface BaseTones {
  readonly outline: readonly string[];
  readonly eye: readonly string[];
  readonly kept: readonly string[];
  readonly skin: readonly string[];
  readonly under: readonly string[];
  readonly skinAlso: Readonly<Record<string, number>>;
  readonly underAlso: Readonly<Record<string, number>>;
}

function hex(r: number, g: number, b: number): string {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** Ce qu'est un ton de la base : gardé (rôle), ou peau ou sous-vêtement d'un rang. */
export type ToneKind =
  | { readonly kind: 'kept'; readonly role: number }
  | { readonly kind: 'skin' | 'under'; readonly rank: number };

/** Les tons gardés, dans l'ordre de leur rôle (KEPT + rang) : contours, yeux, autres traits. */
export function keptTones(tones: BaseTones): string[] {
  return [...tones.outline, ...tones.eye, ...tones.kept];
}

/** Rôles des contours, et des yeux, que les réductions traitent à part. */
export function outlineRoles(tones: BaseTones): number[] {
  return tones.outline.map((_, index) => KEPT + index);
}

export function eyeRoles(tones: BaseTones): number[] {
  return tones.eye.map((_, index) => KEPT + tones.outline.length + index);
}

export function toneKinds(tones: BaseTones): ReadonlyMap<string, ToneKind> {
  const kinds = new Map<string, ToneKind>();
  keptTones(tones).forEach((color, index) => {
    kinds.set(color, { kind: 'kept', role: KEPT + index });
  });
  tones.skin.forEach((color, rank) => kinds.set(color, { kind: 'skin', rank }));
  tones.under.forEach((color, rank) => kinds.set(color, { kind: 'under', rank }));
  for (const [color, rank] of Object.entries(tones.skinAlso)) {
    kinds.set(color, { kind: 'skin', rank });
  }
  for (const [color, rank] of Object.entries(tones.underAlso)) {
    kinds.set(color, { kind: 'under', rank });
  }
  return kinds;
}

/** Grilles de régions d'une animation : une grille par image, en lignes de la case entière. */
export interface RegionGrids {
  readonly frames: readonly (readonly string[])[];
}

/**
 * Lit une grille de régions (assets/humans/regions/<sexe>/<animation>.txt) : « # case x0 y0 »,
 * puis un bloc par image, après « # image N », qui couvre la case à partir de (x0, y0), une
 * lettre de `letters` par pixel de peau ou de sous-vêtement, « o » pour un ton gardé, « . »
 * pour le transparent. Rend chaque image en lignes de toute la case, « . » hors du bloc.
 */
export function parseRegionGrids(
  name: string,
  text: string,
  cellWidth: number,
  cellHeight: number,
  letters: string,
): RegionGrids {
  const allowed = new Set(['.', 'o', ...letters.split('')]);
  let x0 = -1;
  let y0 = -1;
  const blocks = new Map<number, string[]>();
  let current: string[] | undefined;
  text
    .replace(/^\uFEFF/u, '')
    .split(/\r?\n/u)
    .forEach((raw, index) => {
      const line = raw.trimEnd();
      const where = `${name}, ligne ${String(index + 1)}`;
      const box = /^#\s*case\s+(\d+)\s+(\d+)\s*$/u.exec(line);
      const image = /^#\s*image\s+(\d+)\s*$/u.exec(line);
      if (box !== null) {
        x0 = Number(box[1]);
        y0 = Number(box[2]);
      } else if (image !== null) {
        const number = Number(image[1]);
        if (blocks.has(number)) throw new Error(`${where} : image ${String(number)} répétée`);
        current = [];
        blocks.set(number, current);
      } else if (line === '' || line.startsWith('#')) {
        return;
      } else {
        if (current === undefined || x0 < 0) throw new Error(`${where} : ligne hors d'une image`);
        const unknown = line.split('').find((char) => !allowed.has(char));
        if (unknown !== undefined) throw new Error(`${where} : lettre inconnue « ${unknown} »`);
        current.push(line);
      }
    });
  const frames: string[][] = [];
  for (let number = 0; number < blocks.size; number++) {
    const block = blocks.get(number);
    if (block === undefined) throw new Error(`${name} : image ${String(number)} absente`);
    const lines: string[] = [];
    for (let y = 0; y < cellHeight; y++) {
      const inside = y >= y0 && y - y0 < block.length ? block[y - y0] : '';
      if (x0 + inside.length > cellWidth)
        throw new Error(`${name} : image ${String(number)} trop large`);
      lines.push('.'.repeat(x0) + inside + '.'.repeat(cellWidth - x0 - inside.length));
    }
    if (block.length + y0 > cellHeight)
      throw new Error(`${name} : image ${String(number)} trop haute`);
    frames.push(lines);
  }
  return { frames };
}

/**
 * Image de rôles d'une case de la planche : chaque pixel opaque doit être un ton connu de la
 * base, et sa lettre dans la grille doit lui correspondre : « o » pour un ton gardé, une région
 * pour un ton de peau ou de sous-vêtement, « . » pour un pixel transparent. Une erreur nomme
 * l'image et le pixel en défaut.
 */
export function cellRoles(
  name: string,
  rgba: Uint8Array,
  sheetWidth: number,
  cellX: number,
  cellY: number,
  cellWidth: number,
  cellHeight: number,
  anchor: readonly [number, number],
  grid: readonly string[],
  kinds: ReadonlyMap<string, ToneKind>,
  letters: string,
): RoleImage {
  const roles = new Uint8Array(cellWidth * cellHeight);
  for (let y = 0; y < cellHeight; y++) {
    for (let x = 0; x < cellWidth; x++) {
      const at = ((cellY + y) * sheetWidth + cellX + x) * 4;
      const char = grid[y]?.[x] ?? '.';
      const where = `${name}, pixel (${String(x)}, ${String(y)})`;
      const alpha = rgba[at + 3] ?? 0;
      if (alpha === 0) {
        if (char !== '.') throw new Error(`${where} : transparent, la grille dit « ${char} »`);
        continue;
      }
      if (alpha !== 255) throw new Error(`${where} : alpha ${String(alpha)}, ni 0 ni 255`);
      const color = hex(rgba[at] ?? 0, rgba[at + 1] ?? 0, rgba[at + 2] ?? 0);
      const kind = kinds.get(color);
      if (kind === undefined) throw new Error(`${where} : ton inconnu ${color}`);
      if (kind.kind === 'kept') {
        if (char !== 'o')
          throw new Error(`${where} : ton gardé ${color}, la grille dit « ${char} »`);
        roles[y * cellWidth + x] = kind.role;
        continue;
      }
      const region = char === 'o' || char === '.' ? -1 : letters.indexOf(char);
      if (region < 0) throw new Error(`${where} : ${color} sans région, la grille dit « ${char} »`);
      roles[y * cellWidth + x] = recolorRole(region, kind.kind === 'under' ? 1 : 0, kind.rank);
    }
  }
  return { width: cellWidth, height: cellHeight, roles, anchorX: anchor[0], anchorY: anchor[1] };
}

/**
 * Pixels de l'entrée qui recouvrent [x0, x0 + f) × [y0, y0 + f), la part de chacun, et si son
 * centre tombe dans le bloc.
 */
function cover(
  image: RoleImage,
  x0: number,
  y0: number,
  f: number,
  visit: (role: number, weight: number, centered: boolean) => void,
): void {
  const fromY = Math.max(0, Math.floor(y0));
  const toY = Math.min(image.height, Math.ceil(y0 + f));
  const fromX = Math.max(0, Math.floor(x0));
  const toX = Math.min(image.width, Math.ceil(x0 + f));
  for (let y = fromY; y < toY; y++) {
    const wy = Math.min(y + 1, y0 + f) - Math.max(y, y0);
    if (wy <= 0) continue;
    const middleY = y + 0.5 >= y0 && y + 0.5 < y0 + f;
    for (let x = fromX; x < toX; x++) {
      const wx = Math.min(x + 1, x0 + f) - Math.max(x, x0);
      const centered = middleY && x + 0.5 >= x0 && x + 0.5 < x0 + f;
      if (wx > 0) visit(image.roles[y * image.width + x] ?? 0, wx * wy, centered);
    }
  }
}

/**
 * Contour d'une réduction : celui de la planche, au facteur 1 (« keep ») ; retracé là où la forme
 * a trois pixels d'épaisseur (« thick ») ; sur tout le bord de la silhouette (« silhouette », le
 * gibier des petits niveaux, dont la consigne veut le contour sombre) ; ou aucun (« none »).
 */
export type OutlineMode = 'keep' | 'thick' | 'silhouette' | 'none';

/** Part d'un bloc que l'œil doit couvrir pour s'y montrer (reduceRoles). */
const EYE_SHARE = 0.05;

/**
 * Réduction d'une image de rôles d'un facteur f ≥ 1, pieds sur pieds (méthode retenue, ADR
 * 0016) : un pixel de sortie est opaque si l'entrée l'est sur 45 % de sa surface au moins ;
 * son rôle est celui de la région la plus présente (peau et sous-vêtement à part), au rang
 * moyen de ses pixels, arrondi, ou l'œil, dans le seul bloc où tombe le centre d'un pixel d'œil
 * et s'il y compte assez (un œil de la planche ne donne qu'un œil de la réduction) ; une ligne de
 * contour intérieure y devient l'ombre profonde de la région. Au bord, le contour d'un pixel n'est retracé que là
 * où la forme a trois pixels d'épaisseur au moins (« thick »), ou pas du tout (« none »). Les
 * rôles de sortie sont donc tous des rôles de l'entrée, ou le contour : aucune couleur nouvelle.
 * `eyes` sont les rôles des yeux (eyeRoles).
 */
export function reduceRoles(
  image: RoleImage,
  f: number,
  outline: OutlineMode,
  eyes: readonly number[],
): RoleImage {
  if (f === 1) return image;
  const outLeft = Math.ceil(image.anchorX / f);
  const outRight = Math.ceil((image.width - image.anchorX) / f);
  const width = outLeft + outRight;
  const height = Math.ceil(image.anchorY / f);
  const solid = new Uint8Array(width * height);
  const inner = new Uint8Array(width * height);
  const weights = new Float64Array(256);
  const fill = (v: number, threshold: number) => {
    let filled = 0;
    const y0 = image.anchorY - (height - v) * f;
    for (let u = 0; u < width; u++) {
      const x0 = image.anchorX + (u - outLeft) * f;
      weights.fill(0);
      let total = 0;
      let eye = -1;
      cover(image, x0, y0, f, (role, weight, centered) => {
        weights[role] = (weights[role] ?? 0) + weight;
        total += weight;
        if (centered && eyes.includes(role)) eye = role;
      });
      const opaque = total - weights[0];
      if (total === 0 || opaque === 0 || opaque / (f * f) < threshold) continue;
      solid[v * width + u] = 1;
      const seen = eye >= 0 && (weights[eye] ?? 0) >= EYE_SHARE * f * f;
      inner[v * width + u] = seen ? eye : interior(weights, opaque, eyes);
      filled++;
    }
    return filled;
  };
  for (let v = 0; v < height; v++) fill(v, 0.45);
  // Une figure debout sur la ligne de ses pieds y reste : si le vote vide la dernière rangée,
  // elle se refait à un seuil plus bas, pour que la réduction ne flotte pas au-dessus du sol.
  let grounded = false;
  for (let x = 0; x < image.width; x++) {
    if ((image.roles[(image.anchorY - 1) * image.width + x] ?? 0) !== 0) grounded = true;
  }
  if (grounded && height > 0 && fill(height - 1, 0.45) === 0 && fill(height - 1, 0.2) === 0) {
    fill(height - 1, Number.MIN_VALUE);
  }
  // Le rôle intérieur de chaque pixel opaque, jamais 0 (interior), puis le contour.
  const voted = { width, height, roles: inner, anchorX: outLeft, anchorY: height };
  if (outline === 'thick') return thickOutline(voted);
  return outline === 'silhouette' ? silhouetteOutline(voted, eyes) : voted;
}

/**
 * Le contour de toute la silhouette (« silhouette ») : chaque pixel du bord de la forme (un de
 * ses quatre voisins est vide, ou hors de l'image) devient le contour, sauf un œil (`eyes`), qui
 * reste l'œil. Une patte, une oreille d'un pixel de large deviennent ainsi le contour, comme sur
 * les petits sprites des planches.
 */
export function silhouetteOutline(image: RoleImage, eyes: readonly number[] = []): RoleImage {
  const { width, height } = image;
  const at = (u: number, v: number) =>
    u >= 0 && u < width && v >= 0 && v < height && (image.roles[v * width + u] ?? 0) !== 0;
  const roles = new Uint8Array(width * height);
  for (let v = 0; v < height; v++) {
    for (let u = 0; u < width; u++) {
      const role = image.roles[v * width + u] ?? 0;
      if (role === 0) continue;
      const edge = !at(u - 1, v) || !at(u + 1, v) || !at(u, v - 1) || !at(u, v + 1);
      roles[v * width + u] = edge && !eyes.includes(role) ? KEPT : role;
    }
  }
  return { ...image, roles };
}

/**
 * Le contour retracé d'une réduction (« thick ») : un pixel du bord de la forme (un de ses quatre
 * voisins est vide) devient le contour s'il touche un pixel de l'intérieur, c'est-à-dire là où la
 * forme a trois pixels d'épaisseur au moins. Les autres pixels gardent leur rôle, et ceux que
 * marque `frozen` aussi (une tête gardée à la taille de la planche, avec son contour d'origine).
 */
export function thickOutline(image: RoleImage, frozen?: Uint8Array): RoleImage {
  const { width, height } = image;
  const at = (u: number, v: number) =>
    u >= 0 && u < width && v >= 0 && v < height && (image.roles[v * width + u] ?? 0) !== 0;
  const edge = (u: number, v: number) =>
    !at(u - 1, v) || !at(u + 1, v) || !at(u, v - 1) || !at(u, v + 1);
  const inward = (u: number, v: number) => at(u, v) && !edge(u, v);
  const roles = new Uint8Array(width * height);
  for (let v = 0; v < height; v++) {
    for (let u = 0; u < width; u++) {
      if (!at(u, v)) continue;
      const thick =
        frozen?.[v * width + u] !== 1 &&
        edge(u, v) &&
        (inward(u - 1, v) || inward(u + 1, v) || inward(u, v - 1) || inward(u, v + 1));
      roles[v * width + u] = thick ? KEPT : (image.roles[v * width + u] ?? KEPT);
    }
  }
  return { ...image, roles };
}

/** Rôle intérieur d'un bloc sans œil : la région dominante au rang moyen, ou le contour. */
function interior(weights: Float64Array, opaque: number, eyes: readonly number[]): number {
  // Région et source dominantes.
  let best = -1;
  let bestWeight = 0;
  const sums = new Float64Array(32);
  const ranks = new Float64Array(32);
  for (let role = RECOLOR; role < 256; role++) {
    const weight = weights[role] ?? 0;
    if (weight === 0) continue;
    const { region, source, rank } = roleParts(role);
    const slot = region * 2 + source;
    sums[slot] = (sums[slot] ?? 0) + weight;
    ranks[slot] = (ranks[slot] ?? 0) + weight * rank;
  }
  for (let slot = 0; slot < 32; slot++) {
    const weight = sums[slot] ?? 0;
    if (weight > bestWeight) {
      best = slot;
      bestWeight = weight;
    }
  }
  if (best < 0) return KEPT;
  let rank = Math.round((ranks[best] ?? 0) / bestWeight);
  let lines = 0;
  for (let role = KEPT; role < RECOLOR; role++)
    if (!eyes.includes(role)) lines += weights[role] ?? 0;
  if (lines / opaque >= 0.5) rank = 3;
  return recolorRole(best >> 1, best & 1, Math.min(3, Math.max(0, rank)));
}

/**
 * Pixels de la tête (ses régions, `head`, et les traits et le contour qui les bordent), et le
 * menton.
 */
function headPart(
  image: RoleImage,
  head: readonly number[],
): { mask: Uint8Array; chinX: number; chinY: number } {
  const { width, height, roles } = image;
  const mask = new Uint8Array(width * height);
  let sumX = 0;
  let count = 0;
  let neck = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const role = roles[y * width + x] ?? 0;
      if (role >= RECOLOR && head.includes(roleParts(role).region)) {
        mask[y * width + x] = 1;
        sumX += x;
        count++;
        neck = Math.max(neck, y + 1);
      }
    }
  }
  if (count === 0) return { mask, chinX: image.anchorX, chinY: 0 };
  const grown = mask.slice();
  for (let y = 0; y < neck; y++) {
    for (let x = 0; x < width; x++) {
      const role = roles[y * width + x] ?? 0;
      if (role === 0 || role >= RECOLOR) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (mask[(y + dy) * width + x + dx] === 1) grown[y * width + x] = 1;
        }
      }
    }
  }
  return { mask: grown, chinX: Math.round(sumX / count), chinY: neck };
}

function masked(
  image: RoleImage,
  mask: Uint8Array,
  keep: number,
  anchorX: number,
  anchorY: number,
) {
  const roles = image.roles.map((role, index) => (mask[index] === keep ? role : 0));
  return { ...image, roles, anchorX, anchorY };
}

/**
 * Colle une tête réduite `face` sur un corps réduit `body` au facteur `fb` : le point d'ancrage de
 * la tête, (pointX, pointY) dans l'image d'origine `image`, à sa place dans le corps réduit,
 * arrondie (et, avec `touch`, descendue d'une rangée si l'arrondi laissait un trou au cou). La
 * tête passe devant le corps ; `head` marque ses pixels dans la figure.
 */
function pasteHead(
  image: RoleImage,
  body: RoleImage,
  face: RoleImage,
  pointX: number,
  pointY: number,
  fb: number,
  touch = false,
): { figure: RoleImage; head: Uint8Array } {
  const neckX = body.anchorX + Math.round((pointX - image.anchorX) / fb);
  let neckY = body.anchorY - Math.round((image.anchorY - pointY) / fb);
  if (touch && gapUnder(body, face, neckX, neckY)) neckY++;
  const left = Math.min(0, neckX - face.anchorX);
  const up = Math.min(0, neckY - face.anchorY);
  const width = Math.max(body.width, neckX - face.anchorX + face.width) - left;
  const height = body.height - up;
  const roles = new Uint8Array(width * height);
  const head = new Uint8Array(width * height);
  const paste = (part: RoleImage, ox: number, oy: number, mark: number) => {
    for (let y = 0; y < part.height; y++) {
      for (let x = 0; x < part.width; x++) {
        const role = part.roles[y * part.width + x] ?? 0;
        if (role === 0) continue;
        roles[(y + oy) * width + x + ox] = role;
        head[(y + oy) * width + x + ox] = mark;
      }
    }
  };
  paste(body, -left, -up, 0);
  paste(face, neckX - face.anchorX - left, neckY - face.anchorY - up, 1);
  return { figure: { width, height, roles, anchorX: body.anchorX - left, anchorY: height }, head };
}

/**
 * Une rangée vide sépare-t-elle la tête, posée le point d'ancrage en (neckX, neckY) du corps, du
 * haut du corps ? Sous la dernière rangée de la tête, dans ses colonnes, le corps n'a aucun pixel,
 * et il en a à la rangée suivante : l'arrondi de la place a laissé un trou au cou.
 */
function gapUnder(body: RoleImage, face: RoleImage, neckX: number, neckY: number): boolean {
  let bottom = -1;
  for (let index = 0; index < face.roles.length; index++) {
    if ((face.roles[index] ?? 0) !== 0) bottom = Math.max(bottom, Math.floor(index / face.width));
  }
  if (bottom < 0) return false;
  const opaque = (x: number, y: number) =>
    x >= 0 &&
    y >= 0 &&
    x < body.width &&
    y < body.height &&
    (body.roles[y * body.width + x] ?? 0) !== 0;
  const row = neckY - face.anchorY + bottom + 1;
  let below = false;
  for (let x = 0; x < face.width; x++) {
    if ((face.roles[bottom * face.width + x] ?? 0) === 0) continue;
    const bx = neckX - face.anchorX + x;
    if (opaque(bx, row)) return false;
    if (opaque(bx, row + 1)) below = true;
  }
  return below;
}

/** Grille de la tête d'une réduction : celle des pieds, avec le corps, ou la sienne, calée sous les yeux. */
export type HeadGrid = 'feet' | 'eyes';

/**
 * Réduction d'une figure d'adulte d'un facteur f (ADR 0016, § 7). Grille « feet » : reduceRoles,
 * toute la figure sur la grille de ses pieds. Grille « eyes » : le corps sur la grille de ses
 * pieds, la tête (les régions `headRegions` et les traits qui les bordent) sur une grille à elle,
 * dont une ligne passe juste sous les yeux : une rangée de la tête réduite finit sur les yeux, la
 * suivante n'a que du visage, si bien que l'œil, qui l'emporte dans son bloc, ne prend pas la
 * rangée du visage. La tête se réduit alors de même à chaque image où son dessin ne fait que se
 * déplacer : le balancement la monte ou la descend sans changer ce qu'elle montre. Elle se colle
 * à sa place, arrondie, et descend d'une rangée si l'arrondi laissait un trou au cou. Sans yeux,
 * sa grille se cale sur le menton. Le contour retracé se pose ensuite sur la figure entière.
 * Mêmes règles que reduceRoles : aucune couleur nouvelle.
 */
export function reduceFigure(
  image: RoleImage,
  f: number,
  outline: OutlineMode,
  eyes: readonly number[],
  headRegions: readonly number[],
  grid: HeadGrid,
): RoleImage {
  if (f === 1 || grid === 'feet') return reduceRoles(image, f, outline, eyes);
  const { mask, chinX, chinY } = headPart(image, headRegions);
  if (chinY === 0) return reduceRoles(image, f, outline, eyes);
  let eyeLine = -1;
  for (let index = 0; index < image.roles.length; index++) {
    if (mask[index] === 1 && eyes.includes(image.roles[index] ?? 0)) {
      eyeLine = Math.max(eyeLine, Math.floor(index / image.width) + 1);
    }
  }
  // Le point d'ancrage de la tête : la ligne sous les yeux, descendue d'un nombre entier de blocs
  // jusqu'au menton ou plus bas, pour que la grille de reduceRoles, qui part de lui, y passe.
  const point = eyeLine < 0 ? chinY : eyeLine + f * Math.ceil(Math.max(0, chinY - eyeLine) / f);
  // Tête et corps se votent sans contour ; le contour retracé se pose sur la figure entière : une
  // seule ligne au cou, et le visage descend jusqu'au cou comme sur la planche.
  const body = reduceRoles(masked(image, mask, 0, image.anchorX, image.anchorY), f, 'none', eyes);
  const face = reduceRoles(masked(image, mask, 1, chinX, point), f, 'none', eyes);
  const { figure } = pasteHead(image, body, face, chinX, point, f, true);
  return outline === 'thick' ? thickOutline(figure) : figure;
}

/**
 * Enfant ou nourrisson de `rows` rangées, dont `head` pour la tête, composé de l'image
 * d'adulte `image` : sa tête réduite à `head` rangées, le reste du corps aux autres, le menton
 * posé sur le cou. Mêmes règles de réduction que reduceRoles : aucune couleur nouvelle. La tête
 * est faite des régions `headRegions` (data/humans.json, head). Tête et corps se votent sans
 * contour, et le contour retracé (« thick ») se pose sur la figure entière : une seule ligne au
 * cou. Une tête gardée à la taille de la planche garde son contour d'origine.
 *
 * `standing`, la figure debout de référence (le repos, image 0, ADR 0022 § 4), règle les images
 * où l'adulte n'est pas debout : la tête y garde la réduction de la sienne, que des mains levées
 * au-dessus d'elle ne changent pas, et le corps jamais moins réduit que le sien. L'enfant à
 * genoux est donc plus petit que debout, au lieu d'être étiré à sa hauteur ; une image où le
 * corps est au moins aussi haut que celui de la référence (repos, marche) n'en change pas.
 */
export function youngRoles(
  image: RoleImage,
  rows: number,
  head: number,
  outline: OutlineMode,
  eyes: readonly number[],
  headRegions: readonly number[],
  standing?: RoleImage,
): RoleImage {
  const { mask, chinX, chinY } = headPart(image, headRegions);
  const figureTop = (of: RoleImage) => {
    let top = of.height;
    for (let index = 0; index < of.roles.length; index++) {
      if ((of.roles[index] ?? 0) !== 0) top = Math.min(top, Math.floor(index / of.width));
    }
    return top;
  };
  let fh = Math.max(1, (chinY - figureTop(image)) / head);
  let fb = Math.max(1, (image.anchorY - chinY) / (rows - head));
  if (standing !== undefined) {
    const reference = headPart(standing, headRegions);
    fh = Math.max(1, (reference.chinY - figureTop(standing)) / head);
    fb = Math.max(fb, (standing.anchorY - reference.chinY) / (rows - head));
  }
  const body = reduceRoles(masked(image, mask, 0, image.anchorX, image.anchorY), fb, 'none', eyes);
  const face = reduceRoles(masked(image, mask, 1, chinX, chinY), fh, 'none', eyes);
  // Le menton de la tête réduite sur le haut du cou du corps réduit.
  const { figure, head: pasted } = pasteHead(image, body, face, chinX, chinY, fb);
  return outline === 'thick' ? thickOutline(figure, fh === 1 ? pasted : undefined) : figure;
}

/** Recadre une image de rôles sur ses pixels opaques, point des pieds gardé. */
export function trimRoles(image: RoleImage): RoleImage {
  let x0 = image.width;
  let y0 = image.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if ((image.roles[y * image.width + x] ?? 0) === 0) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  if (x1 < 0) return { width: 1, height: 1, roles: new Uint8Array(1), anchorX: 0, anchorY: 1 };
  const width = x1 - x0 + 1;
  const height = y1 - y0 + 1;
  const roles = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    roles.set(
      image.roles.subarray((y0 + y) * image.width + x0, (y0 + y) * image.width + x0 + width),
      y * width,
    );
  }
  return { width, height, roles, anchorX: image.anchorX - x0, anchorY: image.anchorY - y0 };
}

/** Rangées de la figure d'une image de rôles : du plus haut pixel opaque à ses pieds. */
export function figureRows(image: RoleImage): number {
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if ((image.roles[y * image.width + x] ?? 0) !== 0) return image.anchorY - y;
    }
  }
  return 0;
}
