import { afterEach, describe, expect, it } from 'vitest';
import { buried, raise, raised } from './store';

afterEach(() => {
  raised.value = {};
});

describe('panneaux remontés à la demande du joueur (U-3, U-4)', () => {
  it('numérotent chaque demande, panneau par panneau', () => {
    raise('sheet');
    raise('sheet');
    raise('cell');
    expect(raised.value).toEqual({ sheet: 2, cell: 1 });
  });

  it('ne tiennent pour caché sous un autre que le panneau ouvert sans boîte affichée', () => {
    const element = (boxes: number) =>
      ({ getClientRects: () => ({ length: boxes }) }) as unknown as Element;
    expect(buried(null)).toBe(false);
    expect(buried(element(1))).toBe(false);
    expect(buried(element(0))).toBe(true);
  });
});
