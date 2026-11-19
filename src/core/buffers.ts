/**
 * Tableaux typés des messages du worker (ADR 0004, ADR 0014) : l'image des groupes et les
 * étapes voyagent dans des tampons transférés, que le fil principal rend une fois lus
 * (message `recycle`). Qui construit un message prend ses tableaux d'un Allocator : le worker
 * les reprend de sa réserve, les tests et le reste les allouent neufs.
 */
export interface Allocator {
  uint8(length: number): Uint8Array<ArrayBuffer>;
  uint16(length: number): Uint16Array<ArrayBuffer>;
  uint32(length: number): Uint32Array<ArrayBuffer>;
  int32(length: number): Int32Array<ArrayBuffer>;
}

/** Des tableaux neufs, sans réserve. */
export const freshArrays: Allocator = {
  uint8: (length) => new Uint8Array(length),
  uint16: (length) => new Uint16Array(length),
  uint32: (length) => new Uint32Array(length),
  int32: (length) => new Int32Array(length),
};

/** Tampons gardés, au plus, et leur taille totale, au plus, en octets. */
const MAX_BUFFERS = 96;
const MAX_BYTES = 64 << 20;

/** Plus petite puissance de deux qui tient `bytes` octets, 64 au moins. */
function sizeClass(bytes: number): number {
  let size = 64;
  while (size < bytes) size *= 2;
  return size;
}

/**
 * Réserve de tampons, rangés par taille (une puissance de deux) : un tableau de n éléments se
 * prend dans un tampon de la plus petite classe qui le tient, ou de l'une des deux suivantes,
 * remis à zéro, sinon dans un tampon neuf de cette classe. Les tampons rendus d'une autre
 * taille, ou au-delà des bornes de la réserve, s'oublient.
 */
export class BufferPool implements Allocator {
  private readonly free = new Map<number, ArrayBuffer[]>();
  private count = 0;
  private bytes = 0;
  /** Tampons pris dans la réserve, et tampons neufs : pour les tests et les mesures. */
  reused = 0;
  created = 0;

  private buffer(bytes: number): ArrayBuffer {
    const size = sizeClass(bytes);
    // Un tampon de sa classe, sinon de l'une des deux suivantes, au plus quatre fois trop grand.
    for (let class_ = size; class_ <= 4 * size; class_ *= 2) {
      const found = this.free.get(class_)?.pop();
      if (found === undefined) continue;
      this.count--;
      this.bytes -= class_;
      this.reused++;
      new Uint8Array(found).fill(0);
      return found;
    }
    this.created++;
    return new ArrayBuffer(size);
  }

  uint8(length: number): Uint8Array<ArrayBuffer> {
    return length === 0 ? new Uint8Array(0) : new Uint8Array(this.buffer(length), 0, length);
  }

  uint16(length: number): Uint16Array<ArrayBuffer> {
    return length === 0 ? new Uint16Array(0) : new Uint16Array(this.buffer(2 * length), 0, length);
  }

  uint32(length: number): Uint32Array<ArrayBuffer> {
    return length === 0 ? new Uint32Array(0) : new Uint32Array(this.buffer(4 * length), 0, length);
  }

  int32(length: number): Int32Array<ArrayBuffer> {
    return length === 0 ? new Int32Array(0) : new Int32Array(this.buffer(4 * length), 0, length);
  }

  /** Reprend des tampons rendus par le fil principal. */
  give(buffers: readonly ArrayBuffer[]): void {
    for (const buffer of buffers) {
      const size = buffer.byteLength;
      if (size < 64 || sizeClass(size) !== size) continue;
      if (this.count >= MAX_BUFFERS || this.bytes + size > MAX_BYTES) continue;
      const list = this.free.get(size);
      if (list === undefined) this.free.set(size, [buffer]);
      else list.push(buffer);
      this.count++;
      this.bytes += size;
    }
  }

  /** Tampons gardés. */
  get size(): number {
    return this.count;
  }
}
