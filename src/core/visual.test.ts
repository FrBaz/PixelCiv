import { describe, expect, it } from 'vitest';
import { MAX_ALLELES } from './data/people';
import { decodeVisual, encodeVisual, visualCode } from './visual';

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

  it('garde chacun des allèles de cheveux que les données permettent (A-6)', () => {
    // Le schéma admet MAX_ALLELES allèles par locus : aucun ne se replie sur un autre, et
    // les autres champs du code n'en sont pas touchés.
    for (let hair = 0; hair < MAX_ALLELES; hair++) {
      for (const grey of [false, true]) {
        const code = visualCode(1, 2, 5, hair, grey);
        expect(code).toBeLessThan(1 << 16);
        expect(decodeVisual(code)).toEqual({ sex: 1, age: 2, skin: 5, hair, grey });
      }
    }
  });
});
