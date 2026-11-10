/**
 * Racine de l'interface, superposée à la carte : une grille de trois rangées, la barre
 * du haut, la colonne de droite (inspection, légende), la barre du bas. Elle respecte les
 * zones de sécurité (style.css). L'écran de création recouvre la carte ; seuls les avis
 * restent visibles par-dessus, en haut, loin de ses boutons.
 */
import { CellInfo } from './CellInfo';
import { CreateWorld } from './CreateWorld';
import { DebugPanel, DebugToggle } from './DebugPanel';
import { Legend, MapModes } from './MapModes';
import { Notice } from './Notice';
import { SaveMenu } from './SaveMenu';
import { creationOpen, type CreationSetup, type UiActions } from './store';
import { TimeControls } from './TimeControls';

export function App({ actions, setup }: { actions: UiActions; setup: CreationSetup }) {
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
            <CellInfo />
            <Legend />
          </div>
        </>
      )}
      {!creating && (
        <div class="hud-bar hud-bottom">
          <Notice />
          <MapModes actions={actions} />
          <SaveMenu actions={actions} />
        </div>
      )}
    </div>
  );
}
