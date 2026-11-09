import { describe, expect, it } from 'vitest';
import { Fingerprint } from './hash';

describe('Fingerprint', () => {
  it('suit FNV-1a sur 32 bits', () => {
    // Valeurs de référence de FNV-1a 32 bits.
    expect(new Fingerprint().hex()).toBe('811c9dc5');
    expect(new Fingerprint().bytes(new TextEncoder().encode('a')).hex()).toBe('e40c292c');
    expect(new Fingerprint().bytes(new TextEncoder().encode('foobar')).hex()).toBe('bf9cf968');
  });

  it("dépend de l'ordre et du contenu", () => {
    const a = new Fingerprint().uint32(1).uint32(2).value();
    const b = new Fingerprint().uint32(2).uint32(1).value();
    expect(a).not.toBe(b);
    expect(new Fingerprint().string('ab').string('c').value()).not.toBe(
      new Fingerprint().string('a').string('bc').value(),
    );
  });

  it('donne la même empreinte à tous les NaN, quels que soient leurs bits', () => {
    // NaN de signe négatif, comme en produisent certains processeurs.
    const negative = new Float64Array(Uint32Array.of(0, 0xfff80000).buffer);
    const payload = new Float32Array(Uint32Array.of(0x7fc00001).buffer);
    const canonical = (array: Float64Array | Float32Array) =>
      new Fingerprint().typedArray(array).value();
    expect(canonical(negative)).toBe(canonical(Float64Array.of(Number.NaN)));
    expect(canonical(payload)).toBe(canonical(Float32Array.of(Number.NaN)));
    expect(new Fingerprint().float64(negative[0]).value()).toBe(
      new Fingerprint().float64(Number.NaN).value(),
    );
  });

  it('lit les autres nombres à virgule par leurs octets', () => {
    const array = Float64Array.of(1.5, -0, Math.PI);
    expect(new Fingerprint().typedArray(array).value()).toBe(
      new Fingerprint().bytes(new Uint8Array(array.buffer)).value(),
    );
  });

  it('lit un tableau typé par ses octets', () => {
    const array = Uint16Array.of(1, 2, 3);
    const viaArray = new Fingerprint().typedArray(array).value();
    const viaBytes = new Fingerprint().bytes(new Uint8Array(array.buffer)).value();
    expect(viaArray).toBe(viaBytes);
  });
});
