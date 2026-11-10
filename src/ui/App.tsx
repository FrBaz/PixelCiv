/**
 * Racine de l'interface, superposée à la carte : une grille de trois rangées, la barre
 * du haut, la colonne de droite (inspection, légende), la barre du bas. Elle respecte les
 * zones de sécurité (style.css). L'écran de création recouvre la carte ; seuls les avis
 * restent visibles par-dessus, en haut, loin de ses boutons.
 */
import { CellInfo } from './CellInfo';
import { ChroniclePanel, ChronicleToggle } from './Chronicle';
import { CreateWorld } from './CreateWorld';
import { CreatorPanel, CreatorToggle } from './CreatorTools';
import { DebugPanel, DebugToggle } from './DebugPanel';
import { Legend, MapModes } from './MapModes';
import { Notice } from './Notice';
import { SaveMenu } from './SaveMenu';
import { SheetPanel, type SheetContent } from './Sheet';
import { creationOpen, type CreationSetup, type CreatorSetup, type UiActions } from './store';
import { TimeControls } from './TimeControls';

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
          <div class="hud-side">
            <CreatorPanel setup={creator} />
            <SheetPanel content={content} actions={actions} />
            <ChroniclePanel actions={actions} />
            <CellInfo />
            <Legend />
          </div>
        </>
      )}
      {!creating && (
        <div class="hud-bar hud-bottom">
          <Notice />
          <MapModes actions={actions} />
          <div class="panel hud-tools">
            <CreatorToggle />
            <ChronicleToggle />
          </div>
          <SaveMenu actions={actions} />
        </div>
      )}
    </div>
  );
}
