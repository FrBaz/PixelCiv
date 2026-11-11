import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadGameData } from '../core/data';
import { ageClass } from '../core/life';
import type { GroupView, PersonSummary, PersonView } from '../core/protocol';
import { t, tKey } from '../i18n';
import { CellInfo } from './CellInfo';
import { Portrait } from './Portrait';
import { SheetPanel, sheetKey, type SheetContent } from './Sheet';
import { inspected, sheet, type CellDetails, type UiActions } from './store';
import { buttons, expand, findAll, fire, textOf, type Rendered } from './testing';

const data = loadGameData();
const content: SheetContent = {
  species: data.species.entries,
  genetics: data.genetics,
  appearance: data.appearance,
};
const human = data.species.entries[0] ?? missing();

function missing(): never {
  throw new Error('donnée absente');
}

function fakeActions() {
  return {
    closeSheet: vi.fn(),
    inspectPerson: vi.fn(),
    inspectGroup: vi.fn(),
    focus: vi.fn(),
  };
}

function person(overrides: Partial<PersonView> = {}): PersonView {
  return {
    id: 7,
    name: 'Tiko',
    sex: 1,
    age: 30,
    stage: 'adult',
    alive: true,
    birth: -360,
    species: 'human',
    culture: 1,
    ancestry: [{ subspecies: 'plains', share: 1 }],
    genome: [1, 2, 3, 4],
    loci: [],
    traits: [],
    height: 172,
    grey: 0,
    nutrition: 1,
    pregnant: false,
    children: [],
    siblings: [],
    ...overrides,
  };
}

function group(overrides: Partial<GroupView> = {}): GroupView {
  return {
    id: 3,
    name: 'Waskus',
    x: 1536,
    y: 300,
    size: 2,
    founded: 0,
    naming: 'father',
    reserve: 2,
    homeX: 1536,
    homeY: 300,
    members: [],
    ...overrides,
  };
}

/** La fiche ouverte, dépliée, le portrait laissé tel quel. */
function shown(actions = fakeActions()): unknown {
  return expand(SheetPanel({ content, actions: actions as unknown as UiActions }), [Portrait]);
}

/** Le panneau de la fiche : l'élément qui se déclare dialogue. */
function dialog(tree: unknown): Rendered | undefined {
  return findAll(tree, (element) => element.props.role === 'dialog').at(0);
}

afterEach(() => {
  sheet.value = undefined;
  inspected.value = undefined;
});

