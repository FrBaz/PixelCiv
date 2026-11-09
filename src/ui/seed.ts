/**
 * Graine tirée au hasard pour l'écran de création : trois syllabes et un nombre, plus
 * faciles à retenir et à dicter qu'une suite de chiffres (« bakuro-482 »). Le hasard
 * vient de l'appareil : la graine, elle, fixe le monde (MON-03).
 */
const CONSONANTS = 'bdfgklmnprstvz';
const VOWELS = 'aeiou';

/** Entier de 0 à 2³² − 1, tiré par le générateur cryptographique du navigateur. */
function deviceRandom(): number {
  return crypto.getRandomValues(new Uint32Array(1)).at(0) ?? 0;
}

export function randomSeed(random: () => number = deviceRandom): string {
  let word = '';
  for (let syllable = 0; syllable < 3; syllable++) {
    word += CONSONANTS.charAt(random() % CONSONANTS.length);
    word += VOWELS.charAt(random() % VOWELS.length);
  }
  return `${word}-${String(random() % 1000).padStart(3, '0')}`;
}
