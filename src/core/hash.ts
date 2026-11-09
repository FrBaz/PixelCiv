/**
 * Empreinte FNV-1a sur 32 bits, pour les tests de déterminisme (ADR 0003). Elle ne
 * repose que sur des opérations entières exactes : même entrée, même empreinte,
 * sur tous les moteurs.
 *
 * Un NaN n'a pas de bits fixés : selon le processeur et le moteur, le même calcul
 * en donne des différents. Les nombres à virgule passent donc par une forme
 * canonique, où tout NaN s'écrit 0x7ff8000000000000.
 */
const OFFSET_BASIS = 0x811c9dc5;
const PRIME = 0x01000193;

/** Octets d'un double, petit-boutistes, NaN canonique. */
function float64Bytes(value: number): Uint8Array {
  const view = new DataView(new ArrayBuffer(8));
  if (Number.isNaN(value)) view.setUint32(4, 0x7ff80000, true);
  else view.setFloat64(0, value, true);
  return new Uint8Array(view.buffer);
}

/** Octets d'un float, petit-boutistes, NaN canonique (0x7fc00000). */
function float32Bytes(value: number): Uint8Array {
  const view = new DataView(new ArrayBuffer(4));
  if (Number.isNaN(value)) view.setUint32(0, 0x7fc00000, true);
  else view.setFloat32(0, value, true);
  return new Uint8Array(view.buffer);
}

export class Fingerprint {
  private hash = OFFSET_BASIS;

  /** Ajoute des octets. */
  bytes(data: Uint8Array): this {
    let hash = this.hash;
    for (const byte of data) {
      hash = Math.imul(hash ^ byte, PRIME);
    }
    this.hash = hash;
    return this;
  }

  /** Ajoute un entier sur 32 bits, octets de poids faible en tête. */
  uint32(value: number): this {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, value >>> 0, true);
    return this.bytes(new Uint8Array(view.buffer));
  }

  /** Ajoute un nombre à virgule, par ses 64 bits, octets de poids faible en tête. */
  float64(value: number): this {
    return this.bytes(float64Bytes(value));
  }

  /** Ajoute une chaîne, en UTF-8, précédée de sa longueur. */
  string(value: string): this {
    const data = new TextEncoder().encode(value);
    return this.uint32(data.length).bytes(data);
  }

  /**
   * Ajoute le contenu d'un tableau typé, octet par octet, dans l'ordre de la plateforme :
   * petit-boutiste sur tous les appareils visés. Les nombres à virgule passent par leur
   * forme canonique.
   */
  typedArray(array: ArrayBufferView): this {
    if (array instanceof Float64Array) {
      for (const value of array) this.bytes(float64Bytes(value));
      return this;
    }
    if (array instanceof Float32Array) {
      for (const value of array) this.bytes(float32Bytes(value));
      return this;
    }
    return this.bytes(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
  }

  /** Empreinte, en entier non signé. */
  value(): number {
    return this.hash >>> 0;
  }

  /** Empreinte, en hexadécimal sur 8 chiffres. */
  hex(): string {
    return this.value().toString(16).padStart(8, '0');
  }
}
