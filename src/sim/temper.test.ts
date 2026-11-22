import { describe, expect, it } from 'vitest';
import { RandomStream, streamSeed } from '../core/rng';
import type { Species } from '../core/data';
import { pureAncestry } from './genetics';
import { step } from './day';
import { applyCommands } from './step';
import { LIVING_COLUMN_NAMES, LIVING_COLUMNS } from './population';
import { drawGregariousness, meanGregariousness, TEMPER_MAX } from './temper';
import { flatState, testHuman, withHuman } from './testing';

/** Moyenne et écart type d'une suite de valeurs. */
function moments(values: readonly number[]): { mean: number; sd: number } {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { mean, sd: Math.sqrt(variance) };
}

/** L'humain des données, dont chaque sous-espèce a la grégarité `means[i]`, d'écart type 0,1. */
function tempered(means: readonly number[]): Species {
  return {
    ...testHuman,
    subspecies: testHuman.subspecies.map((entry, index) => ({
      ...entry,
      temperament: { gregariousness: { mean: means[index] ?? 0.5, sd: 0.1 } },
    })),
  };
}

const draws = (species: Species, ancestry: readonly number[], mother?: number) => {
  const random = new RandomStream(streamSeed('grégarité', 'tests'));
  return Array.from(
    { length: 4000 },
    () => drawGregariousness(species, ancestry, 0, mother, random) / TEMPER_MAX,
  );
};

describe('grégarité, caractère acquis (IND-07, ADR 0014)', () => {
  it("se tire dans la répartition de la sous-espèce, et dans la moyenne d'une ascendance mêlée", () => {
    const species = tempered([0.2, 0.8, 0.5]);
    const nordic = moments(draws(species, pureAncestry(0)));
    expect(nordic.mean).toBeCloseTo(0.2, 1);
    expect(nordic.sd).toBeCloseTo(0.1, 1);
    // Moitié nordique, moitié des plaines : la moyenne des deux répartitions.
    const mixed = [128, 127, 0, 0];
    expect(moments(draws(species, mixed)).mean).toBeCloseTo(0.5, 1);
    expect(meanGregariousness(species, mixed)).toBe(
      Math.round(((0.2 * 128 + 0.8 * 127) / 255) * 255),
    );
    expect(meanGregariousness(species, pureAncestry(1))).toBe(Math.round(0.8 * TEMPER_MAX));
  });

  it("tient en partie de la mère, de la part `upbringing` de l'espèce", () => {
    const species = { ...tempered([0.5, 0.5, 0.5]), upbringing: 0.3 };
    const ancestry = pureAncestry(1);
    expect(moments(draws(species, ancestry, TEMPER_MAX)).mean).toBeCloseTo(0.3 + 0.7 * 0.5, 1);
    expect(moments(draws(species, ancestry, 0)).mean).toBeCloseTo(0.7 * 0.5, 1);
    // Sans éducation, la mère ne compte pas.
    const none = { ...species, upbringing: 0 };
    expect(moments(draws(none, ancestry, TEMPER_MAX)).mean).toBeCloseTo(0.5, 1);
    // Bornée de 0 à 255.
    const wide: Species = {
      ...species,
      subspecies: species.subspecies.map((entry) => ({
        ...entry,
        temperament: { gregariousness: { mean: 0.5, sd: 1 } },
      })),
    };
    const values = draws(wide, ancestry);
    expect(Math.min(...values)).toBe(0);
    expect(Math.max(...values)).toBe(1);
  });

  it('se tire sur son propre flux, sans décaler ceux des apparitions ni des naissances', () => {
    // Deux répartitions de la grégarité : les mêmes individus, aux mêmes tirages ; seules la
    // grégarité et les places, qui en dépendent (ADR 0014), changent, la place au camp comprise
    // (ADR 0021).
    const spawned = (means: readonly number[]) => {
      const content = withHuman(() => tempered(means));
      const state = flatState();
      applyCommands(
        state,
        [{ type: 'spawnGroup', x: 40, y: 60, species: 'human', subspecies: 'plains', count: 30 }],
        content,
      );
      return { state, content };
    };
    const low = spawned([0.1, 0.1, 0.1]).state;
    const high = spawned([0.9, 0.9, 0.9]).state;
    const placed = new Set(['gregariousness', 'x', 'y', 'goalX', 'goalY', 'homeX', 'homeY']);
    for (const name of LIVING_COLUMN_NAMES) {
      const width = LIVING_COLUMNS[name].width;
      const a = low.people.columns[name].subarray(0, low.people.end * width);
      const b = high.people.columns[name].subarray(0, high.people.end * width);
      if (name === 'gregariousness') expect(a).not.toEqual(b);
      else if (!placed.has(name)) expect(a, name).toEqual(b);
    }
    const streams = (state: typeof low) => {
      const { 'sim.temper': _temper, 'sim.camp': _camp, ...others } = state.rng.states();
      return others;
    };
    expect(streams(low)).toEqual(streams(high));
    // Un an : des naissances. Chaque grégarité, d'apparition ou de naissance, prend deux
    // tirages de `sim.temper`, et de lui seul : ce flux a avancé de deux tirages par
    // individu, ni plus ni moins.
    const { state, content } = spawned([0.1, 0.1, 0.1]);
    for (let month = 0; month < 12; month++) step(state, [], content);
    const reference = new RandomStream(streamSeed(state.params.seed, 'sim.temper'));
    const persons = state.people.count + state.people.archive.rows;
    expect(persons).toBeGreaterThan(30);
    for (let draw = 0; draw < 2 * persons; draw++) reference.nextFloat();
    expect(state.rng.states()['sim.temper']).toEqual(reference.state());
  });
});