describe('fiches (IHM-02)', () => {
  it("changent d'élément avec leur cible, et le gardent quand elles se rafraîchissent (U-8)", () => {
    const actions = fakeActions() as unknown as UiActions;
    sheet.value = { kind: 'person', view: person() };
    const first = SheetPanel({ content, actions });
    // Le rafraîchissement d'une seconde : une autre vue, de la même cible.
    sheet.value = { kind: 'person', view: person({ age: 31 }) };
    expect(SheetPanel({ content, actions })?.key).toBe(first?.key);
    // Un lien suivi : une autre cible, une autre fiche, qui s'ouvre en haut.
    sheet.value = { kind: 'person', view: person({ id: 8 }) };
    expect(SheetPanel({ content, actions })?.key).not.toBe(first?.key);
    // Un groupe de même identifiant qu'un individu n'est pas lui.
    sheet.value = { kind: 'group', view: group({ id: 7 }) };
    expect(SheetPanel({ content, actions })?.key).not.toBe(first?.key);
    expect(sheetKey({ kind: 'group', view: group({ id: 7 }) })).toBe('group:7');
  });

  it('écrivent la mort dans le lien vers un mort, au genre de chacun (U-13)', () => {
    const relative = (id: number, sex: number, age: number, alive: boolean): PersonSummary => ({
      id,
      name: `P${String(id)}`,
      sex,
      age,
      stage: ageClass(human, age),
      alive,
    });
    sheet.value = {
      kind: 'person',
      view: person({
        siblings: [
          relative(1, 0, 11, false),
          relative(2, 0, 11, true),
          relative(3, 1, 64, false),
          relative(4, 1, 0, false),
          relative(5, 0, 0, false),
        ],
      }),
    };
    const links = buttons(shown()).filter((button) =>
      String(button.props.class).includes('sheet-link'),
    );
    expect(links.map(textOf)).toEqual([
      'P1 morte à 11 ans',
      'P2 fille, 11 ans',
      'P3 mort à 64 ans',
      'P4 mort avant un an',
      'P5 morte avant un an',
    ]);
  });

  it('disent « inconnue » d’une mère et « inconnu » d’un père absents (U-15)', () => {
    sheet.value = { kind: 'person', view: person() };
    const rows = findAll(shown(), (element) => element.props.class === 'debug-row').map(textOf);
    expect(rows).toContain('Mère inconnue');
    expect(rows).toContain('Père inconnu');
    expect(rows).toContain('Enfants aucun');
  });

  it('écrivent les coordonnées sans séparateur des milliers (U-15)', () => {
    sheet.value = { kind: 'group', view: group() };
    const rows = findAll(shown(), (element) => element.props.class === 'debug-row').map(textOf);
    expect(rows).toContain('Case 1536, 300');
    const cell: CellDetails = {
      x: 2047,
      y: 1023,
      biome: 'biome.grassland',
      level: 'altitude.plain-one',
      elevation: 120,
      depth: 0,
      temperature: 12,
      monthly: 10,
      precipitation: 600,
      monthlyPrecipitation: 50,
      river: 0,
      deposit: undefined,
      resources: [],
      trees: 10,
      shrubs: 20,
    };
    inspected.value = cell;
    expect(textOf(expand(CellInfo()))).toContain('Case 2047, 1023');
  });

  it('se ferment par Échap et par leur bouton, et posent leur titre au focus (U-14)', () => {
    for (const view of [
      { kind: 'person', view: person() },
      { kind: 'group', view: group() },
    ] as const) {
      sheet.value = view;
      const actions = fakeActions();
      const tree = shown(actions);
      const panel = dialog(tree);
      const event = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() };
      fire(panel, 'onKeyDown', { ...event, key: 'Tab' });
      expect(actions.closeSheet).not.toHaveBeenCalled();
      fire(panel, 'onKeyDown', event);
      expect(actions.closeSheet).toHaveBeenCalledTimes(1);
      expect(event.preventDefault).toHaveBeenCalled();
      fire(buttons(tree).at(0), 'onClick');
      expect(actions.closeSheet).toHaveBeenCalledTimes(2);
      // Le titre se prend au focus : il en a la place, et la ref qui l'y pose.
      const title = findAll(tree, (element) => element.type === 'strong').at(0);
      expect(title?.props.tabIndex).toBe(-1);
      expect(typeof title?.ref).toBe('function');
    }
  });

  it('nomment chacun selon la classe d’âge que lui donne son espèce (U-12)', () => {
    const relative = (id: number, sex: number, age: number, stage: PersonSummary['stage']) => ({
      id,
      name: `P${String(id)}`,
      sex,
      age,
      stage,
      alive: true,
    });
    sheet.value = {
      kind: 'person',
      view: person({
        children: [
          // Un homme de 13 ans, d'une espèce qui mûrit à 12 ans ; un garçon de 20 ans,
          // d'une espèce qui mûrit à 30 ans ; un nourrisson de 4 ans, d'une espèce qui le
          // reste plus longtemps ; une aînée, qui reste une femme.
          relative(1, 1, 13, 'adult'),
          relative(2, 1, 20, 'child'),
          relative(3, 0, 4, 'baby'),
          relative(4, 0, 70, 'elder'),
        ],
      }),
    };
    const links = buttons(shown()).filter((button) =>
      String(button.props.class).includes('sheet-link'),
    );
    expect(links.map(textOf)).toEqual([
      'P1 homme, 13 ans',
      'P2 garçon, 20 ans',
      'P3 nourrisson, 4 ans',
      'P4 femme, 70 ans',
    ]);
  });

  it('donnent la taille adulte d’un enfant pour ce qu’elle est (U-12)', () => {
    const rows = (view: PersonView) => {
      sheet.value = { kind: 'person', view };
      return findAll(shown(), (element) => element.props.class === 'debug-row').map(textOf);
    };
    expect(rows(person({ age: 1, stage: 'baby', height: 171 }))).toContain('Taille adulte 171 cm');
    expect(rows(person({ age: 9, stage: 'child', height: 165 }))).toContain('Taille adulte 165 cm');
    expect(rows(person({ age: 30, stage: 'adult', height: 172 }))).toContain('Taille 172 cm');
    // Le statut d'un enfant vivant le dit enfant, quel que soit son âge en années.
    sheet.value = { kind: 'person', view: person({ age: 20, stage: 'child' }) };
    expect(textOf(shown())).toContain('garçon, 20 ans');
  });

  it('ne montrent en niveaux que les traits sans rôle, quels que soient leurs noms (D-6)', () => {
    // Des traits renommés : teint et taille restent hors de la liste, par leur rôle.
    const genetics = {
      ...data.genetics,
      traits: data.genetics.traits.map((entry) => ({ ...entry, id: `${entry.id}-x` })),
    };
    const renamed: SheetContent = { ...content, genetics };
    sheet.value = {
      kind: 'person',
      view: person({
        traits: genetics.traits.map((entry) => ({ trait: entry.id, value: 0.7 })),
      }),
    };
    const tree = expand(
      SheetPanel({ content: renamed, actions: fakeActions() as unknown as UiActions }),
      [Portrait],
    );
    const labels = findAll(tree, (element) => element.type === 'dt').map(textOf);
    // Les traits sans rôle, chacun son niveau ; le teint nulle part ; la taille une seule
    // fois, en centimètres.
    const plain = genetics.traits.filter((entry) => entry.role === undefined);
    expect(plain.length).toBeGreaterThan(0);
    for (const entry of plain) expect(labels).toContain(tKey(entry.name));
    expect(labels).not.toContain(tKey('trait.skin'));
    expect(labels.filter((label) => label === t('person.height'))).toHaveLength(1);
  });
});
