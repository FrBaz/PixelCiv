/**
 * Auto-test du déterminisme (ADR 0003) : le jeu recalcule au démarrage, dans le
 * navigateur, des empreintes du générateur pseudo-aléatoire et de dmath, et, dans le
 * worker, celle d'un petit monde de référence ; il les compare aux valeurs de
 * référence. Le panneau de débogage affiche le résultat : un écart trahirait un moteur
 * qui ne donne pas les mêmes bits.
 */
import { cos, exp, log, pow, sin } from './dmath';
import { Fingerprint } from './hash';
import { Rng } from './rng';

export interface DeterminismFingerprints {
  readonly rng: string;
  readonly dmath: string;
}

/**
 * Valeurs de référence, figées par les tests. Celle du générateur a été recalculée
 * par une implémentation indépendante, en Python.
 */
export const EXPECTED_FINGERPRINTS: DeterminismFingerprints = {
  rng: '4ec1a8f2',
  dmath: 'cc526a73',
};

/**
 * Monde de référence de l'auto-test du worker : cette graine, les paramètres par défaut,
 * sur une carte de 64 × 32 cases, que le worker génère en quelques dizaines de ms.
 */
export const SELFTEST_WORLD = { seed: 'autotest', size: { width: 64, height: 32 } } as const;

/** Empreinte de ses couches (layersFingerprint), figée par les tests de la génération. */
export const EXPECTED_WORLD_FINGERPRINT = 'a9418520';

export function determinismFingerprints(): DeterminismFingerprints {
  const stream = new Rng('pixelciv').stream('selftest');
  const rng = new Fingerprint();
  for (let i = 0; i < 1000; i++) rng.uint32(stream.nextUint32());
  for (let i = 0; i < 100; i++) rng.float64(stream.nextFloat()).uint32(stream.nextInt(1000));

  const dmath = new Fingerprint();
  for (let i = 0; i < 1000; i++) {
    const x = (i - 500) * 0.0731;
    dmath
      .float64(sin(x * 7.3))
      .float64(cos(x * 7.3))
      .float64(exp(x))
      .float64(log(i * 0.37 + 1e-3))
      .float64(pow(1.0001 + i * 0.003, x));
  }
  return { rng: rng.hex(), dmath: dmath.hex() };
}

/** Vrai si les empreintes recalculées concordent avec les valeurs de référence. */
export function determinismSelfTest(): boolean {
  const actual = determinismFingerprints();
  return actual.rng === EXPECTED_FINGERPRINTS.rng && actual.dmath === EXPECTED_FINGERPRINTS.dmath;
}
