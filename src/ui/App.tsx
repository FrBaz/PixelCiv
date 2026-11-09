/**
 * Racine de l'interface, superposée à la carte. Les barres du haut et du bas
 * accueillent les panneaux ; elles respectent les zones de sécurité (style.css).
 * L'écran de création recouvre la carte ; seuls les avis restent visibles par-dessus.
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
        <CreateWorld actions={actions} setup={setup} />
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
      <div class="hud-bar hud-bottom">
        <Notice />
        {!creating && <MapModes actions={actions} />}
        {!creating && <SaveMenu actions={actions} />}
      </div>
    </div>
  );
}
