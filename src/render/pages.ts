/**
 * Atlas dynamique des textures recolorées (ADR 0014, § 6) : des pages de PAGE × PAGE pixels,
 * où chaque motif recoloré (motif, variante, apparence, habit) prend sa place, rangé en
 * étagères avec un pixel de marge. Les individus d'une page se dessinent ensemble : un appel
 * de dessin couvre jusqu'à seize pages, et un sprite qui change de texture pour une autre de
 * ses pages ne fait pas refaire le lot. Avec une texture par motif recoloré, une foule de
 * 12 000 individus demandait quelque 2 400 textures et 370 appels de dessin par image.
 */
import { BufferImageSource, Rectangle, Texture } from 'pixi.js';

/**
 * Côté d'une page, en pixels : 256, de quoi ranger quelque 800 motifs. Une page qui reçoit
 * des motifs repart entière au GPU (256 Kio) ; seize pages, 13 000 motifs, tiennent dans un
 * appel de dessin.
 */
export const PAGE = 256;

/** Rangement de rectangles en étagères, de gauche à droite puis de haut en bas. */
export class ShelfPacker {
  private x = 0;
  private y = 0;
  private shelf = 0;
  readonly size: number;

  constructor(size: number) {
    this.size = size;
  }

  /**
   * Le coin haut gauche d'un rectangle de `width` × `height` pixels, avec un pixel de marge à
   * droite et au-dessous, ou undefined si la page est pleine.
   */
  place(width: number, height: number): { readonly x: number; readonly y: number } | undefined {
    if (width > this.size || height > this.size)
      throw new RangeError('motif plus grand qu’une page');
    if (this.x + width > this.size) {
      this.x = 0;
      this.y += this.shelf + 1;
      this.shelf = 0;
    }
    if (this.y + height > this.size) return undefined;
    const at = { x: this.x, y: this.y };
    this.x += width + 1;
    this.shelf = Math.max(this.shelf, height);
    return at;
  }
}

/** Une page : ses pixels, sa source pour le GPU, son rangement, et si elle a changé. */
interface Page {
  readonly pixels: Uint8ClampedArray<ArrayBuffer>;
  readonly source: BufferImageSource;
  readonly packer: ShelfPacker;
  dirty: boolean;
}

/** Les pages de l'atlas dynamique, et les textures qu'on y découpe. */
export class TexturePages {
  private pages: Page[] = [];
  private readonly size: number;

  constructor(size = PAGE) {
    this.size = size;
  }

  private page(): Page {
    const pixels = new Uint8ClampedArray(this.size * this.size * 4);
    const source = new BufferImageSource({
      resource: pixels,
      width: this.size,
      height: this.size,
      scaleMode: 'nearest',
    });
    const page = { pixels, source, packer: new ShelfPacker(this.size), dirty: true };
    this.pages.push(page);
    return page;
  }

  /** La texture d'un motif recoloré, de `width` × `height` pixels RGBA, rangé dans une page. */
  add(rgba: Uint8ClampedArray, width: number, height: number): Texture {
    let page = this.pages.at(-1);
    let at = page?.packer.place(width, height);
    if (page === undefined || at === undefined) {
      page = this.page();
      at = page.packer.place(width, height);
      if (at === undefined) throw new RangeError('motif plus grand qu’une page');
    }
    for (let row = 0; row < height; row++) {
      page.pixels.set(
        rgba.subarray(row * width * 4, (row + 1) * width * 4),
        ((at.y + row) * this.size + at.x) * 4,
      );
    }
    page.dirty = true;
    return new Texture({ source: page.source, frame: new Rectangle(at.x, at.y, width, height) });
  }

  /** Envoie au GPU les pages qui ont reçu des motifs depuis la dernière image. */
  flush(): void {
    for (const page of this.pages) {
      if (!page.dirty) continue;
      page.dirty = false;
      page.source.update();
    }
  }

  /** Nombre de pages. */
  get count(): number {
    return this.pages.length;
  }

  /** Les sources des pages, dans leur ordre. */
  get sources(): readonly BufferImageSource[] {
    return this.pages.map((page) => page.source);
  }

  /** Libère les pages (autre monde) : leurs textures ne servent plus. */
  destroy(): void {
    for (const page of this.pages) page.source.destroy();
    this.pages = [];
  }
}
