import { describe, expect, it } from 'vitest';
import { formatDate, MONTH_KEYS } from './calendar';

describe('formatDate', () => {
  it("écrit le mois et l'an du monde", () => {
    expect(formatDate(0)).toBe("janvier de l'an 1");
    expect(formatDate(14)).toBe("mars de l'an 2");
    expect(formatDate(12 * 1999 + 11)).toBe("décembre de l'an 2000");
    expect(formatDate(12 * 12344)).toBe("janvier de l'an 12345");
  });

  it('nomme les douze mois', () => {
    expect(MONTH_KEYS).toHaveLength(12);
  });
});

describe('formatDate avant l’an 1', () => {
  it('compte les années avant le début de la partie', () => {
    expect(formatDate(-1)).toBe("décembre, 1 an avant l'an 1");
    expect(formatDate(-12 * 34 - 4)).toBe("septembre, 35 ans avant l'an 1");
  });
});
