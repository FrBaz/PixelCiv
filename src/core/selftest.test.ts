import { describe, expect, it } from 'vitest';
import { determinismFingerprints, determinismSelfTest, EXPECTED_FINGERPRINTS } from './selftest';

describe('auto-test du déterminisme', () => {
  it('retrouve les valeurs de référence', () => {
    expect(determinismFingerprints()).toEqual(EXPECTED_FINGERPRINTS);
    expect(determinismSelfTest()).toBe(true);
  });
});
