import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadGameData } from '../core/data';
import type { GroupView } from '../core/protocol';
import { CreatorPanel } from './CreatorTools';
import { escapeKey } from './escape';
import { SheetPanel } from './Sheet';
import {
  creationOpen,
  inspected,
  sheet,
  tool,
  type CellDetails,
  type CreatorSetup,
  type UiActions,
} from './store';
import { expand, FakeDocument, FakeElement, findAll, nextFrame, type Rendered } from './testing';

const data = loadGameData();
const content = {
  species: data.species.entries,
  genetics: data.genetics,
  appearance: data.appearance,
};

const creator: CreatorSetup = {
  species: [
    {
      id: 'human',
      name: 'species.human',
      subspecies: [{ id: 'nordic', name: 'subspecies.nordic' }],
    },
  ],
  count: { min: 2, max: 50, initial: 20 },
};

const group: GroupView = {
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
};

const cell = { x: 2, y: 3 } as CellDetails;

/** Un champ de saisie imité : la classe que la fenêtre connaît pour HTMLInputElement. */
class FakeInput {
  readonly value = '';
}

/** Une touche que la fenêtre reçoit : son élément, et si un panneau l'a déjà prise. */
function key(name: string, overrides: { target?: object; defaultPrevented?: boolean } = {}) {
  return {
    key: name,
    target: (overrides.target ?? null) as EventTarget | null,
    defaultPrevented: overrides.defaultPrevented ?? false,
    preventDefault: vi.fn(),
  };
}

/** Ce que l'interface demande au jeu : la fermeture de la fiche, qu'il accorde aussitôt. */
function fakeActions() {
  return {
    closeSheet: vi.fn(() => {
      sheet.value = undefined;
    }),
  };
}

/** La ref du titre d'un panneau déplié, pour y poser un titre imité comme le fait Preact. */
function titleRef(tree: unknown): (element: FakeElement | null) => void {
  const title: Rendered | undefined = findAll(tree, (element) => element.type === 'strong').at(0);
  const ref = title?.ref;
  if (typeof ref !== 'function') throw new Error('pas de ref de titre');
  return ref as (element: FakeElement | null) => void;
}

beforeEach(() => {
  vi.stubGlobal('HTMLInputElement', FakeInput);
});

afterEach(() => {
  vi.unstubAllGlobals();
  tool.value = 'inspect';
  sheet.value = undefined;
  inspected.value = undefined;
  creationOpen.value = false;
});

describe('Échap hors des panneaux (U-14)', () => {
  it("ferme le panneau du dessus : l'outil, puis la fiche, puis la case", () => {
    tool.value = 'spawn';
    sheet.value = { kind: 'group', view: group };
    inspected.value = cell;
    const actions = fakeActions();
    const first = key('Escape');
    escapeKey(first, actions);
    expect(tool.value).toBe('inspect');
    expect(sheet.value).toBeDefined();
    expect(first.preventDefault).toHaveBeenCalled();
    escapeKey(key('Escape'), actions);
    expect(actions.closeSheet).toHaveBeenCalledTimes(1);
    expect(inspected.value).toBe(cell);
    escapeKey(key('Escape'), actions);
    expect(inspected.value).toBeUndefined();
    // Plus rien à fermer : Échap passe son chemin.
    const last = key('Escape');
    escapeKey(last, actions);
    expect(last.preventDefault).not.toHaveBeenCalled();
    expect(actions.closeSheet).toHaveBeenCalledTimes(1);
  });

  it("rend le focus d'où l'outil, puis la fiche, s'étaient ouverts, après un appui sur la carte", async () => {
    const document = new FakeDocument();
    const toggle = new FakeElement(document, 'Faire apparaître');
    const fact = new FakeElement(document, 'fait de la chronique');
    const actions = fakeActions();
    // La fiche s'ouvre depuis un fait, puis l'outil s'arme depuis son bouton : chacun pose
    // son titre au focus, et garde son origine.
    fact.focus();
    sheet.value = { kind: 'group', view: group };
    const sheetTitle = new FakeElement(document, 'titre de la fiche');
    const sheetRef = titleRef(
      expand(SheetPanel({ content, actions: actions as unknown as UiActions })),
    );
    sheetRef(sheetTitle);
    toggle.focus();
    tool.value = 'spawn';
    const toolTitle = new FakeElement(document, "titre de l'outil");
    const toolRef = titleRef(expand(CreatorPanel({ setup: creator })));
    toolRef(toolTitle);
    expect(document.activeElement).toBe(toolTitle);
    // Un appui sur la carte : le focus tombe sur le corps de la page.
    document.activeElement = document.body;
    escapeKey(key('Escape'), actions);
    expect(tool.value).toBe('inspect');
    // Le rendu retire l'outil ; à l'image suivante, son bouton reprend le focus.
    toolRef(null);
    toolTitle.remove();
    await nextFrame();
    expect(document.activeElement).toBe(toggle);
    // Le focus de nouveau sur la carte, Échap ferme la fiche, et le fait reprend le focus.
    document.activeElement = document.body;
    escapeKey(key('Escape'), actions);
    expect(actions.closeSheet).toHaveBeenCalledTimes(1);
    sheetRef(null);
    sheetTitle.remove();
    await nextFrame();
    expect(document.activeElement).toBe(fact);
  });

  it("laisse Échap au panneau qui l'a pris, au champ de saisie, à l'écran de création", () => {
    tool.value = 'spawn';
    sheet.value = { kind: 'group', view: group };
    const actions = fakeActions();
    // Un panneau l'a traité, une autre touche, un champ de saisie : rien ne se ferme.
    escapeKey(key('Escape', { defaultPrevented: true }), actions);
    escapeKey(key('Enter'), actions);
    escapeKey(key('Escape', { target: new FakeInput() }), actions);
    // L'écran de création recouvre la carte : Échap ne ferme rien dessous.
    creationOpen.value = true;
    const covered = key('Escape');
    escapeKey(covered, actions);
    expect(tool.value).toBe('spawn');
    expect(actions.closeSheet).not.toHaveBeenCalled();
    expect(covered.preventDefault).not.toHaveBeenCalled();
  });
});
