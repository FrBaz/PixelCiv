import { describe, expect, it } from 'vitest';
import { checkCatalog, createTranslator } from './translate';

const catalog = {
  greeting: 'Bonjour, {name} !',
  years: { one: '{count} an', other: '{count} ans' },
  population: { one: '{count} habitant', other: '{count} habitants', many: "{count} d'habitants" },
  baron: { masculine: 'baron', feminine: 'baronne' },
  barons: {
    masculine: { one: '{count} baron', other: '{count} barons' },
    feminine: { one: '{count} baronne', other: '{count} baronnes' },
  },
};
const t = createTranslator('fr', catalog);

describe('createTranslator', () => {
  it('insère les paramètres', () => {
    expect(t('greeting', { name: 'Aude' })).toBe('Bonjour, Aude !');
  });

  it('laisse visible un paramètre manquant', () => {
    expect(t('greeting')).toBe('Bonjour, {name} !');
  });

  it('choisit le pluriel selon les règles du français', () => {
    expect(t('years', { count: 0 })).toBe('0 an');
    expect(t('years', { count: 1 })).toBe('1 an');
    expect(t('years', { count: 2 })).toBe('2 ans');
  });

  it('met les nombres en forme et se replie sur « other »', () => {
    expect(t('years', { count: 1234 })).toBe('1 234 ans');
    expect(t('years', { count: 1_000_000 })).toBe('1 000 000 ans');
    expect(t('population', { count: 1_000_000 })).toBe("1 000 000 d'habitants");
  });

  it('choisit la forme du genre, masculine par défaut', () => {
    expect(t('baron')).toBe('baron');
    expect(t('baron', { gender: 'feminine' })).toBe('baronne');
    expect(t('barons', { gender: 'feminine', count: 3 })).toBe('3 baronnes');
  });

  it('renvoie la clé si le message manque', () => {
    expect(t('inconnu')).toBe('inconnu');
  });
});

describe('checkCatalog', () => {
  it('accepte textes, pluriels et genres', () => {
    expect(checkCatalog(catalog)).toEqual([]);
  });

  it('signale les messages mal formés', () => {
    expect(
      checkCatalog({
        number: 3,
        noOther: { one: 'un' },
        unknownCategory: { one: 'un', other: 'des', plenty: 'beaucoup' },
        halfGendered: { masculine: 'roi' },
        nestedGender: { masculine: { masculine: 'a', feminine: 'b' }, feminine: 'c' },
      }),
    ).toEqual(['number', 'noOther', 'unknownCategory', 'halfGendered', 'nestedGender']);
  });
});
