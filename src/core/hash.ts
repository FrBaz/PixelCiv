/**
 * Empreinte FNV-1a sur 32 bits, pour les tests de déterminisme (ADR 0003). Elle ne
 * repose que sur des opérations entières exactes : même entrée, même empreinte,
 * sur tous les moteurs.
 */
const OFFSET_BASIS = 0x811c9dc5;
const PRIME = 0x01000193;

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
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, true);
    return this.bytes(new Uint8Array(view.buffer));
  }

  /** Ajoute une chaîne, en UTF-8, précédée de sa longueur. */
  string(value: string): this {
    const data = new TextEncoder().encode(value);
    return this.uint32(data.length).bytes(data);
  }

  /**
   * Ajoute le contenu d'un tableau typé, octet par octet, dans l'ordre de la plateforme :
   * petit-boutiste sur tous les appareils visés.
   */
  typedArray(array: ArrayBufferView): this {
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
