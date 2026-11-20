/**
 * Objets du calque commun (tâche 2b.6 ; REN-03, REN-08, REN-09 ; ADR 0017, § 7) : le décor, et le
 * gibier qui viendra, sont des particules du conteneur des humains (src/render/people.ts),
 * triées avec eux par leurs pieds, à leur niveau de motifs et à leur densité k. Chaque sorte
 * d'objets est une source : elle a son atlas de rôles, que le calque range sous celui des
 * humains dans la même texture, et ses palettes, qu'elle range dans la même texture des
 * palettes, à des clés hors de celles des autres sources.
 *
 * Les positions d'une liste se comptent depuis l'origine de la carte à l'écran, en pixels
 * physiques : le calque y ajoute, à chaque image, le décalage entier de la caméra, si bien qu'une
 * source immobile ne se refait pas quand la vue défile, et que ses objets suivent le sol au pixel
 * près, comme les blocs de la carte (camera.ts, visibleChunks).
 */
import type { Camera, Extent } from './camera';
import { displayScale } from './camera';

/** Couleur d'un rôle, alpha compris : 255 opaque, 0 sans couleur (le rôle ne se peint pas). */
export type ObjectColor = readonly [number, number, number, number];
/** Palette d'un objet : une couleur par rôle de ses motifs (PALETTE_ROLES rôles au plus). */
export type ObjectPalette = readonly (ObjectColor | undefined)[];

/** Clés des palettes de chaque source, dans la texture des palettes : hors de celles des humains. */
export const PALETTE_KEYS = {
  /** Les apparences des humains (lookCode) tiennent sous 2^15. */
  humans: [0, 2 ** 15],
  decor: [2 ** 20, 2 ** 21],
  fauna: [2 ** 21, 2 ** 22],
} as const;

/** Un atlas de rôles d'objets, rangé au build, de la largeur de celui des humains. */
export interface ObjectAtlas {
  readonly width: number;
  readonly height: number;
  /** Rôles, un octet par pixel. */
  readonly roles: Uint8Array;
  /** Six nombres par motif : x, y, largeur, hauteur, et le point des pieds dans le motif. */
  readonly motifs: readonly number[];
  /**
   * Rôles de l'ombre portée de ses motifs, s'il en a (le décor ; pas le gibier) : peints au sol,
   * ils ne cachent rien à l'appui. Chaque atlas a sa légende : un même rôle peut, ailleurs, être
   * peint sur l'objet.
   */
  readonly shadowRoles?: readonly number[];
}

/** Ce que la vue montre de la carte, pour une source d'objets. */
export interface ObjectView {
  /** Échelle affichée : pixels physiques par pixel de carte, entière dès que les objets se voient. */
  readonly scale: number;
  /** Pixels physiques par pixel CSS. */
  readonly resolution: number;
  /** Niveau de motifs et densité k de la vue rapprochée (crowd.ts, viewDensity). */
  readonly level: number;
  readonly k: number;
  /**
   * Rectangle de la carte visible, en pixels de carte : x sans repli (une copie du monde par
   * largeur), y entre les pôles. Une source y ajoute ce qui dépasse de ses motifs.
   */
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  /** Instant affiché (jours), mois continu de la carte, horloge de la marche du rendu. */
  readonly t: number;
  readonly month: number;
  readonly walkMs: number;
}

/** Drapeaux d'un objet. */
export const OBJECT_FLAG = {
  /** Motif retourné d'est en ouest, autour de son bord droit (le gibier). */
  flip: 1,
  /** Son ombre portée prend le ton d'ombre du sol sous chaque pixel (méthode « ground »). */
  ground: 2,
} as const;

function grown<T extends Int32Array | Uint8Array | Float64Array>(array: T, size: number): T {
  const next = new (array.constructor as new (length: number) => T)(size);
  next.set(array);
  return next;
}

/**
 * Objets d'une source, en colonnes de tableaux typés, positions depuis l'origine de la carte à
 * l'écran (pixels physiques), triés par leurs pieds puis par ordre d'ajout (sort).
 */
