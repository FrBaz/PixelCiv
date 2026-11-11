import { describe, expect, it } from 'vitest';
import { stackPanels, type OpenPanel, type SidePanel } from './panels';

const open = (...entries: [SidePanel, string][]): OpenPanel[] =>
  entries.map(([id, key]) => ({ id, key }));
const top = (stack: readonly OpenPanel[]) => stack.at(-1)?.id;

describe('panneaux de la colonne, sur petit écran (U-3, U-4)', () => {
  it('montre le dernier ouvert, et les autres reparaissent quand on le ferme', () => {
    // L'outil armé, puis la chronique, pour suivre les apparitions.
    let stack = stackPanels([], open(['creator', 'spawn']));
    stack = stackPanels(stack, open(['creator', 'spawn'], ['chronicle', 'open']));
    expect(top(stack)).toBe('chronicle');
    // Un fait de la chronique ouvre la fiche de son groupe, par-dessus.
    stack = stackPanels(
      stack,
      open(['creator', 'spawn'], ['sheet', 'group:3'], ['chronicle', 'open']),
    );
    expect(top(stack)).toBe('sheet');
    // La fiche fermée, la chronique revient, puis l'outil.
    stack = stackPanels(stack, open(['creator', 'spawn'], ['chronicle', 'open']));
    expect(top(stack)).toBe('chronicle');
    stack = stackPanels(stack, open(['creator', 'spawn']));
    expect(top(stack)).toBe('creator');
  });

  it('remonte un panneau qui change de cible, et pas un panneau qui se rafraîchit', () => {
    let stack = stackPanels([], open(['sheet', 'person:1']));
    stack = stackPanels(stack, open(['sheet', 'person:1'], ['cell', '10,20']));
    expect(top(stack)).toBe('cell');
    // La fiche et la case se rafraîchissent : rien ne bouge.
    stack = stackPanels(stack, open(['sheet', 'person:1'], ['cell', '10,20']));
    expect(top(stack)).toBe('cell');
    // Un lien suivi dans la fiche, restée dessous : elle repasse au-dessus.
    stack = stackPanels(stack, open(['sheet', 'person:2'], ['cell', '10,20']));
    expect(top(stack)).toBe('sheet');
    // Une autre case touchée : elle repasse au-dessus.
    stack = stackPanels(stack, open(['sheet', 'person:2'], ['cell', '11,20']));
    expect(top(stack)).toBe('cell');
    expect(stack.map((panel) => panel.id)).toEqual(['sheet', 'cell']);
  });

  it('laisse toujours la légende sous les autres panneaux', () => {
    let stack = stackPanels([], open(['chronicle', 'open']));
    stack = stackPanels(stack, open(['chronicle', 'open'], ['legend', 'relief']));
    expect(top(stack)).toBe('chronicle');
    stack = stackPanels(stack, open(['legend', 'relief']));
    expect(top(stack)).toBe('legend');
    expect(stackPanels(stack, [])).toEqual([]);
  });
});
