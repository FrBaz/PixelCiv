/**
 * Racine de l'interface, superposée à la carte : une grille de trois rangées, la barre
 * du haut, la colonne de droite (outil, fiche, chronique, inspection, légende), la barre
 * du bas. Elle respecte les zones de sécurité (style.css). L'écran de création recouvre la
 * carte ; seuls les avis restent visibles par-dessus, en haut, loin de ses boutons.
 *
 * Sur petit écran, la colonne ne montre que le dernier panneau ouvert (panels.ts), au
 * téléphone en paysage sur toute la hauteur, à droite, et en portrait au bas de la carte,
 * sur toute la largeur ; la barre du bas tient sur une ligne, qui défile (U-3, U-4).
 */
import { computed } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { useRef } from 'preact/hooks';
import { CellInfo } from './CellInfo';
import { ChroniclePanel, ChronicleToggle } from './Chronicle';
import { CreateWorld } from './CreateWorld';
import { CreatorPanel, CreatorToggle } from './CreatorTools';
import { DebugPanel, DebugToggle } from './DebugPanel';
import { Legend, MapModes } from './MapModes';
import { Notice } from './Notice';
import { stackPanels, type OpenPanel, type SidePanel } from './panels';
import { SaveMenu } from './SaveMenu';
import { SheetPanel, sheetKey, type SheetContent } from './Sheet';
import {
  chronicleOpen,
  creationOpen,
  inspected,
  legendEntries,
  mapMode,
  raised,
  sheet,
  tool,
  type CreationSetup,
  type CreatorSetup,
  type UiActions,
} from './store';
import { TimeControls } from './TimeControls';

/**
 * Ce que montre chaque panneau de la colonne, ou undefined s'il est fermé : des chaînes,
 * qui ne changent que lorsqu'un panneau s'ouvre, se ferme ou change de cible, et non à
 * chaque rafraîchissement de la fiche ou de la case inspectée.
 */
const panelKeys: Readonly<Record<SidePanel, { readonly value: string | undefined }>> = {
  creator: computed(() => (tool.value === 'spawn' ? 'spawn' : undefined)),
  sheet: computed(() => {
    const open = sheet.value;
    return open === undefined ? undefined : sheetKey(open);
  }),
  chronicle: computed(() => (chronicleOpen.value ? 'open' : undefined)),
  cell: computed(() => {
    const cell = inspected.value;
    return cell === undefined ? undefined : `${String(cell.x)},${String(cell.y)}`;
  }),
  legend: computed(() =>
    mapMode.value !== 'natural' && legendEntries.value.length > 0 ? mapMode.value : undefined,
  ),
};

const PANELS: readonly SidePanel[] = ['creator', 'sheet', 'chronicle', 'cell', 'legend'];

function SideColumn({
  actions,
  creator,
  content,
}: {
  actions: UiActions;
  creator: CreatorSetup;
  content: SheetContent;
}) {
  const stack = useRef<readonly OpenPanel[]>([]);
  const open: OpenPanel[] = [];
  for (const id of PANELS) {
    const key = panelKeys[id].value;
    // Une demande du joueur compte comme un autre contenu : le panneau remonte.
    if (key !== undefined) open.push({ id, key: `${key}#${String(raised.value[id] ?? 0)}` });
  }
  stack.current = stackPanels(stack.current, open);
  const top = stack.current.at(-1)?.id;
  const panels: Readonly<Record<SidePanel, ComponentChildren>> = {
    creator: <CreatorPanel setup={creator} />,
    sheet: <SheetPanel content={content} actions={actions} />,
    chronicle: <ChroniclePanel actions={actions} />,
    cell: <CellInfo />,
    legend: <Legend />,
  };
  return (
    <div class="hud-side">
      {PANELS.map((id) => (
        // Sur petit écran, seul le panneau du dessus se montre (style.css, side-under).
        <div key={id} class={id === top ? 'side-slot' : 'side-slot side-under'}>
          {panels[id]}
        </div>
      ))}
    </div>
  );
}

export function App({
  actions,
  setup,
  creator,
  content,
}: {
  actions: UiActions;
  setup: CreationSetup;
  creator: CreatorSetup;
  content: SheetContent;
}) {
  const creating = creationOpen.value;
  return (
    <div class="hud">
      {creating ? (
        <>
          <CreateWorld actions={actions} setup={setup} />
          <div class="hud-bar hud-top">
            <Notice />
          </div>
        </>
      ) : (
        <>
          <div class="hud-bar hud-top">
            <TimeControls actions={actions} />
            <DebugToggle />
            <DebugPanel />
          </div>
          <SideColumn actions={actions} creator={creator} content={content} />
          <div class="hud-bar hud-bottom">
            <Notice />
            {/* Les outils d'abord : au téléphone, la ligne qui défile commence par eux. */}
            <div class="hud-actions">
              <div class="panel hud-tools">
                <CreatorToggle />
                <ChronicleToggle />
              </div>
              <MapModes actions={actions} />
              <SaveMenu actions={actions} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
