import { describe, expect, it } from 'vitest';
import { MAX_ALLELES } from './data/people';
import {
  AGE_CLASSES,
  AGE_CODE,
  decodeVisual,
  encodeVisual,
  GREY_LEVELS,
  visualCode,
} from './visual';

describe("code d'apparence des mini-sprites", () => {
  it('se relit à l’identique, sur 16 bits', () => {
    const visual = { sex: 1, age: 3, skin: 11, hair: 5, grey: 2 };
    const code = encodeVisual(visual);
    expect(code).toBeLessThan(1 << 16);
    expect(decodeVisual(code)).toEqual(visual);
    expect(decodeVisual(encodeVisual({ sex: 0, age: 0, skin: 0, hair: 0, grey: 0 }))).toEqual({
      sex: 0,
      age: 0,
      skin: 0,
      hair: 0,
      grey: 0,
    });
  });

  it('garde chacun des allèles de cheveux que les données permettent (A-6)', () => {
    // Le schéma admet MAX_ALLELES allèles par locus : aucun ne se replie sur un autre, et
    // les autres champs du code n'en sont pas touchés.
    for (let hair = 0; hair < MAX_ALLELES; hair++) {
      for (let grey = 0; grey < GREY_LEVELS; grey++) {
        const code = visualCode(1, 2, 5, hair, grey);
        expect(code).toBeLessThan(1 << 16);
        expect(decodeVisual(code)).toEqual({ sex: 1, age: 2, skin: 5, hair, grey });
      }
    }
  });

  it('garde chaque cran du grisonnement et chaque classe d’âge, à leur rang (A-10)', () => {
    for (const stage of AGE_CLASSES) {
      expect(AGE_CLASSES[AGE_CODE[stage]]).toBe(stage);
      for (let grey = 0; grey < GREY_LEVELS; grey++) {
        const code = visualCode(0, AGE_CODE[stage], 15, 15, grey);
        expect(decodeVisual(code)).toEqual({
          sex: 0,
          age: AGE_CODE[stage],
          skin: 15,
          hair: 15,
          grey,
        });
      }
    }
  });
});
