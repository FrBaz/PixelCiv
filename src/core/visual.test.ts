import { describe, expect, it } from 'vitest';
import { decodeVisual, encodeVisual } from './visual';

describe("code d'apparence des mini-sprites", () => {
  it('se relit à l’identique, sur 16 bits', () => {
    const visual = { sex: 1, age: 3, skin: 11, hair: 5, grey: true };
    const code = encodeVisual(visual);
    expect(code).toBeLessThan(1 << 16);
    expect(decodeVisual(code)).toEqual(visual);
    expect(decodeVisual(encodeVisual({ sex: 0, age: 0, skin: 0, hair: 0, grey: false }))).toEqual({
      sex: 0,
      age: 0,
      skin: 0,
      hair: 0,
      grey: false,
    });
  });
});
