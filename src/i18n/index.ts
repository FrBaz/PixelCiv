/**
 * Textes affichés du jeu. Seul le français existe pour l'instant ; une autre langue
 * ajoutera son catalogue, avec les mêmes clés.
 */
import fr from './fr.json';
import { createTranslator, type MessageParams } from './translate';

export type { Gender, MessageParams } from './translate';

/** Clé d'un message du catalogue français, qui fait référence. */
export type MessageKey = keyof typeof fr;

export const LOCALE = 'fr';

const translate = createTranslator(LOCALE, fr);

/** Traduit un message ; la clé est vérifiée à la compilation. */
export function t(key: MessageKey, params?: MessageParams): string {
  return translate(key, params);
}

/**
 * Traduit un message dont la clé vient des données (`data/`) : elle n'est pas connue
 * à la compilation, mais les tests vérifient qu'elle existe.
 */
export function tKey(key: string, params?: MessageParams): string {
  return translate(key, params);
}
