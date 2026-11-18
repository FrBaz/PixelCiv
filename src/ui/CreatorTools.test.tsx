import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadGameData } from '../core/data';
import { SPAWN_COUNT } from '../sim/commands';
import { CreatorPanel } from './CreatorTools';
import { creatorSetup, spawnChoice, spawnSettings, tool, type CreatorSetup } from './store';
import { buttons, expand, findAll, fire, textOf } from './testing';

const count = { min: 2, max: 50, initial: 20 };

/** Deux espèces, la seconde inventée pour l'occasion, avec leurs sous-espèces. */
const two: CreatorSetup = {
  species: [
    {
      id: 'human',
      name: 'species.human',
      subspecies: [
        { id: 'nordic', name: 'subspecies.nordic' },
        { id: 'plains', name: 'subspecies.plains' },
      ],
    },
    {
      id: 'dwarf',
      name: 'subspecies.sands',
      subspecies: [
        { id: 'deep', name: 'subspecies.sands' },
        { id: 'hill', name: 'subspecies.plains' },
      ],
    },
  ],
  count,
};

const panel = (setup: CreatorSetup) => expand(CreatorPanel({ setup }));
const pressed = (tree: unknown) =>
  buttons(tree)
    .filter((button) => button.props['aria-pressed'] === true)
    .map(textOf);

afterEach(() => {
  tool.value = 'inspect';
  spawnSettings.value = undefined;
});

describe("réglages de l'outil d'apparition (U-11)", () => {
  it('partent des données : la première espèce, sa première sous-espèce', () => {
    const data = loadGameData();
    // Les réglages que l'application tire des données (main.ts).
    const setup = creatorSetup(data.species.entries, SPAWN_COUNT);
    const first = data.species.entries.at(0);
    expect(spawnChoice(setup, undefined)).toEqual({
      species: first?.id,
      subspecies: first?.subspecies.at(0)?.id,
      count: SPAWN_COUNT.initial,
    });
    expect(spawnChoice({ species: [], count }, undefined)).toBeUndefined();
  });

  it('gardent le choix du joueur, tant que les données le proposent', () => {
    const chosen = { species: 'dwarf', subspecies: 'hill', count: 7 };
    expect(spawnChoice(two, chosen)).toEqual(chosen);
    // Une espèce, puis une sous-espèce, que les données n'ont plus : celles qui existent.
    expect(spawnChoice(two, { ...chosen, species: 'elf' })).toEqual({
      species: 'human',
      subspecies: 'nordic',
      count: 7,
    });
    expect(spawnChoice(two, { ...chosen, subspecies: 'plains' })).toEqual({
      species: 'dwarf',
      subspecies: 'deep',
      count: 7,
    });
    // Un nombre hors de ses bornes y revient.
    expect(spawnChoice(two, { ...chosen, count: 500 })?.count).toBe(50);
    expect(spawnChoice(two, { ...chosen, count: 0 })?.count).toBe(2);
  });
});

describe("panneau de l'outil d'apparition (CRE-03)", () => {
  it("propose l'espèce quand les données en ont plusieurs, puis ses sous-espèces (U-11)", () => {
    tool.value = 'spawn';
    let tree = panel(two);
    expect(buttons(tree).map(textOf)).toEqual([
      'Terminer',
      'humain',
      'des sables',
      'nordique',
      'des plaines',
    ]);
    expect(pressed(tree)).toEqual(['humain', 'nordique']);
    // Une autre espèce : ses sous-espèces, la première choisie.
    fire(buttons(tree).at(2), 'onClick');
    expect(spawnSettings.value).toEqual({ species: 'dwarf', subspecies: 'deep', count: 20 });
    tree = panel(two);
    expect(pressed(tree)).toEqual(['des sables', 'des sables']);
    fire(buttons(tree).at(4), 'onClick');
    expect(spawnSettings.value).toEqual({ species: 'dwarf', subspecies: 'hill', count: 20 });
    // Une seule espèce : pas de choix d'espèce.
    const one: CreatorSetup = { species: two.species.slice(0, 1), count };
    expect(buttons(panel(one)).map(textOf)).toEqual(['Terminer', 'nordique', 'des plaines']);
  });

  it('enfonce le choix appliqué, même quand les identifiants des données ont changé (U-11)', () => {
    tool.value = 'spawn';
    spawnSettings.value = { species: 'human', subspecies: 'plains', count: 20 };
    const renamed: CreatorSetup = {
      species: [
        {
          id: 'human',
          name: 'species.human',
          subspecies: [{ id: 'lowland', name: 'subspecies.plains' }],
        },
      ],
      count,
    };
    expect(pressed(panel(renamed))).toEqual(['des plaines']);
  });

  it('se désarme par Échap et par « Terminer », et pose son titre au focus (U-14)', () => {
    tool.value = 'spawn';
    const tree = panel(two);
    const dialog = findAll(tree, (element) => element.props.role === 'dialog').at(0);
    const event = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() };
    fire(dialog, 'onKeyDown', event);
    expect(tool.value).toBe('inspect');
    tool.value = 'spawn';
    fire(buttons(tree).at(0), 'onClick');
    expect(tool.value).toBe('inspect');
    const title = findAll(tree, (element) => element.type === 'strong').at(0);
    expect(title?.props.tabIndex).toBe(-1);
    expect(typeof title?.ref).toBe('function');
    expect(panel(two)).toBeNull();
  });
});
