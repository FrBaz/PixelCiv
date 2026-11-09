/**
 * Racine de l'interface, superposée à la carte. Les barres du haut et du bas
 * accueillent les panneaux ; elles respectent les zones de sécurité (style.css).
 */
import { CellInfo } from './CellInfo';
import { DebugPanel, DebugToggle } from './DebugPanel';
import { Legend, MapModes } from './MapModes';
import { Notice } from './Notice';
import { SaveMenu } from './SaveMenu';
import type { UiActions } from './store';
import { TimeControls } from './TimeControls';

export function App({ actions }: { actions: UiActions }) {
  return (
    <div class="hud">
      <div class="hud-bar hud-top">
        <TimeControls actions={actions} />
        <DebugToggle />
        <DebugPanel />
      </div>
      <div class="hud-side">
        <CellInfo />
        <Legend />
      </div>
      <div class="hud-bar hud-bottom">
        <Notice />
        <MapModes actions={actions} />
        <SaveMenu actions={actions} />
      </div>
    </div>
  );
}
