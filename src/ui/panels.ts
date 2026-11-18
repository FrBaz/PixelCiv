/**
 * Panneaux de la colonne de droite (U-3, U-4). Sur petit écran, téléphone en portrait ou
 * en paysage, un seul s'y montre : le dernier ouvert, ou celui qui vient de changer de
 * cible. Les autres restent ouverts dessous, et reparaissent quand on ferme ceux qui les
 * couvrent. La légende, qui accompagne la carte, passe toujours sous les autres. Sur un
 * grand écran, tous se montrent, l'un sous l'autre.
 */

export type SidePanel = 'creator' | 'sheet' | 'chronicle' | 'cell' | 'legend';

/** Un panneau ouvert, et ce qu'il montre : une autre cible le fait repasser au-dessus. */
export interface OpenPanel {
  readonly id: SidePanel;
  readonly key: string;
}

/**
 * Pile des panneaux ouverts, du dessous au-dessus, d'après la pile précédente et les
 * panneaux ouverts à présent : ceux qui montrent toujours la même chose gardent leur
 * rang ; ceux qui s'ouvrent ou changent de cible passent au-dessus, dans l'ordre de `open`.
 */
export function stackPanels(
  previous: readonly OpenPanel[],
  open: readonly OpenPanel[],
): OpenPanel[] {
  const same = (a: OpenPanel, b: OpenPanel) => a.id === b.id && a.key === b.key;
  const kept = previous.filter((panel) => open.some((other) => same(panel, other)));
  const fresh = open.filter((panel) => !kept.some((other) => same(panel, other)));
  const stack = [...kept, ...fresh];
  return [
    ...stack.filter((panel) => panel.id === 'legend'),
    ...stack.filter((panel) => panel.id !== 'legend'),
  ];
}
