import { describe, expect, it } from 'vitest';
import { MAX_SEED_LENGTH } from '../core/worldParams';
import { randomSeed } from './seed';

describe('graine au hasard', () => {
  it('forme trois syllabes et un nombre à trois chiffres', () => {
    for (let i = 0; i < 50; i++) {
      const seed = randomSeed();
      expect(seed).toMatch(/^([bdfgklmnprstvz][aeiou]){3}-\d{3}$/);
      expect(seed.length).toBeLessThanOrEqual(MAX_SEED_LENGTH);
    }
  });

  it('suit le hasard fourni', () => {
    let next = 0;
    expect(randomSeed(() => next++)).toBe('befoka-006');
    expect(randomSeed(() => 0)).toBe('bababa-000');
  });
});