export class ObjectList {
  count = 0;
  left = new Int32Array(256);
  top = new Int32Array(256);
  /** Ordonnée des pieds, et dimensions du dessin (pixels physiques). */
  feet = new Int32Array(256);
  width = new Int32Array(256);
  height = new Int32Array(256);
  /** Motif dans l'atlas de la source, place de sa palette, densité, drapeaux. */
  motif = new Int32Array(256);
  slot = new Int32Array(256);
  unit = new Int32Array(256);
  flags = new Uint8Array(256);
  /** Rang de chaque objet, du fond vers l'avant, après sort. */
  order = new Int32Array(256);
  private keys = new Float64Array(256);

  /** Vide la liste. */
  clear(): void {
    this.count = 0;
  }

  /** Ajoute un objet ; renvoie son rang d'ajout. */
  push(
    left: number,
    top: number,
    feet: number,
    width: number,
    height: number,
    motif: number,
    slot: number,
    unit: number,
    flags = 0,
  ): number {
    const at = this.count++;
    if (at >= this.left.length) {
      const size = this.left.length * 2;
      this.left = grown(this.left, size);
      this.top = grown(this.top, size);
      this.feet = grown(this.feet, size);
      this.width = grown(this.width, size);
      this.height = grown(this.height, size);
      this.motif = grown(this.motif, size);
      this.slot = grown(this.slot, size);
      this.unit = grown(this.unit, size);
      this.flags = grown(this.flags, size);
      this.order = grown(this.order, size);
      this.keys = grown(this.keys, size);
    }
    this.left[at] = left;
    this.top[at] = top;
    this.feet[at] = feet;
    this.width[at] = width;
    this.height[at] = height;
    this.motif[at] = motif;
    this.slot[at] = slot;
    this.unit[at] = unit;
    this.flags[at] = flags;
    return at;
  }

  /** Range les objets par leurs pieds, puis par ordre d'ajout (order). */
  sort(): void {
    const { count } = this;
    const keys = this.keys.subarray(0, count);
    // Des pieds entiers, à ±2^31 près, et des rangs sous 2^21 : la clé reste un entier exact.
    for (let index = 0; index < count; index++) keys[index] = this.feet[index] * 2 ** 21 + index;
    keys.sort();
    for (let index = 0; index < count; index++) {
      const key = keys[index];
      this.order[index] = key - Math.floor(key / 2 ** 21) * 2 ** 21;
    }
  }
}

/**
 * Range une palette dans la texture des palettes, à sa première demande, et rend sa place. La
 * génération change quand la texture se refait (changement de monde) : les places rendues avant
 * ne valent plus, et une source qui les garde doit les redemander.
 */
export interface PaletteSlots {
  readonly generation: number;
  slot(key: number, palette: () => ObjectPalette): number;
}

/**
 * Une source d'objets du calque commun : le décor (src/render/decor.ts), le gibier ensuite.
 * Le calque l'appelle à chaque image qu'il refait ; elle rend la même liste tant que ce qu'elle
 * montre ne change pas.
 */
export interface ObjectSource {
  /** Son atlas de rôles, que le calque range sous celui des humains à sa construction. */
  readonly atlas: ObjectAtlas;
  /**
   * Version de ce qu'elle montre hors de la vue et du mois : elle augmente au pinceau, à une
   * méthode d'ombre nouvelle, ou quand ses objets bougent. La signature du calque la lit.
   */
  readonly version: number;
  /** Ses objets pour la vue `view`, triés par leurs pieds ; ses palettes rangées par `palettes`. */
  update(view: ObjectView, palettes: PaletteSlots): ObjectList;
}

/**
 * Origine de la carte à l'écran, en pixels physiques entiers : là où se pose le pixel de carte
 * (0, 0) de la copie du monde que vise la caméra, comme le pose camera.ts (visibleChunks).
 */
export function mapOrigin(camera: Camera, viewport: Extent): { x: number; y: number } {
  const scale = displayScale(camera.zoom);
  return {
    x: Math.round(viewport.width / 2 - camera.x * scale),
    y: Math.round(viewport.height / 2 - camera.y * scale),
  };
}
