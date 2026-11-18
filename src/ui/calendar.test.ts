import { describe, expect, it } from 'vitest';
import { formatDate, formatDay, MONTH_KEYS } from './calendar';

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

describe('formatDay (ADR 0013)', () => {
  it('écrit le jour en cours de son mois, « 1er » pour le premier', () => {
    expect(formatDay({ tick: 0, day: 0 })).toBe("1er janvier de l'an 1");
    expect(formatDay({ tick: 14, day: 11 })).toBe("12 mars de l'an 2");
    expect(formatDay({ tick: 23, day: 29 })).toBe("30 décembre de l'an 2");
    expect(formatDay({ tick: 12 * 1999 + 8, day: 1 })).toBe("2 septembre de l'an 2000");
  });
});
