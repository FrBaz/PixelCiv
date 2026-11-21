import { describe, expect, it, vi } from 'vitest';
import { step } from './day';
import { fingerprint } from './step';
import { scatteredGroups, testData, testState } from './testing';

// La couverture de la pêche rendue à la rampe de l'instant, comme en 7c893a7 : la température du
// mois tirée des couches, sans calendrier ni arrondi (tâche 2.4).
vi.mock('./cover', async () => {
  const { coverShare } = await import('../core/seasons');
  return {
    fishingCover: (
      world: { temperature: Int16Array; amplitude: Uint8Array },
      _calendars: Uint8Array,
      cell: number,
      _cover: string,
      ramp: { onset: number; span: number; full: number },
      season: number,
    ) =>
      coverShare(
        ramp,
        ((world.temperature[cell] ?? 0) + (world.amplitude[cell] ?? 0) * season) / 10,
      ),
  };
});

describe('cause de la troisième empreinte de référence (ADR 0019, § 1)', () => {
  it("redonne les empreintes d'avant 2b.7, la pêche rendue à la rampe de l'instant", () => {
    // La partie de la troisième empreinte (state.test.ts) : cent groupes de trente, trente mois.
    const state = testState();
    step(state, scatteredGroups(state, 100), testData);
    for (let tick = 1; tick < 30; tick++) step(state, [], testData);
    expect(fingerprint(state, { fauna: false })).toBe('cd841d8f');
    expect(fingerprint(state)).toBe('76a3c458');
  });
});
