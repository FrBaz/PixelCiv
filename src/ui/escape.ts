/**
 * Échap hors des panneaux (U-14). La carte ne prend pas le focus : après un appui ou un
 * glisser sur elle, le focus n'est plus dans aucun panneau, et Échap, que seuls les
 * panneaux écoutaient, ne fermait plus rien. Écouté sur la fenêtre (main.ts), il ferme le
 * panneau du dessus : l'outil d'apparition s'il est armé, sinon la fiche, sinon la case
 * inspectée. Comme par leurs boutons, le focus revient d'où l'outil ou la fiche s'étaient
 * ouverts (dialog.ts).
 *
 * L'outil, la fiche et l'écran de création, quand ils ont le focus, traitent Échap
 * eux-mêmes, et le marquent comme pris. Rien ne se ferme depuis un champ de saisie, ni sous
 * l'écran de création, dialogue modal qui recouvre la carte.
 */
import { closeTool } from './CreatorTools';
import { closeSheet } from './Sheet';
import { creationOpen, inspected, sheet, tool, type UiActions } from './store';

/** Touche pressée, que la fenêtre reçoit si aucun panneau ne l'a arrêtée. */
export function escapeKey(
  event: Pick<KeyboardEvent, 'key' | 'target' | 'defaultPrevented' | 'preventDefault'>,
  actions: Pick<UiActions, 'closeSheet'>,
): void {
  if (event.key !== 'Escape' || event.defaultPrevented || creationOpen.value) return;
  if (typeof HTMLInputElement !== 'undefined' && event.target instanceof HTMLInputElement) return;
  if (tool.value === 'spawn') closeTool();
  else if (sheet.value !== undefined) closeSheet(actions);
  else if (inspected.value !== undefined) inspected.value = undefined;
  else return;
  event.preventDefault();
}
