import { describe, expect, it } from 'vitest';
import { formatDate, MONTH_KEYS } from './calendar';

describe('formatDate', () => {
  it("écrit le mois et l'an du monde", () => {
    expect(formatDate(0)).toBe("janvier de l'an 1");
    expect(formatDate(14)).toBe("mars de l'an 2");
    expect(formatDate(12 * 1999 + 11)).toBe("décembre de l'an 2 000");
  });

  it('nomme les douze mois', () => {
    expect(MONTH_KEYS).toHaveLength(12);
  });
});
