/**
 * Racine de l'interface, superposée à la carte. Les barres du haut et du bas
 * accueillent les panneaux ; elles respectent les zones de sécurité (style.css).
 */
import type { UiActions } from './store';
import { TimeControls } from './TimeControls';

export function App({ actions }: { actions: UiActions }) {
  return (
    <div class="hud">
      <div class="hud-bar hud-top">
        <TimeControls actions={actions} />
      </div>
      <div class="hud-bar hud-bottom" />
    </div>
  );
}
